import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: turret unfold window', () => {
  it('a fresh turret holds fire until armed, then engages', () => {
    const room = mkRoom({ mode: 'tdm', bots: 2 });
    const w = watch(room);
    const [a, b] = [...room.players.getAllPlayers().values()];
    pin(room, a.id, { x: 40, y: 31, z: 0 });
    pin(room, b.id, { x: 50, y: 31, z: 0 });
    room.deployables.handleDeploy(a.id, 'turret', { x: 41, y: 31, z: 0 });
    // Arm delay is 0.45-0.85s = 9-17 ticks at 50ms — first 5 must be silent.
    for (let i = 0; i < 5; i++) step(room, 1);
    expect(w.count('turretShot')).toBe(0);
    for (let i = 0; i < 300; i++) {
      pin(room, b.id, { x: 50, y: 31, z: 0 });
      step(room, 1);
    }
    expect(w.count('turretShot')).toBeGreaterThan(0);
  });
});
