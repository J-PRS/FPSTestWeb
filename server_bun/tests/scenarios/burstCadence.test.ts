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
    // 10 sim-seconds: new cadence expects ~18, old cadence ~9 — assert well
    // above the old rate so a regression to timid bursts trips it.
    expect(shots).toBeGreaterThanOrEqual(12);
  });
});
