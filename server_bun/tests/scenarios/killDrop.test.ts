import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch, firstPlayer } from './harness.ts';

describe('scenario: creature kill pays out', () => {
  it('a team-room kill drops gems at the corpse on the ground', () => {
    const room = mkRoom({ creatures: { crawler: 2 }, mode: 'nuggets', bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    pin(room, bot.id, { x: 40, y: 31, z: 0 });
    step(room, 40);
    const crawler = room.creatureSim.roster()[0]!;
    room.creatureSim.handleHit(bot.id, crawler.id, 9999);
    const drops = w.msgs.filter((m) => m.type === 'pickupSpawn');
    expect(drops.length).toBeGreaterThan(0);
    // The drop must land at the corpse's ground height — a pickup 6m in
    // the air starves the economy (dy<=6 grab range).
    for (const d of drops) {
      const p = (d as { pos: { y: number } }).pos;
      expect(Math.abs(p.y - 31)).toBeLessThan(3);
    }
  });
});
