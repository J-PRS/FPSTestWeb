# Trap: the bloom composite texture is RAW — every consumer needs the fold

Recurrence of `2026-10-01_bloom-black-frames.md` (~11 days later).

Symptom: black covering half the screen on some frames with GLOW on —
the same NaN smear, back after being "solved".

## What changed to reintroduce it

The lens-dirt pass was converted to Unity PPv2-style: `color += dirt ×
bloomTex × intensity`, sampling `bloomEffect.texture` — pmndrs'
isolated mip-chain composite (the `_BloomTex` equivalent).

That texture is **pre-sanitize, unclamped, raw**. The Inf/NaN texels
that `SafeBloomEffect`'s `BLOOM_MERGE_GLSL` folds to 0 *for display*
still live in it. The dirt pass runs AFTER `postBloomSanitize` — the
last guard in the chain — so `Inf × dirt` or `NaN × 0` re-poisoned the
frame downstream of every defense, and ACES smeared it black.

```
scene → sanitize → bloomMerge(folds sample, writes frame) → sanitize2
      → DIRT (raw sample — the hole) → aces → contrast → upscale
```

## The rule

`bloomEffect.texture` is not display-safe. **Any shader that samples
the bloom composite must apply the IEEE fold itself**:

```glsl
v.r = v.r >= 0.0 ? min(v.r, 64.0) : 0.0;  // NaN fails >= → 0; Inf clamps
```

NaN fails every IEEE comparison, so `>= 0.0` is the portable isnan —
no `isnan()`/`isinf()` (GLSL ES 3.00 only). Same convention as
`SANITIZE_GLSL`/`BLOOM_MERGE_GLSL` in `client/src/core/rendererShaders.ts`.

Guarded consumers now: the frame itself (sanitize passes), the merge
blend (`BLOOM_MERGE_GLSL`), lens dirt (`LENS_DIRT_GLSL`, inline fold on
BOTH `dirt` and `bloom` samples — the dirt map isn't above suspicion
either).

## Side lesson — fog is NOT why it bleeds

An intermediate attempt gated dirt on merged-frame luminance
(`lum − 1.15`): dropping it to ~0.55 for halo reach painted the dirt
map across the sky — the fog band sits at ~0.9–1.1 luminance, so ANY
sub-1.0 scene-luminance threshold lights fog. That's why the
bloom-buffer modulation is the right approach, not a threshold tweak:
the buffer only holds light that cleared the 1.3 gate, fog never
enters it, and there's no gate to balance at all.

## Related: Unity's actual formula (PPv2 Uber.shader)

    half3 dirt = dirtTex.rgb * bloomTex.rgb * dirtIntensity;
    color += bloomTex*intensity + dirt;
    // plus aspect-correct "cover" UV remap on the dirt texture
    // (_Bloom_DirtTileOffset) — skipped here, our map is square
