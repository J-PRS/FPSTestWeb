import { describe, it, expect } from 'bun:test';
import { weaponStats } from '../../src/weaponStats.ts';

// Mode names (join/switchRoom word), 'w<weaponType>' sources, and
// death-cell coords are all client-shaped — without cardinality caps each
// minted unbounded map keys in memory and in the jsonl rollup.
describe('scenario: weaponStats cardinality caps', () => {
  it('mode keys cap at 64 across every per-mode table', () => {
    for (let i = 0; i < 80; i++) {
      weaponStats.recordDeath(`capmode_${i}`, { x: 0, z: 0 });
      weaponStats.recordTtk(`capmode_${i}`, 'w0', 100);
    }
    const snap = weaponStats.snapshot();
    expect(Object.keys(snap.byMode).length).toBeLessThanOrEqual(64);
    expect(Object.keys(snap.ttk).length).toBeLessThanOrEqual(64);
  });

  it('source keys fold into "other" past 64', () => {
    // 'capmode_0' was admitted by the first test — a fresh mode name past
    // the cap would be rejected by modeOk before the source fold matters.
    for (let i = 0; i < 80; i++) {
      weaponStats.recordTtk('capmode_0', `w${i}`, 100);
    }
    const ttk = weaponStats.snapshot().ttk['capmode_0']!;
    // 64 named sources + the shared 'other' fold bucket.
    expect(Object.keys(ttk).length).toBeLessThanOrEqual(65);
    expect(ttk['other']).toBeDefined();
    expect(ttk['other']!.n).toBeGreaterThan(0);
  });

  it('death cells fold into "far" past 512', () => {
    for (let i = 0; i < 520; i++) {
      weaponStats.recordDeath('capmode_1', { x: i * 1000, z: 0 });
    }
    const cells = weaponStats.snapshot().deaths['capmode_1']!;
    // 512 named cells + the shared 'far' fold bucket.
    expect(Object.keys(cells).length).toBeLessThanOrEqual(513);
    expect(cells['far']).toBeGreaterThan(0);
  });
});
