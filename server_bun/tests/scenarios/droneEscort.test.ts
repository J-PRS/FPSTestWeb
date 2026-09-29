import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: escort drone plinks a hostile', () => {
  it('drone follows owner, acquires enemy, fires through the funnel', () => {
    const room = mkRoom({ mode: 'tdm', bots: 2 });
    const w = watch(room);
    const [a, b] = [...room.players.getAllPlayers().values()];
    // TDM assigns teams on join; an alpha+bravo pair is guaranteed hostile.
    pin(room, a.id, { x: 40, y: 31, z: 0 });
    pin(room, b.id, { x: 50, y: 31, z: 0 });
    room.deployables.handleDeploy(a.id, 'drone', { x: 40, y: 31, z: 1 });
    const hp0 = b.health;
    for (let i = 0; i < 300; i++) step(room, 1);
    // fire interval 1.6s at 20Hz → ~18 shots in 15 sim-seconds; 9dmg each.
    expect(w.count('turretShot')).toBeGreaterThan(0);
    expect(b.health).toBeLessThan(hp0);
  });
});
