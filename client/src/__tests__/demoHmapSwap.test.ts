// v5 HMAP playback swap: the embedded grid must genuinely take over the
// terrain (getHeightfield + sampleHeight serve the clip's shape), the
// hmapMatches gate must only swap on missing/mismatched live maps, and
// restore must hand the exact previous field back — a leak would write
// the coarse grid into the NEXT recording's trailer.
import { describe, it, expect, afterEach } from 'vitest';
import {
  getHeightfield, sampleHeight, injectHeightmapBytes,
  snapshotHeightmap, restoreHeightmap, setHeightScale, setWorldScale,
} from '../world/heightmap.js';
import { hmapDownsample, hmapMatches } from '../demo/demoHmap.js';
import type { Heightfield } from '../../../shared/heightfield.js';
import type { DemoHeightmap } from '../demo/types.js';

// Deterministic terrain: each texel's height encodes its coordinate so a
// swapped-in field provably answers with ITS shape, not a leftover's.
const rampField = (size: number, gain: number): Heightfield => {
  const data = new Uint8Array(size * size);
  for (let i = 0; i < data.length; i += 1) {data[i] = (i * gain) % 256;}
  return { size, data, stride: 1, heightScale: 1, worldScale: 1500 };
};

const prior = snapshotHeightmap();
afterEach(() => {restoreHeightmap(prior); setHeightScale(1); setWorldScale(1500);});

describe('embedded heightmap playback swap', () => {
  it('inject serves the embedded grid through getHeightfield + sampleHeight', () => {
    const n = 4;
    // Texel (0,0)=0, (1,0)=128 → halfway point ~64/255*125*gain(=2)
    const data = new Uint8Array([0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    injectHeightmapBytes(data, n, /*heightScale*/2, /*worldScale*/1000);
    const f = getHeightfield()!;
    expect(f.size).toBe(n);
    expect(f.stride).toBe(4);
    expect(f.heightScale).toBe(2);
    expect(f.worldScale).toBe(1000);
    // sample between texel centers 0 and 1 on the first row
    const h = sampleHeight(0, 0); // u,v = -0.5 → clamps to texel 0
    expect(h).toBe(0);
    // u=0.5,v=0 → sits exactly between texel (0,0)=0 and (1,0)=128
    const hMid = sampleHeight(250, 125);
    expect(hMid).toBeCloseTo((128 / 255) * 125 * 2 * 0.5, 1);
  });

  it('restore hands the previous field back — no embedded leak', () => {
    const live = new Uint8Array(4).fill(200);
    injectHeightmapBytes(live, 2, 1, 1500);
    const before = getHeightfield()!;
    expect(before.data[0]).toBe(200);

    const emb = new Uint8Array(4).fill(50);
    const restore = injectHeightmapBytes(emb, 2, 1, 1500);
    expect(getHeightfield()!.data[0]).toBe(50);
    restore();
    const back = getHeightfield()!;
    expect(back.data[0]).toBe(200);
    expect(back.size).toBe(2);
  });

  it('restore to EMPTY leaves sampleHeight at the no-map answer', () => {
    const emb = new Uint8Array(4).fill(100);
    const restore = injectHeightmapBytes(emb, 2, 1, 1500);
    restore();
    expect(getHeightfield()).toBeNull();
    expect(sampleHeight(10, 10)).toBe(0);
  });

  it('match gate: same-terrain live field wins (no swap), different loses', () => {
    // Record a demo on field A
    const fieldA = rampField(64, 3);
    const emb: DemoHeightmap = hmapDownsample(fieldA, 32);

    // Live session loaded the SAME field — gate must say keep live.
    expect(hmapMatches(emb, fieldA)).toBe(true);

    // Live session loaded a DIFFERENT terrain — gate must demand the swap.
    const fieldB = rampField(64, 7);
    expect(hmapMatches(emb, fieldB)).toBe(false);

    // And the client-side representation (stride-4 RGBA) fingerprints the
    // same as the stride-1 source — injected fields still match.
    injectHeightmapBytes(fieldA.data, fieldA.size, 1, 1500);
    const liveRgba = getHeightfield()!;
    expect(hmapMatches(emb, liveRgba)).toBe(true);
  });
});
