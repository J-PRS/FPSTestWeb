import { describe, it, expect } from 'bun:test';
import { CreatureSim } from '../src/CreatureSim.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { makeSimCrawler, MELEE_SPECIES } from '../../shared/creatureSim.ts';
import type { SimCrawler } from '../../shared/creatureSim.ts';
import type { ServerMessage } from '../src/types.ts';

// Private surface the tests poke at — the harness for edge-fanout
// behavior needs to drive one crawler, not a whole room tick.
type SimPrivate = {
  crawlers: Map<number, SimCrawler>;
  edge(c: SimCrawler, kind: 'retarget' | 'windup' | 'pounce' | 'bite'): void;
};

function makeRoom(): { sim: CreatureSim; sent: { pid: string; kind?: string }[]; bcast: ServerMessage[] } {
  const sent: { pid: string; kind?: string }[] = [];
  const bcast: ServerMessage[] = [];
  const pm = new PlayerManager();
  const sim = new CreatureSim(pm, (m) => { bcast.push(m); },
    (pid, m) => { sent.push({ pid, kind: (m as { kind?: string }).kind }); });
  return { sim, sent, bcast };
}

function addPlayerAt(sim: CreatureSim, id: string, x: number, z: number): void {
  const pm = (sim as unknown as { players: PlayerManager }).players;
  const p = pm.addPlayer(id);
  p.position.x = x; p.position.y = 0; p.position.z = z;
  p.isDead = false;
}

describe('MELEE_SPECIES table', () => {
  it('resolves per-species stats — scarab is faster, weaker, cheaper bite', () => {
    const cr = makeSimCrawler(1, 0, 0, 0, false, 42, 'crawler');
    const sc = makeSimCrawler(2, 0, 0, 0, false, 42, 'scarab');
    expect(cr.species).toBe('crawler');
    expect(sc.species).toBe('scarab');
    expect(sc.sp.HOP_SPEED).toBeGreaterThan(cr.sp.HOP_SPEED);
    expect(sc.health).toBeLessThan(cr.health);
    expect(sc.biteDamage).toBeLessThan(cr.biteDamage);
    expect(sc.sp.AGGRO_D2).toBeLessThan(cr.sp.AGGRO_D2);
  });

  it('unknown species falls back to crawler tunables', () => {
    const w = makeSimCrawler(3, 0, 0, 0, false, 7, 'bogstandard');
    expect(w.sp.HOP_SPEED).toBeCloseTo(makeSimCrawler(4, 0, 0, 0, false, 7, 'crawler').sp.HOP_SPEED);
  });
});

describe('distance-tiered edge fanout', () => {
  const priv = (s: CreatureSim) => s as unknown as SimPrivate;

  function crawlerAt(x: number, z: number): SimCrawler {
    const c = makeSimCrawler(9, x, 0, z, false, 11, 'crawler');
    return c;
  }

  it('near players get every retarget; far players only the resync beat', () => {
    const { sim, sent, bcast } = makeRoom();
    addPlayerAt(sim, 'near', 10, 0);   // ~10m from crawler
    addPlayerAt(sim, 'far', 300, 0);   // ~300m — beyond NEAR_D2
    const c = crawlerAt(0, 0);
    priv(sim).crawlers.set(c.id, c);

    for (let i = 0; i < 4; i++) priv(sim).edge(c, 'retarget');

    const nearGot = sent.filter(s => s.pid === 'near').length;
    const farGot = sent.filter(s => s.pid === 'far').length;
    expect(nearGot).toBe(3);   // 3 of 4 (the 4th went broadcast)
    expect(farGot).toBe(0);    // nothing direct — rides the broadcast beat
    expect(bcast.length).toBe(1); // every-4th edge is the shared resync
  });

  it('attack edges still reach near players (combat visuals survive tiering)', () => {
    const { sim, sent } = makeRoom();
    addPlayerAt(sim, 'near', 5, 0);
    const c = crawlerAt(0, 0);
    priv(sim).crawlers.set(c.id, c);
    priv(sim).edge(c, 'windup');
    priv(sim).edge(c, 'pounce');
    expect(sent.filter(s => s.kind === 'windup').length).toBe(1);
    expect(sent.filter(s => s.kind === 'pounce').length).toBe(1);
  });
});

describe('crawlerHit claim gates', () => {
  it('drops claims on unknown ids and out-of-range claimers', () => {
    const { sim } = makeRoom();
    const pm = (sim as unknown as { players: PlayerManager }).players;
    const c = makeSimCrawler(5, 0, 0, 0, false, 3, 'crawler');
    (sim as unknown as SimPrivate).crawlers.set(c.id, c);
    (sim as unknown as { field: object }).field = { size: 1, data: new Uint8Array(1), stride: 1 };

    addPlayerAt(sim, 'shooter', 1, 0);
    sim.handleHit('shooter', 999, 50);      // unknown id — no crash, no damage
    expect(c.health).toBe(c.maxHealth);

    const far = pm.addPlayer('faraway');
    far.position.x = 5000; far.position.z = 5000; far.isDead = false;
    sim.handleHit('faraway', c.id, 50);      // >600m gate — dropped
    expect(c.health).toBe(c.maxHealth);
  });

  it('legal claim applies damage + stun', () => {
    const { sim } = makeRoom();
    const c = makeSimCrawler(6, 0, 0, 0, false, 3, 'scarab');
    (sim as unknown as SimPrivate).crawlers.set(c.id, c);
    (sim as unknown as { field: object }).field = { size: 1, data: new Uint8Array(1), stride: 1 };
    addPlayerAt(sim, 'shooter', 1, 0);
    sim.handleHit('shooter', c.id, 10);
    expect(c.health).toBe(c.maxHealth - 10);
    expect(c.stunTimer).toBeGreaterThan(0);
  });
});
