import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: fire cadence', () => {
  it('an engaged bot sustains fire instead of plinking once a second', () => {
    const room = mkRoom({ mode: 'tdm', bots: 2,
      bases: { alpha: { x: -100, y: 60, z: 0 }, bravo: { x: 100, y: 60, z: 0 } } }, 'tdm');
    const w = watch(room);
    const [a, b] = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    // 25m — inside BOT_FIRE_RANGE, far enough to keep them shooting.
    for (let i = 0; i < 20; i++) {
      pin(room, a!.id, { x: -12, y: 31, z: 0 });
      pin(room, b!.id, { x: 12, y: 31, z: 0 });
      step(room, 1);
    }
    w.msgs.length = 0; // count only the measured window
    for (let i = 0; i < 200; i++) {
      pin(room, a!.id, { x: -12, y: 31, z: 0 });
      pin(room, b!.id, { x: 12, y: 31, z: 0 });
      // Kills teleport the survivor off the staging — keep them in the duel.
      a!.health = 500; b!.health = 500;
      step(room, 1);
    }
    const shots = w.msgs.filter((m) => m.type === 'projectileCreated'
      && (m as { ownerId?: string }).ownerId === a!.id).length;
    // 10 sim-seconds: the arsenal rate-gates to the weapon's own interval
    // (Bolt 0.8s → ~12 max, Disc 1.0s → ~10, minus acquisition delay), so
    // sustained fire measures ~8-11. A regression to timid plinking lands
    // under half that — the floor stays well above "stopped fighting".
    expect(shots).toBeGreaterThanOrEqual(6);
  });
});
