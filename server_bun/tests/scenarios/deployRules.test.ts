import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, watch, firstPlayer } from './harness.ts';

describe('scenario: deploy rules', () => {
  it('a third turret recycles the oldest — Tribes remote-arms, never a pile', () => {
    const room = mkRoom({ mode: 'dm', bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    pin(room, bot.id, { x: 40, y: 31, z: 0 });
    bot.beltCharges = 99; // cap-recycling test — fund the belt, don't test the economy here
    room.deployables.handleDeploy(bot.id, 'turret', { x: 40, y: 31, z: 2 });
    room.deployables.handleDeploy(bot.id, 'turret', { x: 40, y: 31, z: 4 });
    room.deployables.handleDeploy(bot.id, 'turret', { x: 40, y: 31, z: 6 });
    expect(w.count('deploySpawn')).toBe(3);
    expect(w.count('deployGone')).toBe(1);
    expect(room.deployables.snapshot().filter((d) => d.owner === bot.id && d.kind === 'turret').length).toBe(2);
  });

  it('planting 40m away from the planter is refused', () => {
    const room = mkRoom({ mode: 'dm', bots: 1 });
    const w = watch(room);
    const bot = firstPlayer(room);
    pin(room, bot.id, { x: 0, y: 31, z: 0 });
    room.deployables.handleDeploy(bot.id, 'turret', { x: 60, y: 31, z: 0 });
    expect(w.count('deploySpawn')).toBe(0);
  });
});
