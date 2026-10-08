import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

// Stands are map-authored now — a bare flag home injects NO hulls, so
// a terrain re-snap moves nothing clients hold and correctly emits no
// mapUpdate. The re-push mechanism still matters for authored pieces
// that DO ride the diff (shield panes on a generator flip — covered by
// structSinks); this file pins the bare-base silence contract.
const H = (v: number): Heightfield => ({ size: 4, data: new Uint8Array(16).fill(v), stride: 1 });

describe('scenario: stand re-snap re-push', () => {
  it('bare-base re-snap emits no mapUpdate — nothing clients hold moved', () => {
    const room = mkRoom({
      mode: 'ctf',
      bases: { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } },
    }, 'ctf', 7, false, H(60));
    const w = watch(room);
    room.field = H(120);
    room.refreshFlagHomes();
    expect(w.count('mapUpdate')).toBe(0);
  });

  it('stays silent when the re-snap lands the same spot', () => {
    const room = mkRoom({
      mode: 'ctf',
      bases: { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } },
    }, 'ctf', 7, false, H(60));
    const w = watch(room);
    room.refreshFlagHomes();
    expect(w.count('mapUpdate')).toBe(0);
  });
});
