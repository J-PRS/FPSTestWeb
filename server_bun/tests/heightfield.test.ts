import { describe, expect, it } from 'bun:test';

import { hmHeight, hmNormal, hmFingerprint, HM_WORLD_SCALE, HM_HEIGHT_SCALE, HM_DIVISOR, type Heightfield } from '../../shared/heightfield.ts';

const field = (fill: (x: number, z: number) => number, size = 8, stride = 1): Heightfield => {
  const data = new Uint8Array(size * size * stride);
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++)
      data[(z * size + x) * stride] = fill(x, z);
  return { data, size, stride };
};

// World-coord of a field vertex: the sample unwraps u = wx/SCALE*N - 0.5,
// so vertex (x,z) sits at wx = (x + 0.5) * SCALE / N.
const vx = (i: number, N: number) => ((i + 0.5) / N) * HM_WORLD_SCALE;
const height = (v: number) => (v / HM_DIVISOR) * HM_HEIGHT_SCALE;

describe('hmHeight', () => {
  it('constant field is constant everywhere', () => {
    const f = field(() => 100);
    expect(hmHeight(f, 123, -456)).toBeCloseTo(height(100), 5);
  });

  it('samples vertex-exact at vertex centers', () => {
    const f = field((x, z) => x + z * 8);
    expect(hmHeight(f, vx(3, 8), vx(2, 8))).toBeCloseTo(height(3 + 2 * 8), 3);
  });

  it('bilinear midpoint between two vertices', () => {
    const f = field((x) => x * 10);
    const mid = hmHeight(f, (vx(0, 8) + vx(1, 8)) / 2, vx(0, 8));
    expect(mid).toBeCloseTo((height(0) + height(10)) / 2, 3);
  });

  it('wraps toroidally — ±one world period samples identically', () => {
    const f = field((x, z) => x * 10 + z);
    for (const [wx, wz] of [[vx(3, 8), vx(2, 8)], [vx(7, 8), vx(0, 8)], [40, -70]] as [number, number][]) {
      const h = hmHeight(f, wx, wz);
      expect(hmHeight(f, wx + HM_WORLD_SCALE, wz)).toBeCloseTo(h, 5);
      expect(hmHeight(f, wx, wz + HM_WORLD_SCALE)).toBeCloseTo(h, 5);
      expect(hmHeight(f, wx - HM_WORLD_SCALE, wz - 2 * HM_WORLD_SCALE)).toBeCloseTo(h, 5);
    }
  });
});

describe('hmNormal', () => {
  it('flat field points straight up', () => {
    const n = { x: 0, y: 0, z: 0 };
    hmNormal(field(() => 42), 100, 100, n);
    expect(n.y).toBeCloseTo(1, 5);
  });

  it('slope along +x tilts the normal toward -x', () => {
    // vertex value ramps with x — world height rises along +x.
    const n = { x: 0, y: 0, z: 0 };
    hmNormal(field((x) => x * 20), vx(4, 8), vx(4, 8), n);
    expect(n.x).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0);
    expect(Math.abs(Math.hypot(n.x, n.y, n.z) - 1)).toBeLessThan(1e-5);
  });
});

describe('hmFingerprint', () => {
  it('same field → same fingerprint; different data → different', () => {
    const a = field((x, z) => x + z);
    const b = field((x, z) => x + z);
    const c = field(() => 7);
    expect(hmFingerprint(a)).toBe(hmFingerprint(b));
    expect(hmFingerprint(a)).not.toBe(hmFingerprint(c));
  });

  it('includes size — same data at different resolution differs', () => {
    const small = field(() => 5, 8);
    const big = field(() => 5, 16);
    expect(hmFingerprint(small)).not.toBe(hmFingerprint(big));
    expect(hmFingerprint(small)).toMatch(/^8:/);
  });
});
