import { describe, expect, it } from 'vitest';
import { injectHeightmapBytes, getHeightmapData, sampleHeight, sampleHeightLod, clearTerrainBumps } from '../world/heightmap.js';

// The C6 ground invariant: a coarse clipmap vertex (10/40/80m chords)
// samples a min-pool channel, so the drawn triangle can never sit above
// the collider anywhere in its cell - "rendered under terrain" becomes
// unexpressible rather than patched per entity kind.
const N = 64, WORLD = 1500, SCALE = 1; // texel ~= 23.4m - brutal chords

function texelField(byte: (x: number, z: number) => number): Uint8Array {
  const d = new Uint8Array(N * N);
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {d[z * N + x] = byte(x, z);}
  }
  return d;
}

const worldOf = (tx: number, tz: number): [number, number] =>
  [((tx + 0.5) / N) * WORLD, ((tz + 0.5) / N) * WORLD];

describe('LOD min-pool channels', (): void => {
  it('every packed channel is <= the exact field channel', (): void => {
    const undo = injectHeightmapBytes(texelField((x, z) => 120 + ((x * 31 + z * 17) % 60)), N, SCALE, WORLD);
    const hm = getHeightmapData()!;
    for (let i = 0; i < N * N; i += 1) {
      const r = hm.data[i * 4]!;
      expect(hm.data[i * 4 + 1]).toBeLessThanOrEqual(r);
      expect(hm.data[i * 4 + 2]).toBeLessThanOrEqual(r);
      expect(hm.data[i * 4 + 3]).toBeLessThanOrEqual(r);
    }
    undo();
  });

  it('a deep notch pulls the 80m-ring vertex down to it', (): void => {
    clearTerrainBumps();
    const d = texelField(() => 200);
    d[(10 * N + 10)] = 20; // one deep texel
    const undo = injectHeightmapBytes(d, N, SCALE, WORLD);
    const [wx, wz] = worldOf(14, 10); // ~94m away - inside the 80m window
    expect(sampleHeightLod(3, wx, wz)).toBeLessThan(15);
    expect(sampleHeight(wx, wz)).toBeGreaterThan(80); // field itself still high
    undo();
  });

  it('vertex <= collider everywhere in its cell (the class-kill bound)', (): void => {
    clearTerrainBumps();
    // Rolling relief so coarse chords cut real interior curvature.
    const undo = injectHeightmapBytes(
      texelField((x, z) => 128 + Math.round(90 * Math.sin(x * 0.7) * Math.cos(z * 0.55))), N, SCALE, WORLD);
    // Level 1 (10m verts) and level 2 (40m verts): for each vertex, the
    // drawn height must not exceed the collider at ANY 5m-lattice point
    // inside its +-spacing window.
    for (const [lod, spacing] of [[1, 10], [2, 40]] as const) {
      for (const [vx, vz] of [[200, 300], [620, 140], [1100, 900]] as const) {
        const drawn = sampleHeightLod(lod, vx, vz);
        let worst = Infinity;
        for (let dz = -spacing; dz <= spacing; dz += 5) {
          for (let dx = -spacing; dx <= spacing; dx += 5) {
            worst = Math.min(worst, sampleHeight(vx + dx, vz + dz));
          }
        }
        expect(drawn).toBeLessThanOrEqual(worst + 1e-6);
      }
    }
    undo();
  });
});
