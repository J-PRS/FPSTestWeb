import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

// Unordered transports (WT/RTC datagram lanes) can deliver a projectile's
// destroy before the aoeShot it pairs with. The spent tombstone must keep
// that reordered claim resolvable — deleting it was the "blast with no
// known projectile" storm in the Sep-28 logs.

function harness() {
  const players = new PlayerManager();
  const sentTo: { id: string; msg: ServerMessage }[] = [];
  const combat = new CombatHandler(
    players,
    () => {},
    (id, msg) => sentTo.push({ id, msg }),
  );
  return { players, combat, sentTo };
}

const rejections = (sentTo: { id: string; msg: ServerMessage }[], id: string) =>
  sentTo.filter((m) => m.id === id && m.msg.type === 'shotRejected');

describe('skill claims', () => {
  it('melee aoeShot needs no projectile — the swing validates on reach', () => {
    const { players, combat, sentTo } = harness();
    const p1 = players.addPlayer('p1');
    p1.position = { x: 0, y: 10, z: 0 };
    const target = players.addPlayer('p2');
    target.position = { x: 1, y: 10, z: -0.5 };
    target.protectedUntil = 0;

    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 10, z: -1 }, // swing point in front of p1
      weaponType: WeaponType.Melee,
      // no projectileId, no airtime — melee is a skill, not a shell
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
    expect(target.health).toBeLessThan(target.maxHealth);
  });
});

describe('hitscan AOE claims (lightning beam)', () => {
  // Speed-0 weapons track no server projectile — their blast claims
  // validate against eye→tip reach and wall occlusion instead.
  it('a beam tip within range applies splash damage', () => {
    const { players, combat, sentTo } = harness();
    const p1 = players.addPlayer('p1', undefined, 'none', 'light');
    p1.position = { x: 0, y: 10, z: 0 };
    const target = players.addPlayer('p2');
    target.position = { x: 0, y: 10, z: -10.5 }; // inside the 1.6m shaft of a tip at -10
    target.protectedUntil = 0;

    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 11, z: -10 },
      weaponType: WeaponType.Lightning,
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('a tip beyond the beam range rejects', () => {
    const { players, combat, sentTo } = harness();
    const p1 = players.addPlayer('p1', undefined, 'none', 'light');
    p1.position = { x: 0, y: 10, z: 0 };

    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 11, z: -80 },
      weaponType: WeaponType.Lightning,
    });

    expect(rejections(sentTo, 'p1').length).toBe(1);
  });

  it('the excluded victim still eats the tick — the beam has no paired shot claim', () => {
    const { players, combat, sentTo } = harness();
    const p1 = players.addPlayer('p1', undefined, 'none', 'light');
    p1.position = { x: 0, y: 10, z: 0 };
    const target = players.addPlayer('p2');
    target.position = { x: 0, y: 10, z: -10 };
    target.protectedUntil = 0;

    // Exactly what the client sends while welding a player: tip at the
    // victim, victim in excludeTargetId (projectile semantics: "already
    // took the direct hit"). Without a paired shot this used to pay
    // nothing but banked charge.
    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 10.8, z: -10 },
      weaponType: WeaponType.Lightning,
      excludeTargetId: 'p2',
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('held ticks on one victim ramp down like botAttack beams', () => {
    const { players, combat } = harness();
    const p1 = players.addPlayer('p1', undefined, 'none', 'light');
    p1.position = { x: 0, y: 10, z: 0 };
    const target = players.addPlayer('p2');
    target.position = { x: 0, y: 10, z: -10 };
    target.protectedUntil = 0;
    target.armor = 0; // health deltas read clean against lgTickDamage

    const claim = () => combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 10.8, z: -10 },
      weaponType: WeaponType.Lightning,
      excludeTargetId: 'p2',
    });
    const tick = () => { const before = target.health; claim(); return before - target.health; };
    const t1 = tick();
    for (let i = 0; i < 3; i++) tick(); // ticks 2-4 hold the same band
    const t5 = tick();
    expect(t1).toBeGreaterThan(0);
    expect(t5).toBeGreaterThan(0);
    expect(t5).toBeLessThan(t1); // hold-decay: same gun, less pay
  });

  it('a tip behind a wall rejects — beams cannot pierce structures', async () => {
    const { structureColliders } = await import('../../shared/ballSim.ts');
    const { players, combat, sentTo } = harness();
    const p1 = players.addPlayer('p1', undefined, 'none', 'light');
    p1.position = { x: 0, y: 10, z: 0 };
    combat.solids = structureColliders([
      { kind: 'wall', pos: { x: 0, y: 10, z: -5 }, size: { x: 20, y: 5, z: 1 } },
    ]);

    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 11, z: -10 },
      weaponType: WeaponType.Lightning,
    });

    expect(rejections(sentTo, 'p1').length).toBe(1);
  });
});

