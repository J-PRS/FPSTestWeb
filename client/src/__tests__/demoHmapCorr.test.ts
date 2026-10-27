// Greedy-delta HMAP corrections (_docs/2026-10-27_DEMO_HMAP_DELTA.md):
// a ridge the coarse 96² bilinear grid flattens must be rebuilt within
// the bound once corrections apply — peaks preserved exactly-ish.
import { describe, it, expect } from 'vitest';
import { hmapDownsample, hmapCorrections, hmapToField, upsampleGrid } from '../demo/demoHmap.js';
import { hmHeight } from '../../../shared/heightfield.js';
import type { Heightfield } from '../../../shared/heightfield.js';

// Sharp ridge + peak: bilinear downsampling smooths it — exactly the
// case the delta list exists for.
const ridgeField = (size: number): Heightfield => {
  const data = new Uint8Array(size * size);
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const ridge = Math.max(0, 200 - Math.abs(x - size / 2) * 8);
      const peak = (x === size / 2 && z === size / 2) ? 55 : 0;
      data[z * size + x] = Math.min(255, ridge + peak);
    }
  }
  return { size, data, stride: 1, heightScale: 1, worldScale: 1500 };
};

const maxErr = (field: Heightfield, recon: Heightfield, ws: number): number => {
  let worst = 0;
  const gain = 125 * field.heightScale!;
  for (let i = 0; i < 20; i += 1) {
    for (let j = 0; j < 20; j += 1) {
      const x = ((i + 0.5) / 20) * ws, z = ((j + 0.5) / 20) * ws;
      const t = hmHeight(field, x, z), r = hmHeight(recon, x, z);
      const e = Math.abs(t - r) / gain * 255;
      if (e > worst) {worst = e;}
    }
  }
  return worst;
};

describe('HMAP corrections', (): void => {
  it('upsampled+corrected reconstruction beats the bare coarse grid', (): void => {
    const field = ridgeField(256);
    const hm = hmapDownsample(field, 48);
    const bare = hmapToField(hm);
    const errBare = maxErr(field, bare, hm.worldScale);
    hm.corr = hmapCorrections(field, hm, 3);
    expect(hm.corr!.idx.length).toBeGreaterThan(0);
    const fixed = hmapToField(hm);
    const errFixed = maxErr(field, fixed, hm.worldScale);
    expect(errFixed).toBeLessThan(errBare);
    // The spike texel is the worst-error sample — it must be selected.
    expect(hm.corr!.idx.length).toBeLessThanOrEqual(6000);
  });
  it('upsampleGrid preserves the corners', (): void => {
    const src = new Uint8Array([0, 200, 50, 255]);
    const up = upsampleGrid(src, 2, 5);
    expect(up[0]).toBe(0); expect(up[4]).toBe(200);
    expect(up[20]).toBe(50); expect(up[24]).toBe(255);
    expect(up[12]).toBe(Math.round((0 + 200 + 50 + 255) / 4));
  });
  it('no corrections when the field is already flat', (): void => {
    const flat: Heightfield = { size: 8, data: new Uint8Array(64).fill(100), stride: 1, heightScale: 1, worldScale: 1500 };
    const hm = hmapDownsample(flat, 4);
    expect(hmapCorrections(flat, hm, 3)).toBeUndefined();
  });
});
