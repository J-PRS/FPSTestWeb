import { describe, it, expect } from 'bun:test';
import { WeaponType } from '../../../shared/weapons.ts';
import { mkRoom, step, pin, twoPlayers } from './harness.ts';

describe('scenario: friendly fire gate', () => {
  it("a teammate's bolt does no damage in a team room", () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const [shooter, target] = twoPlayers(room);
    // Force both onto alpha — team assignment would split them 1/1.
    shooter.team = 'alpha'; target.team = 'alpha';
    pin(room, shooter.id, { x: 0, y: 32, z: 0 });
    pin(room, target.id, { x: 20, y: 32, z: 0 });
    const hp = target.health;
    room.projectiles.spawn(shooter.id, WeaponType.PlasmaGun,
      { x: 0, y: 32, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 200; i++) {
      pin(room, target.id, { x: 20, y: 32, z: 0 });
      step(room, 1);
      if (!room.projectiles) break;
    }
    expect(target.health).toBe(hp);
  });
});
