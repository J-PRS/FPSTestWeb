import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: sentry turret fires', () => {
  it('a deployed turret acquires a pinned enemy and damages them', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const players = [...room.players.getAllPlayers().values()];
    const alpha = players.find((p) => p.team === 'alpha')!;
    const bravo = players.find((p) => p.team === 'bravo')!;
    pin(room, alpha.id, { x: 0, y: 31, z: 0 });
    pin(room, bravo.id, { x: 20, y: 31, z: 0 }); // inside TURRET_RANGE=42
    room.deployables.handleDeploy(alpha.id, 'turret', { x: 1, y: 31, z: 0 });
    // Deploys sim lives in room.sims; bots roam if unpinned so re-pin while
    // stepping to keep the geometry constant.
    for (let i = 0; i < 120; i++) {
      pin(room, alpha.id, { x: 0, y: 31, z: 0 });
      pin(room, bravo.id, { x: 20, y: 31, z: 0 });
      step(room, 1);
    }
    expect(w.count('turretShot')).toBeGreaterThan(0);
    expect(bravo.health).toBeLessThan(500);
  });
});
