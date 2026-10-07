// Pins the stats-table folding: mode names and source keys are
// client-chosen, so uncapped tables were attacker-shaped memory. Past
// the caps sources fold into 'other', cells into 'far', modes refuse.
import { describe, expect, it } from 'bun:test';
// Fresh instance per suite — the exported singleton is shared state:
// once the suite admits 64 modes, later ones are refused (by design),
// which would make this file's expectations order-dependent.
import { WeaponStats } from '../../src/weaponStats.ts';

const ws = new WeaponStats();

describe('weaponStats bounds', () => {
  it('folds overflow source keys into other', () => {
    const mode = 'bounds-src';
    for (let i = 0; i < 80; i++) ws.record(mode, `w${i}`, 5, false, false);
    const rows = ws.snapshot().byMode[mode]!;
    expect(Object.keys(rows).length).toBeLessThanOrEqual(65); // 64 sources + 'other'
    expect(rows['other']!.hits).toBeGreaterThan(0);
  });

  it('folds overflow death cells into far', () => {
    const mode = 'bounds-cell';
    for (let i = 0; i < 600; i++) ws.recordDeath(mode, { x: i * 1000, z: i * 1000 });
    const cells = ws.snapshot().deaths[mode]!;
    expect(Object.keys(cells).length).toBeLessThanOrEqual(513); // 512 cells + 'far'
    expect(cells['far']!).toBeGreaterThan(0);
  });

  it('refuses mode-name spam past 64', () => {
    for (let i = 0; i < 80; i++) ws.record(`bounds-m${i}`, 'w0', 5, false, false);
    const modes = Object.keys(ws.snapshot().byMode);
    expect(modes.length).toBeLessThanOrEqual(66); // 64 spam + earlier test modes
  });
});
