import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

// Flag homes snap to the walkable surface, not the authored spec y — and
// RE-snap when the real per-map terrain lands after construction (the
// async attachTerrain path used to leave them stuck on the boot field).
const H = (v: number): Heightfield => ({ size: 4, data: new Uint8Array(16).fill(v), stride: 1 });
// u8 → meters: (v/255)*125 — 60 ≈ 29.4, 120 ≈ 58.8
const Y60 = (60 / 255) * 125, Y120 = (120 / 255) * 125;

const BASES = { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 200, z: 0 } };

describe('scenario: flag stand snapping', () => {
  it('bases authored under/over terrain land on the surface at ctor', () => {
    const room = mkRoom({ mode: 'ctf', bases: BASES }, 'ctf');
    for (const team of ['alpha', 'bravo'] as const) {
      const f = room.flags!.flags.get(team)!;
      expect(f.home.y).toBeCloseTo(Y60, 1);
      expect(f.pos.y).toBeCloseTo(Y60, 1);
    }
  });

  it('late terrain attach re-snaps homes and moves flags sitting home', () => {
    const room = mkRoom({ mode: 'ctf', bases: BASES }, 'ctf', 1337, false, H(60));
    expect(room.flags!.flags.get('alpha')!.home.y).toBeCloseTo(Y60, 1);
    // attachTerrain path: swap the live field, then refresh.
    room.field = H(120);
    room.refreshFlagHomes();
    for (const team of ['alpha', 'bravo'] as const) {
      const f = room.flags!.flags.get(team)!;
      expect(f.home.y).toBeCloseTo(Y120, 1);
      expect(f.pos.y).toBeCloseTo(Y120, 1);
    }
  });

  it('carried/dropped flags keep their live pos — only the stand moves', () => {
    const room = mkRoom({ mode: 'ctf', bases: BASES }, 'ctf', 1337, false, H(60));
    const f = room.flags!.flags.get('alpha')!;
    f.state = 'dropped';
    f.pos = { x: 5, y: Y60, z: 5 };
    room.field = H(120);
    room.refreshFlagHomes();
    expect(f.home.y).toBeCloseTo(Y120, 1);
    expect(f.pos.y).toBeCloseTo(Y60, 1); // dropped flag stays where it fell
  });

  it('a structure deck outranks terrain as the stand surface', () => {
    const room = mkRoom({
      mode: 'ctf',
      bases: BASES,
      // Wide enough that the 60m de-shelf ring still reads deck — a pad
      // narrower than the ring is correctly walked OFF as unreachable.
      structures: [{ kind: 'box', pos: { x: -70, y: 20, z: 0 }, size: { x: 200, y: 40, z: 200 } }],
    }, 'ctf', 1337, false, H(0));
    // Deck top = 20 + 40/2 = 40, over terrain 0 — the flag stands on the roof.
    expect(room.flags!.flags.get('alpha')!.home.y).toBeCloseTo(40, 1);
    // Bravo base has no structure — de-shelf may slide it but it lands LOW.
    expect(room.flags!.flags.get('bravo')!.home.y).toBeCloseTo(0, 1);
  });
});
