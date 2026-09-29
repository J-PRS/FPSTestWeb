import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch } from './harness.ts';

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
    room.deployables.handleDeploy(alpha.id, 'mine', { x: 5, y: 31, z: 0 });
    for (let i = 0; i < 60; i++) {
      // Frozen bots: a still-thinking bot wanders out of the blast or
      // picks up a status channel (shield) mid-test — both silently eat
      // the assert. Pinned but thinking is the flake source.
      freeze(room, alpha.id, { x: 0, y: 31, z: 0 });
      freeze(room, bravo.id, { x: 6, y: 31, z: 0 }); // inside trigger once armed
      step(room, 1);
    }
    expect(w.count('mineBoom')).toBe(1);
    expect(bravo.health).toBeLessThan(bravo.maxHealth);
    expect(room.deployables.snapshot().filter((d) => d.kind === 'mine').length).toBe(0);
  });
});
