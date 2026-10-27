# Demo heightmap — greedy-delta upgrade

Status: design. Parent arc: demo visual parity (`democmp`).

## Problem

The v5 `HMAP` trailer embeds a 96×96 u8 heightmap so a clip replays its
own terrain when the live map fingerprint doesn't match. On a rocky map
(rimrock) the coarse grid flattens ridges and peaks into rolling dunes —
the democmp sxs frames read as *a different map*, and the whole-frame
shading wash is the dominant SSIM cost (median ~0.38 vs a correctly
replayed scene's ~0.60).

The replay also has no `terrainTex`/`sky` alongside the grid (carried
into `SECTION_ATMO` in the same change), so even with the right shape it
shaded flat. That part is already done; this doc covers the shape.

## Research summary

**Garland-Heckbert greedy insertion** (`mgarland.org/papers/scape.pdf`,
1995; heremaps/tin-terrain `docs/Terra.md`): start from the four corner
samples, repeatedly insert the raster point with the largest vertical
error into a Delaunay mesh until under bound. Best-in-class quality for
mixed terrain; extremes are preserved *exactly* because they are always
the max-error vertex. Cost for us: the heightfield leaves regular-grid
form — decode is TIN→raster (~200 lines) and `getHeight` sampling has to
walk triangles or resample back to a grid anyway.

**Wavelet/mip-chain residuals** (LASAN CESCG-2016; dspace.cuni.cz
DPTX_2014_1): mip down, quantize residuals against a per-level max-error
bound. ~37:1 on Earth data, progressive. Most machinery to implement;
overkill for a 96² grid.

**Adaptive quadtree grids** — subdivide cells where children exceed
bound. Bounded error, regular-ish structure, but more bookkeeping than
either above for the same quality.

## Chosen: coarse grid + sparse delta list

Keep the u8 grid as the *base*. Apply the greedy idea without the TIN:
select full-res samples where the coarse grid's bilinear reconstruction
exceeds a bound, and store them as an appended sparse delta list. Decode
is trivial — upsample, `h[idx] += delta` per entry.

- Peaks and saddles are preserved exactly (they are always the
  worst-error samples → always selected first).
- Smooth regions cost zero bytes — the list only grows where the
  terrain is actually rough.
- `getHeight` stays a plain grid lookup; zero runtime physics change.
- Rides inside the existing HMAP section as an appended field — old
  readers skip it via the declared length, old files just have no
  corrections.

## Encoding

Full-res source grid is `heightfield.field` (already u8-quantized at
`heightScale/256` step) downsampled to `gridN`.

For each source sample not on the coarse grid vertices:
`err = |true - bilinearUpsample(coarse)|`. Selection = greedy: take the
worst first, stop at either `errMax <= bound` or a count cap (cap is a
budget knob, default ~15% of samples; a harsher cap just reverts to
today's smoothness, never corrupts).

Entry: `u32 linearIndex + i8 quantizedDelta` (delta in source-step
units, clamp ±127 — a bigger gap means the bound was exceeded and the
remaining error is accepted, same as today's status quo).

HMAP section payload gains a trailing block:
`u32 nCorrections + nCorrections * (u32 idx + i8 delta)`.
Trailer sections self-declare length; readers `skip(len - consumed)`
already — backward and forward compatible by construction.

## Decode

`demoHmap.ts` `decodeDemoHeightmap()` gains an optional `corrections`
param; after `expandDemoHeightmap` upsampling, apply each delta.
~20 lines total.

## Acceptance

- Unit: encode a synthetic ridge map, assert max reconstruction error
  ≤ bound after corrections vs > bound before.
- `democmp`: median SSIM should recover toward 0.5+ on rimrock; the
  remaining gap is particles/audio, not terrain.
- Size sanity: log `nCorrections` on a real rimrock clip; if it
  approaches the cap the bound was too tight for the map.

## Skipped / risks

- TIN decode: better quality per byte only if the delta list balloons on
  very rocky maps — measure `nCorrections` before revisiting.
- Corrections assume the source grid's own quantization error; the
  heightfield is already u8-step quantized so the bound is in the same
  units — no extra work needed.
- Count cap is the honest failure mode: over cap = today's smoothness,
  never a corrupt field.
