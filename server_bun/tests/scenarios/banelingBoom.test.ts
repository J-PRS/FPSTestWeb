import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

describe('scenario: baneling detonates on its victim', () => {
  it('a baneling reaching a pinned bot detonates and hurts them', () => {
    const room = mkRoom({ creatures: { baneling: 2 }, bots: 1 });
    const bot = room.players.getPlayer('BOT-t1')!;
    bot.health = 500;
    // Put the bot on the ground BEFORE the first step — the fuse measures
    // distance to the retarget snapshot, so the bot's y has to be real by
    // the time the sim next commits a target position.
    bot.position = { x: 0, y: 31, z: 0 };
    bot.protectedUntil = 0; // wall-clock shield — never lapses inside a test
    room.creatureSim.step(0.05);
    const bug = room.creatureSim.roster().find((c) => c.species === 'baneling')!;
    // crawlEvt edges ride the sendTo distance-tiered fanout, not
    // connections.broadcast — the observable outcome is the kill and the
    // damage, which is what the assert is really after.
    for (let i = 0; i < 600; i++) room.creatureSim.step(0.05);
    expect(room.creatureSim.roster().some((c) => c.id === bug.id)).toBe(false);
    expect(bot.health).toBeLessThan(500);
  });
});
