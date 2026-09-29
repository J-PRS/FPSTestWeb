import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: snake hunts a player', () => {
  it('a snake coils, lunges, and lands a bite on a nearby bot', () => {
    const room = mkRoom({ creatures: { snake: 3 }, bots: 1 });
    const w = watch(room);
    const bot = room.players.getPlayer('BOT-t1')!;
    bot.health = 500;
    room.creatureSim.step(0.05);
    const snake = room.creatureSim.roster()[0]!;
    // Snakes lunge from coil range — park just inside it so the
    // coil→lunge→bite chain is under test, not the approach.
    bot.position = { x: snake.position.x + 7, y: snake.position.y, z: snake.position.z };
    for (let i = 0; i < 400; i++) room.creatureSim.step(0.05); // ~20s
    expect(w.count('crawlEvt', 'bite')).toBeGreaterThan(0);
    const bite = w.msgs.find((m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'bite')!;
    expect((bite as { targetId?: string }).targetId).toBe(bot.id);
  });
});
