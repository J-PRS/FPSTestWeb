import { describe, it, expect, afterEach } from 'vitest';
import { injectHeightmapBytes, getHeightmapData, getHeightfield, setTerrainBumps, clearTerrainBumps, restoreHeightmap, snapshotHeightmap } from '../world/heightmap';

// Sediment lips are visual-only: the DRAWN field mounds around structure
// footprints while the COLLISION field (and everything sim-side) reads the
// raw bytes untouched. These pin the split.

const N = 65;
const flat = new Uint8Array(N * N).fill(80);

function byteAt(data: Uint8ClampedArray, x: number, z: number): number {
  return data[(((z + N) % N) * N + ((x + N) % N)) * 4]!;
}

describe('terrain sediment lips', (): void => {
  const snap = snapshotHeightmap();
  afterEach((): void => {
    clearTerrainBumps();
    restoreHeightmap(snap);
  });

  it('bumps raise the visual field near the ring, not the sim field', (): void => {
    injectHeightmapBytes(flat, N, 1, 1500);
    // World (0,0) maps to texel 0 — the wrap corner. r=30m on a 1500m tile
    // ≈ 1.3 texels: the ring peak lands within ~3 texels of the origin.
    setTerrainBumps('t', [{ x: 0, z: 0, r: 60, h: 6 }]);
    const visual = getHeightmapData()!;
    expect(visual.size).toBe(N);
    let lifted = 0;
    for (let dz = -4; dz <= 4; dz += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        lifted = Math.max(lifted, byteAt(visual.data, dx, dz));
      }
    }
    expect(lifted).toBeGreaterThan(80);
    // The collision field wrapper still reads the RAW bytes.
    const field = getHeightfield()!;
    expect(field.data[(0 * N + 0) * 4]).toBe(80);
    expect(field.data[(3 * N + 2) * 4]).toBe(80);
  });

  it('empty source clears its own set without touching others', (): void => {
    injectHeightmapBytes(flat, N, 1, 1500);
    setTerrainBumps('a', [{ x: 0, z: 0, r: 60, h: 6 }]);
    setTerrainBumps('b', [{ x: 500, z: 500, r: 60, h: 6 }]);
    setTerrainBumps('a', null);
    const visual = getHeightmapData()!;
    let maxNear = 0;
    for (let dz = -4; dz <= 4; dz += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        maxNear = Math.max(maxNear, byteAt(visual.data, dx, dz));
      }
    }
    expect(maxNear).toBe(80);
    // …while 'b' at (500,500) → texel ~21 still lifts.
    let far = 0;
    const bx = Math.round((500 / 1500) * N);
    for (let dz = -4; dz <= 4; dz += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        far = Math.max(far, byteAt(visual.data, bx + dx, bx + dz));
      }
    }
    expect(far).toBeGreaterThan(80);
  });

  it('no bumps = visual returns the raw array (zero-copy fast path)', (): void => {
    injectHeightmapBytes(flat, N, 1, 1500);
    const visual = getHeightmapData()!;
    expect(visual.data).toBe(getHeightfield()!.data);
  });
});
