import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: wildlife raze a deployable', () => {
  it('creatures target dep: ids and gnaw a turret down', () => {
    const room = mkRoom({ creatures: { crawler: 4 }, bots: 1 });
    const w = watch(room);
    const bot = [...room.players.getAllPlayers().values()][0];
    pin(room, bot.id, { x: 40, y: 31, z: 0 });
    room.deployables.handleDeploy(bot.id, 'turret', { x: 41, y: 31, z: 0 });
    expect(w.count('deploySpawn')).toBe(1);
    for (let i = 0; i < 1200; i++) {
      pin(room, bot.id, { x: 40, y: 31, z: 0 });
      step(room, 1);
    }
    // 60hp turret vs crawler bites — either it's gone or well chewed.
    expect(w.count('deployGone')).toBeGreaterThan(0);
  });
});
