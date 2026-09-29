import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';

describe('scenario: creature wall-gate', () => {
  it('a walled-off bot is unreachable by melee species', () => {
    // A full pen around the bot — walls only block bites and motion, so any
    // damage means a clip-through, not a walk-around. 30m-tall so hops
    // can't clear it either.
    const room = mkRoom({
      creatures: { crawler: 4, scarab: 4 }, bots: 1,
      structures: [
        { kind: 'wall', pos: { x: 34, y: 25, z: 0 }, size: { x: 1, y: 30, z: 16 } },
        { kind: 'wall', pos: { x: 46, y: 25, z: 0 }, size: { x: 1, y: 30, z: 16 } },
        { kind: 'wall', pos: { x: 40, y: 25, z: -8 }, size: { x: 14, y: 30, z: 1 } },
        { kind: 'wall', pos: { x: 40, y: 25, z: 8 }, size: { x: 14, y: 30, z: 1 } },
      ],
    });
    const bot = [...room.players.getAllPlayers().values()][0];
    pin(room, bot.id, { x: 40, y: 31, z: 0 });
    const hp = bot.health;
    for (let i = 0; i < 600; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      step(room, 1);
    }
    expect(bot.health).toBe(hp);
  });
});
