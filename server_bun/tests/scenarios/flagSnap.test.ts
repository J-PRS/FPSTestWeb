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
    // Deck top = 20 + 40 = 60 (pos.y is the piece BASE), over terrain 0 —
    // the flag stands on the roof.
    expect(room.flags!.flags.get('alpha')!.home.y).toBeCloseTo(60, 1);
    // Bravo base has no structure — de-shelf may slide it but it lands LOW.
    expect(room.flags!.flags.get('bravo')!.home.y).toBeCloseTo(0, 1);
  });
});

describe('scenario: auto flag placement (no authored bases)', () => {
  it('ctf on a spawn-only spec seats both flags at the dominant axis quartiles', () => {
    const room = mkRoom({
      mode: 'ctf',
      spawns: [{ x: -110, y: 0, z: 0 }, { x: 110, y: 0, z: 0 }, { x: 0, y: 0, z: 40 }],
    }, 'ctf');
    const a = room.flags!.flags.get('alpha')!;
    const b = room.flags!.flags.get('bravo')!;
    // Dominant axis is x (span 220) — stands seat at ±0.25·span = ±55.
    expect(a.home.x).toBeCloseTo(-55, 0);
    expect(b.home.x).toBeCloseTo(55, 0);
    expect(Math.hypot(a.home.x - b.home.x, a.home.z - b.home.z)).toBeCloseTo(110, 0);
  });

  it('bare spec still yields two stands (arena/fallback pair)', () => {
    const room = mkRoom({ mode: 'ctf' }, 'ctf');
    expect(room.flags!.flags.has('alpha')).toBe(true);
    expect(room.flags!.flags.has('bravo')).toBe(true);
    const a = room.flags!.flags.get('alpha')!, b = room.flags!.flags.get('bravo')!;
    expect(Math.hypot(a.home.x - b.home.x, a.home.z - b.home.z)).toBeGreaterThan(50);
  });

  it('auto stands re-snap when the real terrain lands', () => {
    const room = mkRoom({
      mode: 'ctf',
      spawns: [{ x: -110, y: 0, z: 0 }, { x: 110, y: 0, z: 0 }],
    }, 'ctf', 1337, false, H(60));
    room.field = H(120);
    room.refreshFlagHomes();
    for (const team of ['alpha', 'bravo'] as const) {
      expect(room.flags!.flags.get(team)!.home.y).toBeCloseTo(Y120, 1);
    }
  });
});
