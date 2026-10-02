import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';

describe('scenario: gnat dives a player', () => {
  it('a gnat orbits, darts down, and lands a nip on a bot', () => {
    const room = mkRoom({ creatures: { gnat: 4 }, bots: 1 });
    const w = watch(room);
    const bot = room.players.getPlayer('BOT-VEKTOR-01')!;
    bot.health = 500;
    room.creatureSim.step(0.05);
    const gnatId = room.creatureSim.roster()[0]!.id;
    // Flyers dive from overhead orbit — keep the bot pinned under the
    // gnat's patrol anchor or the dart cycle can drift out of range and
    // the check flakes on sim-seed luck. Roster returns snapshots, so the
    // position is re-read every step.
    for (let i = 0; i < 1200; i++) {
      const gnat = room.creatureSim.roster().find(c => c.id === gnatId);
      if (!gnat) break;
      bot.position = { x: gnat.position.x + 2, y: gnat.position.y, z: gnat.position.z };
      room.creatureSim.step(0.05);
    }
    expect(w.count('crawlEvt', 'bite')).toBeGreaterThan(0);
    const bite = w.msgs.find((m) => m.type === 'crawlEvt' && (m as { kind?: string }).kind === 'bite')!;
    expect((bite as { targetId?: string }).targetId).toBe(bot.id);
  });
});
