import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, firstPlayer } from './harness.ts';

describe('scenario: totem beam hits', () => {
  it('a totem charges and burns a pinned player in range', () => {
    const room = mkRoom({ creatures: { totem: 2 }, bots: 1 });
    const bot = firstPlayer(room);
    // Park inside RANGE (105) but outside MIN_RANGE blink distance (22) —
    // the totem should commit a beam and the sweep should reach health.
    pin(room, bot.id, { x: 50, y: 31, z: 0 });
    const hp = bot.health;
    for (let i = 0; i < 600; i++) {
      pin(room, bot.id, { x: 50, y: 31, z: 0 });
      step(room, 1);
      if (bot.health < hp) break;
    }
    expect(bot.health).toBeLessThan(hp);
  });
});
