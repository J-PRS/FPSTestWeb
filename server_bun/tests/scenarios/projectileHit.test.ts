import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, freeze, watch } from './harness.ts';

describe('scenario: direct projectile', () => {
  it('a bolt fired at a pinned enemy lands and applies damage', () => {
    const room = mkRoom({ bots: 2 });
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target] = bots;
    // freeze, not pin: live FFA brains now see each other — an unfrozen
    // shooter fires its own weapon (and pops SHIELD) before the staged
    // bolt lands, so the playerHit the watch catches isn't the scripted
    // one. Quiet brains leave spawn→fly→hit as the only projectile path.
    freeze(room, target!.id, { x: 20, y: 32, z: 0 });
    freeze(room, shooter!.id, { x: 0, y: 32, z: 0 });
    const hp = target!.health;
    // Fire straight at the target — the sim owns flight and the capsule
    // sweep; this exercises the spawn → fly → hit → damage funnel without
    // waiting on brain targeting.
    const id = room.projectiles.spawn(shooter!.id, WeaponType.PlasmaGun,
      { x: 0, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(id).not.toBeNull();
    for (let i = 0; i < 200; i++) {
      pin(room, target!.id, { x: 20, y: 32, z: 0 });
      step(room, 1);
      if (w.count('playerHit') + w.count('playerKill') > 0) break;
    }
    expect(w.count('playerHit') + w.count('playerKill')).toBeGreaterThan(0);
    expect(target!.health).toBeLessThan(hp);
  });

  it('spawn protection eats the hit instead of the player', () => {
    const room = mkRoom({ bots: 2 });
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const [shooter, target] = bots;
    // Keep the wall-clock shield UP — a hit inside the window must not
    // touch health (spawn campers shouldn't get free frags).
    target!.protectedUntil = Date.now() + 60_000;
    pin(room, shooter!.id, { x: 0, y: 32, z: 0 });
    target!.position = { x: 20, y: 32, z: 0 };
    room.moveSim.resync(target!.id, { x: 20, y: 32, z: 0 }, 0);
    room.projectiles.spawn(shooter!.id, WeaponType.PlasmaGun,
      { x: 0, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 200; i++) {
      target!.position = { x: 20, y: 32, z: 0 };
      room.moveSim.resync(target!.id, { x: 20, y: 32, z: 0 }, 0);
      step(room, 1);
      if (w.count('projectileDestroyed') > 0) break;
    }
    expect(target!.health).toBe(target!.maxHealth);
  });
});
