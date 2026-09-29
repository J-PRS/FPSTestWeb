import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';

describe('scenario: spawn protection window', () => {
  it('a protected target eats zero damage; clearing the window lets it land', () => {
    const room = mkRoom({ mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } } }, 'tdm');
    const [shooter, target] = twoPlayers(room);
    shooter.team = 'alpha'; target.team = 'bravo';
    pin(room, shooter.id, { x: 0, y: 31, z: 0 });
    // pin() clears protection for other tests — re-arm it AFTER pinning;
    // that's exactly the state under test.
    pin(room, target.id, { x: 20, y: 31, z: 0 });
    target.protectedUntil = Date.now() + 60_000;
    const hp = target.health;
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: 31, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 80; i++) { pin(room, target.id, { x: 20, y: 31, z: 0 }); target.protectedUntil = Date.now() + 60_000; step(room, 1); }
    expect(target.health).toBe(hp);
    // Window lapses — the next hit lands.
    target.protectedUntil = 0;
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: 31, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 80 && target.health === hp; i++) { pin(room, target.id, { x: 20, y: 31, z: 0 }); step(room, 1); }
    expect(target.health).toBeLessThan(hp);
  });
});
