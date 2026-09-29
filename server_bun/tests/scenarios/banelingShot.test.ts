import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: shot baneling pops anyway', () => {
  it('killing a baneling detonates it — the blast is the attack', () => {
    const room = mkRoom({ creatures: { baneling: 3 }, bots: 1 });
    const w = watch(room);
    const bot = [...room.players.getAllPlayers().values()][0];
    bot.health = 500;
    // Let the drip-feed spawn the pack, then park the victim on one.
    step(room, 40);
    const bug = room.creatureSim.roster().find((c) => c.species === 'baneling')!;
    pin(room, bot.id, { x: bug.position.x, y: bug.position.y, z: bug.position.z });
    const hp0 = bot.health;
    room.creatureSim.handleHit(bot.id, bug.id, 500);
    expect(w.count('crawlDie')).toBe(1);
    // The pop rides the AOE funnel — a corpse at point blank must feel it.
    expect(bot.health).toBeLessThan(hp0);
  });
});
