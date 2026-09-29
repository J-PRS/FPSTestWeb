import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, freeze, watch, twoPlayers } from './harness.ts';

describe('scenario: proximity mine', () => {
  it('arms after 1s; an enemy stepping inside 3.2m eats the blast and the mine is gone', () => {
    const room = mkRoom({
      mode: 'tdm', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'tdm');
    const w = watch(room);
    const [planter, enemy] = twoPlayers(room);
    planter.team = 'alpha'; enemy.team = 'bravo';
    freeze(room, planter.id, { x: 0, y: 31, z: 0 });
    freeze(room, enemy.id, { x: 30, y: 31, z: 0 });
    room.deployables.handleDeploy(planter.id, 'mine', { x: 5, y: 31, z: 0 });
    expect(w.count('deploySpawn')).toBe(1);
    // Enemy is 25m out — no boom during the arm window even if they drifted.
    freeze(room, enemy.id, { x: 5, y: 31, z: 0 });
    step(room, 15); // 0.75s — still arming
    expect(w.count('mineBoom')).toBe(0);
    const hp = enemy.health;
    step(room, 10); // past the 1s arm, target inside fuse
    expect(w.count('mineBoom')).toBe(1);
    expect(w.count('deployGone')).toBe(1);
    expect(enemy.health).toBeLessThan(hp);
    // And the spent mine can't double-dip.
    step(room, 20);
    expect(w.count('mineBoom')).toBe(1);
  });
});
