import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: gnat dives a player', () => {
  it('a gnat orbits, darts down, and lands a nip on a bot', () => {
    const room = mkRoom({ creatures: { gnat: 4 }, bots: 1 });
    const w = watch(room);
    const bot = room.players.getPlayer('BOT-t1')!;
    bot.health = 500;
    room.creatureSim.step(0.05);
    const gnat = room.creatureSim.roster()[0]!;
    // Flyers dive from overhead orbit — park under the gnat's patrol
    // anchor; the windup→dive→bite chain is under test.
    bot.position = { x: gnat.position.x + 5, y: gnat.position.y, z: gnat.position.z };
    for (let i = 0; i < 600; i++) room.creatureSim.step(0.05); // ~30s
    expect(w.count('crawlEvt', 'bite')).toBeGreaterThan(0);
    const bite = w.msgs.find((m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'bite')!;
    expect((bite as { targetId?: string }).targetId).toBe(bot.id);
  });
});
