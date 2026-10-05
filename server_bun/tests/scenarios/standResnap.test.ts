import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

// A home re-snap moves the injected 'stand' hulls server-side; clients
// hold only the last emitted structure list, so the re-push is the only
// way early joiners' colliders follow the mesh (the floating-wireframe
// desync). Silent no-op re-snaps must NOT spam mapUpdate either.
const H = (v: number): Heightfield => ({ size: 4, data: new Uint8Array(16).fill(v), stride: 1 });
const Y120 = (120 / 255) * 125;

describe('scenario: stand re-snap re-push', () => {
  it('broadcasts a skinny mapUpdate when the snapped stand moved', () => {
    const room = mkRoom({
      mode: 'ctf',
      bases: { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } },
    }, 'ctf', 7, false, H(60));
    const w = watch(room);
    room.field = H(120);
    room.refreshFlagHomes();
    const ups = w.msgs.filter((m) => m.type === 'mapUpdate');
    expect(ups.length).toBe(1);
    const st = (ups[0] as { structures?: { pos: { y: number } }[] }).structures!;
    // Stand hull pos.y is the piece BASE — every injected box must sit
    // on the re-snapped ground, not the boot height.
    expect(Math.min(...st.map((s) => s.pos.y))).toBeCloseTo(Y120, 1);
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
