import { describe, it, expect } from 'bun:test';
import { handleEnvironmentDamage, handleHeal } from '../src/envClaims.ts';
import { wallNow } from '../src/wallClock.ts';

// envClaims is the self-report funnel — crawler pounces, lava, gem heals.
// The forged-attribution and credit gates are where a cheater turns a
// self-report into a killfeed forge or infinite regen. Pin the caps,
// the range check, and the heal cadence against a minimal host.

type P = {
  isDead: boolean; health: number; maxHealth: number; perk: string;
  healCredit: number; position: { x: number; y: number; z: number };
  forceSendUntil: number;
};

function host(over: { players?: Record<string, Partial<P>>; teams?: boolean; envRange?: number } = {}) {
  const players = new Map<string, P>();
  for (const [id, o] of Object.entries(over.players ?? {})) {
    players.set(id, {
      isDead: false, health: 50, maxHealth: 100, perk: '',
      healCredit: 0, position: { x: 0, y: 0, z: 0 }, forceSendUntil: 0, ...o,
    } as P);
  }
  const hits: { shooter: string; target: string; damage: number }[] = [];
  const beats: string[] = [];
  const h = {
    playerManager: {
      getPlayer: (id: string) => players.get(id),
      applyDamage: (id: string, dmg: number) => {
        const p = players.get(id)!;
        p.health = Math.max(0, p.health - dmg);
        return { killed: p.health === 0, newHealth: p.health, newArmor: 0 };
      },
    },
    deps: { teams: over.teams ?? false, envRange: over.envRange !== undefined ? () => over.envRange : undefined },
    lastHeal: new Map<string, number>(),
    lastEnvCredit: new Map<string, number>(),
    hb: (k: string) => { beats.push(k); },
    applyHit: (shooterId: string, targetId: string, damage: number) => { hits.push({ shooter: shooterId, target: targetId, damage }); },
    _players: players,
    _hits: hits,
    _beats: beats,
  };
  return h;
}

const envMsg = (amount: number, attacker?: string) =>
  ({ type: 'environmentDamage', amount, attacker }) as Parameters<typeof handleEnvironmentDamage>[2];
const healMsg = (amount: number) =>
  ({ type: 'heal', amount }) as Parameters<typeof handleHeal>[2];

describe('envClaims', () => {
  it('env damage self-report clamps to [1, 40] untagged', () => {
    const h = host({ players: { p: {} } });
    handleEnvironmentDamage(h as never, 'p', envMsg(500));
    expect(h._players.get('p')!.health).toBe(10); // 50 - 40 cap
    expect(h._hits[0]!.shooter).toBe('environment');
    const h2 = host({ players: { p: {} } });
    handleEnvironmentDamage(h2 as never, 'p', envMsg(0.2));
    expect(h2._players.get('p')!.health).toBe(49); // min 1, rounded
  });

  it('a nearby real-player attacker keeps attribution and the 80 cap', () => {
    const h = host({ players: { p: {}, foe: { position: { x: 10, y: 0, z: 0 } } } });
    handleEnvironmentDamage(h as never, 'p', envMsg(200, 'foe'));
    expect(h._players.get('p')!.health).toBe(-30 <= 0 ? 0 : 50 - 80); // 50 - 80 → 0 (killed)
    expect(h._hits[0]!.shooter).toBe('foe');
    expect(h._hits[0]!.damage).toBe(80);
  });

  it('a distant named attacker is a forge — attribution drops to environment and the cap halves', () => {
    const h = host({ players: { p: {}, sniper: { position: { x: 500, y: 0, z: 0 } } } });
    handleEnvironmentDamage(h as never, 'p', envMsg(200, 'sniper'));
    expect(h._hits[0]!.shooter).toBe('environment');
    expect(h._hits[0]!.damage).toBe(40); // untagged cap, not the 80 attacker lane
    expect(h._beats).toContain('envdmg.attackerFar');
  });

  it('bot:* tags skip the range gate — victim-side host sims have no server position', () => {
    const h = host({ players: { p: {} } });
    handleEnvironmentDamage(h as never, 'p', envMsg(70, 'bot:swarm'));
    expect(h._hits[0]!.shooter).toBe('bot:swarm');
    expect(h._hits[0]!.damage).toBe(70);
    expect(h._beats).not.toContain('envdmg.attackerFar');
  });

  it('non-finite amounts are gone — handler is the trust boundary, not decode', () => {
    const h = host({ players: { p: {} } });
    expect(handleEnvironmentDamage(h as never, 'p', envMsg(NaN))).toBe('gone');
    expect(handleHeal(h as never, 'p', healMsg(Infinity))).toBe('gone');
    expect(h._players.get('p')!.health).toBe(50);
    expect(h._hits).toHaveLength(0);
  });

  it('a dead or missing player claims are gone — no health writes', () => {
    const h = host({ players: { p: { isDead: true } } });
    expect(handleEnvironmentDamage(h as never, 'p', envMsg(10))).toBe('gone');
    expect(handleEnvironmentDamage(h as never, 'ghost', envMsg(10))).toBe('gone');
    expect(h._players.get('p')!.health).toBe(50);
  });

  it('heal self-report caps at 25 and sets a 1.5s cadence', () => {
    const h = host({ players: { p: { perk: 'scavenger' } } });
    expect(handleHeal(h as never, 'p', healMsg(100))).toBe(true);
    // scavenger healBoost 1.5 → 100*1.5 → capped 25; 50+25=75
    expect(h._players.get('p')!.health).toBe(75);
    expect(handleHeal(h as never, 'p', healMsg(100))).toBe('cooldown');
    expect(h._players.get('p')!.health).toBe(75); // refused heal lands nothing
  });

  it('a refused heal does NOT consume the cadence slot', () => {
    const h = host({ players: { p: {} }, teams: true }); // teams mode, zero credit → nocredit
    expect(handleHeal(h as never, 'p', healMsg(10))).toBe('nocredit');
    h._players.get('p')!.healCredit = 5;
    expect(handleHeal(h as never, 'p', healMsg(10))).toBe(true); // not stuck on cooldown
    expect(h._players.get('p')!.health).toBe(55);
    expect(h._players.get('p')!.healCredit).toBe(0);
  });

  it('team-mode heal draws down credit only', () => {
    const h = host({ players: { p: { healCredit: 10 } }, teams: true });
    handleHeal(h as never, 'p', healMsg(25));
    expect(h._players.get('p')!.health).toBe(60); // min(25, credit 10)
    expect(h._players.get('p')!.healCredit).toBe(0);
  });

  it('over-cap heal lands only up to maxHealth — healPool clamps', () => {
    const h = host({ players: { p: { health: 95 } } });
    handleHeal(h as never, 'p', healMsg(25));
    expect(h._players.get('p')!.health).toBe(100);
  });

  it('a prior cadence stamp gates future heals until it lapses', () => {
    const h = host({ players: { p: {} } });
    h.lastHeal.set('p', wallNow() + 60_000);
    expect(handleHeal(h as never, 'p', healMsg(10))).toBe('cooldown');
    h.lastHeal.set('p', wallNow() - 1);
    expect(handleHeal(h as never, 'p', healMsg(10))).toBe(true);
  });
});
