import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: turret respects walls', () => {
  it('a wall between turret and enemy blocks fire', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
      // Solid slab between the turret (x=1) and the enemy (x=20).
      // pos.y is the box's BASE, not its center — base 25 + height 12
      // spans y 25..37 across the ~31.5 sightline.
      structures: [{ kind: 'wall', pos: { x: 10, y: 25, z: 0 }, size: { x: 1, y: 12, z: 12 } }],
    }, 'tdm');
    const w = watch(room);
    const players = [...room.players.getAllPlayers().values()];
    const alpha = players.find((p) => p.team === 'alpha')!;
    const bravo = players.find((p) => p.team === 'bravo')!;
    pin(room, alpha.id, { x: 0, y: 31, z: 0 });
    pin(room, bravo.id, { x: 20, y: 31, z: 0 });
    room.deployables.handleDeploy(alpha.id, 'turret', { x: 1, y: 31, z: 0 });
    for (let i = 0; i < 120; i++) {
      pin(room, alpha.id, { x: 0, y: 31, z: 0 });
      pin(room, bravo.id, { x: 20, y: 31, z: 0 });
      step(room, 1);
    }
    // LOS is the invariant — other live bots still fight through the scrum
    // (self-splash off their own deploys etc.) so health isn't asserted.
    expect(w.count('turretShot')).toBe(0);
  });
});
