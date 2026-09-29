import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, firstPlayer } from './harness.ts';

describe('scenario: deployable lifetimes', () => {
  it('a turret expires at its 180s TTL and broadcasts deployGone', () => {
    const room = mkRoom({ mode: 'nuggets', bots: 1 }, 'nuggets');
    const w = watch(room);
    const bot = firstPlayer(room);
    freeze(room, bot.id, { x: 0, y: 31, z: 0 });
    room.deployables.handleDeploy(bot.id, 'turret', { x: 10, y: 31, z: 0 });
    expect(w.count('deploySpawn')).toBe(1);
    step(room, 3580); // 179s — still standing
    expect(room.deployables.snapshot().length).toBe(1);
    step(room, 30); // past 180s
    expect(room.deployables.snapshot().length).toBe(0);
    expect(w.count('deployGone')).toBe(1);
  });
});
