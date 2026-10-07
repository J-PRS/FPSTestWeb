// Pins the stats-table folding: mode names and source keys are
// client-chosen, so uncapped tables were attacker-shaped memory. Past
// the caps sources fold into 'other', cells into 'far', modes refuse.
import { describe, expect, it } from 'bun:test';
import { weaponStats } from '../../src/weaponStats.ts';

describe('weaponStats bounds', () => {
  it('folds overflow source keys into other', () => {
    const mode = 'bounds-src';
    for (let i = 0; i < 80; i++) weaponStats.record(mode, `w${i}`, 5, false, false);
    const rows = weaponStats.snapshot().byMode[mode]!;
    expect(Object.keys(rows).length).toBeLessThanOrEqual(65); // 64 sources + 'other'
    expect(rows['other']!.hits).toBeGreaterThan(0);
  });

  it('folds overflow death cells into far', () => {
    const mode = 'bounds-cell';
    for (let i = 0; i < 600; i++) weaponStats.recordDeath(mode, { x: i * 1000, z: i * 1000 });
    const cells = weaponStats.snapshot().deaths[mode]!;
    expect(Object.keys(cells).length).toBeLessThanOrEqual(513); // 512 cells + 'far'
    expect(cells['far']!).toBeGreaterThan(0);
  });

  it('refuses mode-name spam past 64', () => {
    for (let i = 0; i < 80; i++) weaponStats.record(`bounds-m${i}`, 'w0', 5, false, false);
    const modes = Object.keys(weaponStats.snapshot().byMode);
    expect(modes.filter((m) => m.startsWith('bounds-m')).length).toBeLessThanOrEqual(64);
  });
});