describe('shotFired relay', () => {
  const shotHarness = () => {
    const players = new PlayerManager();
    const broadcasts: { msg: ServerMessage; exclude?: string }[] = [];
    const combat = new CombatHandler(
      players,
      (msg, exclude) => { broadcasts.push({ msg, exclude }); },
      () => {},
    );
    return { players, combat, broadcasts };
  };

  it('relays a playerShot with server-stamped pos to everyone but the shooter', () => {
    const { players, combat, broadcasts } = shotHarness();
    const p = players.addPlayer('p1');
    p.position = { x: 5, y: 10, z: -3 };

    combat.handleShotFired('p1', { type: 'shotFired', weaponType: 3, dir: { x: 1, y: 0, z: 0 } });

    expect(broadcasts.length).toBe(1);
    const m = broadcasts[0]!.msg as Extract<ServerMessage, { type: 'playerShot' }>;
    expect(m.type).toBe('playerShot');
    expect(m.id).toBe('p1');
    expect(m.weaponType).toBe(3);
    expect(m.pos).toEqual({ x: 5, y: 11.6, z: -3 }); // eye offset over the stamped feet pos
    expect(m.dir).toEqual({ x: 1, y: 0, z: 0 });
    expect(broadcasts[0]!.exclude).toBe('p1');
  });

  it('the 50ms relay gate drops the burst — silent, no reject', () => {
    const { players, combat, broadcasts } = shotHarness();
    players.addPlayer('p1');
    combat.handleShotFired('p1', { type: 'shotFired', weaponType: 3 });
    combat.handleShotFired('p1', { type: 'shotFired', weaponType: 3 });
    combat.handleShotFired('p1', { type: 'shotFired', weaponType: 3 });
    expect(broadcasts.length).toBe(1);
  });

  it('dead shooters relay nothing', () => {
    const { players, combat, broadcasts } = shotHarness();
    const p = players.addPlayer('p1');
    p.isDead = true;
    combat.handleShotFired('p1', { type: 'shotFired', weaponType: 3 });
    expect(broadcasts.length).toBe(0);
  });
});

describe('spree announcements', () => {
  const killHarness = () => {
    const players = new PlayerManager();
    const broadcasts: { msg: ServerMessage; exclude?: string }[] = [];
    const combat = new CombatHandler(
      players,
      (msg, exclude) => { broadcasts.push({ msg, exclude }); },
      () => {},
    );
    const kill = (shooter: string, target: string) => {
      const t = players.getPlayer(target)!;
      t.health = 1;
      t.armor = 0;
      t.protectedUntil = 0;
      combat.botAttack(shooter, target, 0);
    };
    const kills = () => broadcasts
      .map((b) => b.msg)
      .filter((m): m is Extract<ServerMessage, { type: 'playerKill' }> => m.type === 'playerKill');
    const notices = () => broadcasts
      .map((b) => b.msg)
      .filter((m): m is Extract<ServerMessage, { type: 'matchNotice' }> => m.type === 'matchNotice')
      .map((m) => m.text);
    return { players, combat, kill, notices, kills };
  };

  it('first blood fires exactly once per match', () => {
    const { players, kill, notices } = killHarness();
    players.addPlayer('a');
    players.addPlayer('b');
    kill('a', 'b');
    expect(notices().some((t) => t.includes('first blood'))).toBe(true);
    players.getPlayer('b')!.isDead = false;
    kill('a', 'b');
    expect(notices().filter((t) => t.includes('first blood')).length).toBe(1);
  });

  it('three unanswered kills announce a killing spree', () => {
    const { players, kill, notices } = killHarness();
    players.addPlayer('a');
    players.addPlayer('b');
    for (let i = 0; i < 3; i++) {
      players.getPlayer('b')!.isDead = false;
      kill('a', 'b');
    }
    expect(notices().some((t) => t.includes('killing spree') && t.includes('a'))).toBe(true);
  });

  it('a streak-ending kill calls out both names', () => {
    const { players, kill, notices } = killHarness();
    players.addPlayer('a');
    players.addPlayer('b');
    for (let i = 0; i < 3; i++) {
      players.getPlayer('a')!.isDead = false;
      kill('b', 'a'); // b builds a 3-streak
    }
    players.getPlayer('b')!.isDead = false;
    players.getPlayer('a')!.isDead = false; // a died to b three times — revive before the revenge kill
    kill('a', 'b');
    expect(notices().some((t) => t.includes('a') && t.includes('b') && t.includes('ended'))).toBe(true);
    expect(players.getPlayer('b')!.streak).toBe(0);
  });

  it('playerKill carries the shooter streak for the kill feed', () => {
    const { players, kill, kills } = killHarness();
    players.addPlayer('a');
    players.addPlayer('b');
    for (let i = 0; i < 2; i++) {
      players.getPlayer('b')!.isDead = false;
      kill('a', 'b');
    }
    expect(kills().map((m) => m.streak)).toEqual([1, 2]);
  });
});

describe('bot fire legality', () => {
  it('a bot\'s first shot drops its own spawn shield, same as a human trigger pull', () => {
    const { players, combat } = harness();
    players.addPlayer('BOT-1');
    players.addPlayer('v1');
    const bot = players.getPlayer('BOT-1')!;
    expect(bot.protectedUntil).toBeGreaterThan(Date.now());
    combat.botAttack('BOT-1', 'v1', WeaponType.BoltLauncher);
    expect(bot.protectedUntil).toBe(0);
  });
});

describe('heal claims', () => {
  it('free-form heals are rate-gated — a spammed second claim inside the window is dropped', () => {
    const { players, combat } = harness();
    players.addPlayer('p1');
    const p = players.getPlayer('p1')!;
    p.health = 50;
    combat.handleHeal('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(75);
    combat.handleHeal('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(75); // in-window claim dropped
  });
});
