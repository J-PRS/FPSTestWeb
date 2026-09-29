import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin } from './harness.ts';

describe('scenario: multi-species room', () => {
  it('a mixed roster spawns and sims together without errors', () => {
    const room = mkRoom({
      creatures: { crawler: 4, scarab: 3, snake: 2, roller: 2, totem: 1 },
      bots: 1,
    });
    const bot = [...room.players.getAllPlayers().values()][0];
    pin(room, bot.id, { x: 0, y: 31, z: 0 });
    for (let i = 0; i < 200; i++) {
      pin(room, bot.id, { x: 0, y: 31, z: 0 });
      step(room, 1);
    }
    const roster = room.creatureSim.roster();
    const species = new Set(roster.map((c) => c.species));
    for (const s of ['crawler', 'scarab', 'snake', 'roller', 'totem']) {
      expect(species.has(s)).toBe(true);
    }
    // A pinned target in a swarm this dense gets bitten — the swarm is
    // actually hunting, not orbiting dead code.
    expect(bot.health).toBeLessThan(bot.maxHealth);
  });
});
