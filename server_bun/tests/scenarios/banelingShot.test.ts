import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch, firstPlayer } from './harness.ts';
import { STATUS } from '../../../shared/status.ts';

describe('scenario: shot baneling pops anyway', () => {
  it('killing a baneling detonates it — the blast is the attack', () => {
    const room = mkRoom({ creatures: { baneling: 3 }, bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    bot.health = 500;
    // Let the drip-feed spawn the pack while the bot idles far off —
    // bots hunt creatures for real now, so an unpinned warm-up would
    // have it pop the pack before the staged kill lands.
    pin(room, bot.id, { x: -150, y: 31, z: -150 });
    step(room, 40);
    const bug = room.creatureSim.roster().find((c) => c.species === 'baneling')!;
    pin(room, bot.id, { x: bug.position.x, y: bug.position.y, z: bug.position.z });
    // A SHIELD-skilled bot routes the blast into its energy tank — the
    // assertion is about the corpse eating the pop, not shield math.
    bot.status &= ~STATUS.SHIELD;
    const hp0 = bot.health;
    room.creatureSim.handleHit(bot.id, bug.id, 500);
    // Bots hunt creatures for real now, so the warm-up may already have
    // popped packmates — the staged kill only has to add one more blast.
    expect(w.count('crawlDie')).toBeGreaterThanOrEqual(1);
    // The pop rides the AOE funnel — a corpse at point blank must feel it.
    expect(bot.health).toBeLessThan(hp0);
  });
});
