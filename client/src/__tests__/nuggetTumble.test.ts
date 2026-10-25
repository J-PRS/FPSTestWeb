/* oxlint-disable typescript/no-explicit-any -- test stubs are deliberately loosely typed */
import { describe, expect, it } from 'vitest';
import { injectHeightmapBytes, sampleHeight, getHeightfield } from '../world/heightmap.js';
import { hmChord, hmHeight } from '../../../shared/heightfield.js';

/** The nugget tumble mirror's floor must equal the server's ground test.
 *  RoomPickups floors at max(hmHeight, hmChord); Nugget.serverTumble steps
 *  against terrain.getHeight → sampleHeight. Since hmHeight IS hmChord in
 *  shared/heightfield.ts, the whole contract reduces to: does the client's
 *  sampleHeight produce the same surface as shared hmChord on the same
 *  data? Any drift here is a rest-divergence class the snap can't hide. */
describe('tumble floor contract — client sampleHeight === shared hmChord', (): void => {
  it('identical surface on non-flat data', (): void => {
    const size = 8;
    const data = new Uint8Array(size * size);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {data[z * size + x] = (x * 7 + z * 13) % 40;}
    }
    const restore = injectHeightmapBytes(data, size, 1, 40);
    try {
      const f = getHeightfield()!;
      let worst = 0, wx = 0, wz = 0;
      for (let x = 0; x < 40; x += 0.5) {
        for (let z = 0; z < 40; z += 0.5) {
          const d = Math.abs(sampleHeight(x, z) - hmChord(f, x, z));
          if (d > worst) {worst = d; wx = x; wz = z;}
        }
      }
      expect(worst).toBeLessThan(1e-9); // at ${wx},${wz} — float noise only, surfaces identical
    } finally {
      restore();
    }
  });

  it('hmHeight is hmChord — the server max() is one surface', (): void => {
    const size = 8;
    const data = new Uint8Array(size * size);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {data[z * size + x] = (x * 7 + z * 13) % 40;}
    }
    const restore = injectHeightmapBytes(data, size, 1, 40);
    try {
      const f = getHeightfield()!;
      for (const [x, z] of [[3, 7], [12.5, 18.75], [0.25, 39.5]]) {
        expect(hmHeight(f, x, z)).toBe(hmChord(f, x, z));
      }
    } finally {
      restore();
    }
  });
});
