import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, watch } from './harness.ts';

describe('scenario: proximity mine detonates', () => {
  it('an enemy inside trigger range sets off an armed mine', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const players = [...room.players.getAllPlayers().values()];
    const alpha = players.find((p) => p.team === 'alpha')!;
    const bravo = players.find((p) => p.team === 'bravo')!;
    pin(room, alpha.id, { x: 0, y: 31, z: 0 });
    pin(room, bravo.id, { x: 6, y: 31, z: 0 }); // inside trigger once armed
    room.deployables.handleDeploy(alpha.id, 'mine', { x: 5, y: 31, z: 0 });
    for (let i = 0; i < 60; i++) {
      pin(room, alpha.id, { x: 0, y: 31, z: 0 });
      pin(room, bravo.id, { x: 6, y: 31, z: 0 });
      step(room, 1);
    }
    expect(w.count('mineBoom')).toBe(1);
    expect(bravo.health).toBeLessThan(bravo.maxHealth);
    expect(room.deployables.snapshot().filter((d) => d.kind === 'mine').length).toBe(0);
  });
});
