import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, firstPlayer } from './harness.ts';

describe('scenario: escort drone bound to its owner', () => {
  it('the drone retires the moment its owner dies', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const w = watch(room);
    const owner = firstPlayer(room);
    freeze(room, owner.id, { x: 0, y: 31, z: 0 });
    room.deployables.handleDeploy(owner.id, 'drone', { x: 0, y: 31, z: 0 });
    expect(w.count('deploySpawn')).toBe(1);
    step(room, 10);
    expect(room.deployables.snapshot().length).toBe(1);
    owner.isDead = true;
    step(room, 5);
    expect(room.deployables.snapshot().length).toBe(0);
    expect(w.count('deployGone')).toBe(1);
  });
});
