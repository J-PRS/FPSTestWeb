import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch, firstPlayer } from './harness.ts';

describe('scenario: gem pickup banks', () => {
  it('a player standing on a gem banks it for their team', () => {
    const room = mkRoom({
      mode: 'nuggets', bots: 1,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'nuggets');
    const w = watch(room);
    const bot = firstPlayer(room);
    // Ground level on the flat field sits at hmHeight ~31 — the dy gate is
    // ±6m so the spawn just needs to be near the bot's real feet.
    const pos = { x: 5, y: bot.position.y, z: 5 };
    room.pickups!.spawn(pos, 'gem');
    pin(room, bot.id, pos);
    step(room, 5);
    expect(room.pickups!.snapshot().length).toBe(0);
    const gone = w.msgs.find((m) => m.type === 'pickupGone') as { by: string } | undefined;
    expect(gone?.by).toBe(bot.id);
    expect(w.count('teamScore')).toBeGreaterThan(0);
  });
});
