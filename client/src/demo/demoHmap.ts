// Optional embedded heightmap (v5 HMAP trailer section) — a coarse u8
// grid sampled off the live Heightfield so a demo still replays a
// recognizably-shaped battlefield when the original map file is gone,
// and so playback can detect "map exists but doesn't match the action".
//
// Raw grid, no codec: at 96x96 u8 the payload is ~9.2KB — under the 10KB
// budget without a single line of compression code. Decode is free too:
// the grid IS a Heightfield { size, data, stride:1 } — hmHeight() samples
// it through the exact same path the live map uses.

import type { Heightfield } from '../../../shared/heightfield.js';
import { hmHeight } from '../../../shared/heightfield.js';
import { crc32 } from './demoWriter.js';
import type { DemoHeightmap } from './types.js';

// 96² is the sweet spot measured on the real map set: ~1-2m rms error on
// normal maps, ~4m on the most mountainous one — the "spirit of the
// shot", not survey data.
export const HMAP_GRID = 96;

/** Identity hash of the SOURCE field's full-res bytes — a playback-side
 *  match check never rebuilds the downsample, it compares fingerprints. */
export function hmapFingerprint(field: Heightfield): number {
  // Stride-1 .bin data hashes directly; RGBA client fields would carry 4x
  // the bytes with identical R content — hash every stride-th byte so
  // both representations fingerprint the same terrain.
  const d = field.data;
  const s = field.stride;
  const packed = new Uint8Array(field.size * field.size);
  for (let i = 0; i < packed.length; i += 1) {packed[i] = d[i * s]!;}
  return crc32(packed);
}

/** Bilinear-sample the field down to gridN² u8 samples (same units the
 *  Heightfield stores: 0-255 of the height range). */
export function hmapDownsample(field: Heightfield, gridN: number = HMAP_GRID): DemoHeightmap {
  const data = new Uint8Array(gridN * gridN);
  const ws = field.worldScale ?? 1500;
  for (let z = 0; z < gridN; z += 1) {
    for (let x = 0; x < gridN; x += 1) {
      // Sample at the CENTER of each output cell's world footprint —
      // hmHeight() already applies the texel-center convention, so the
      // coarse grid round-trips through the same sampler cleanly.
      const h = hmHeight(field, (x / gridN) * ws, (z / gridN) * ws);
      const gain = 125 * (field.heightScale ?? 1);
      data[z * gridN + x] = Math.max(0, Math.min(255, Math.round((h / gain) * 255)));
    }
  }
  return {
    gridN,
    heightScale: field.heightScale ?? 1,
    worldScale: ws,
    srcHash: hmapFingerprint(field),
    data,
  };
}

/** The embedded grid dressed as a Heightfield — playback feeds it
 *  straight into hmHeight()/FieldSurface like a normal map. */
export function hmapToField(hm: DemoHeightmap): Heightfield {
  return { size: hm.gridN, data: hm.data, stride: 1, heightScale: hm.heightScale, worldScale: hm.worldScale };
}

/** "Does this live field match the terrain the demo was recorded on?"
 *  Coarse check: fingerprint equality on the source bytes when both are
 *  full-res, else sampled-height agreement within a walkable tolerance. */
export function hmapMatches(hm: DemoHeightmap, field: Heightfield): boolean {
  if (hmapFingerprint(field) === hm.srcHash) {return true;}
  // Different byte stream — maybe same terrain from a different build.
  // Compare sampled heights at the grid points; 1.5m is under the
  // flag-touch window so genuine same-shape maps pass and wrong maps
  // (which disagree by 10m+ somewhere) fail.
  const other = hmapDownsample({ ...field, worldScale: hm.worldScale }, hm.gridN);
  let worst = 0;
  const gain = 125 * hm.heightScale;
  for (let i = 0; i < hm.data.length; i += 1) {
    const dy = Math.abs(hm.data[i]! - other.data[i]!) / 255 * gain;
    if (dy > worst) {worst = dy;}
    if (worst > 1.5) {return false;}
  }
  return true;
}
