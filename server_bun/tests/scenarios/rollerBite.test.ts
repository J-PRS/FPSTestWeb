import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: roller hunts a player', () => {
  it('a roller spawned near a bot rolls in and lands a contact bite', () => {
    const room = mkRoom({ creatures: { roller: 3 }, bots: 1 });
    const w = watch(room);
    const bot = room.players.getPlayer('BOT-t1')!;
    bot.health = 500;
    room.creatureSim.step(0.05);
    const roller = room.creatureSim.roster()[0]!;
    bot.position = { x: roller.position.x + 8, y: roller.position.y, z: roller.position.z };
    for (let i = 0; i < 400; i++) room.creatureSim.step(0.05); // ~20s
    expect(w.count('crawlEvt', 'bite')).toBeGreaterThan(0);
    const bite = w.msgs.find((m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'bite')!;
    expect((bite as { targetId?: string }).targetId).toBe(bot.id);
  });
});
