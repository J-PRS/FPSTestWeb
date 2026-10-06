import { describe, it, expect } from 'bun:test';
import { weaponStats } from '../../src/weaponStats.ts';

// speedBin folded unbounded magnitudes into '150+' — a physics spike or
// anomalous velocity must not mint fresh per-mode keys forever.
describe('scenario: kill-speed bins stay bounded', () => {
  it('velocities past the legit envelope fold into one bucket', () => {
    const peek = weaponStats as unknown as {
      speeds: { [mode: string]: { shooter: Record<string, number> } };
    };
    const mode = 'speedbin-test';
    // A spread of absurd magnitudes — every one must land in '150+'.
    for (const s of [150, 400, 1e4, 1e9]) {
      weaponStats.recordKillSpeed(mode, { x: s, y: 0, z: 0 }, null);
    }
    const shooter = peek.speeds[mode]?.shooter ?? {};
    expect(Object.keys(shooter)).toEqual(['150+']);
    expect(shooter['150+']).toBe(4);
  });
});
