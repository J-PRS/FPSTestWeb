import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: creature hunts a player', () => {
  it('a crawler spawned near a bot approaches and lands a bite', () => {
    const room = mkRoom({ creatures: { crawler: 3 }, bots: 1 });
    const w = watch(room);
    const bot = room.players.getPlayer('BOT-t1')!;
    bot.health = 500; // survive long enough for several pounces
    // Creatures seed on the first tick near players — step once so the
    // roster isn't empty, then park the bot next to a real crawler. A
    // roaming bot would outrun the hop sim; the hunt chain is under test,
    // not the bot's evasion.
    room.creatureSim.step(0.05);
    const crawler = room.creatureSim.roster()[0]!;
    bot.position = { x: crawler.position.x + 6, y: crawler.position.y, z: crawler.position.z };
    for (let i = 0; i < 400; i++) room.creatureSim.step(0.05); // ~20s
    expect(w.count('crawlEvt', 'bite')).toBeGreaterThan(0);
    const bite = w.msgs.find((m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'bite')!;
    expect((bite as { targetId?: string }).targetId).toBe(bot.id);
  });
});
