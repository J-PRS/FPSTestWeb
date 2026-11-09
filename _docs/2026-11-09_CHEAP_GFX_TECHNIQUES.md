# Cheap GFX Techniques — Aesthetic-per-Millisecond Survey

Date: 2026-11-09. Scope: post-chain + material + lighting tricks that buy
visual quality at near-zero GPU cost, prioritized for a low-fi-browser-FPS
renderer (WebGL2, integrated GPUs, 60fps floor). Existing pipeline:
`client/src/core/renderer.ts` + `rendererShaders.ts` (fused grade pass:
sanitize → dirt → ACES → contrast → vibrance; pixel-scale modes; retro
palette caps; xBR upscale).

## The cost ladder (from measured sources)

Full-screen single-sample ops are nearly free; the bill comes from
*extra passes* and *neighbor reads*:

- **~0–0.1ms**: color ops, gradients, vignettes, LUTs, hue shifts —
  per-pixel math, no neighbor reads, fuse into the grade pass for free.
- **0.1–0.5ms**: procedural noise/generators, single-sample warps.
- **0.5–2ms**: blurs, glow/bloom (downsampled), dither/halftone,
  Sobel outlines (3×3 taps ×2 buffers).
- **1–2ms+**: glass/refraction, multi-pass composites, SSAO-depth loops.
  Over ~2ms each is where low-end GPUs start missing 60.

Rule of thumb the sources converge on: **one fused pass with N effects
costs one pass; N passes cost N**. Our `EffectPass` already fuses
sanitize+dirt+aces+contrast+vibrance — that's the right shape; keep
adding cheap ops inside it, never new passes.

## High-value techniques (ranked by aesthetic-per-cost)

**1. Palette/tonemap grade — nearly free, already landed.**
ACES + contrast + vibrance in one fused pass. Vibrance (just added)
lifts mid-saturation without clipping — the single highest
"expensive-looking-per-cycle" op in the whole stack. Done.

**2. Vignette + edge grade — ~0 cost.**
Radial multiply in the same fused pass. We have `#dmg-vignette` in DOM
but a *subtle permanent* vignette in the shader grade is free and reads
as "lens" not "effect." Pair with slight corner desaturation —
concentrates the eye on the reticle.

**3. Retro quantization/dithering — ~0.3ms, already landed.**
`RETRO_GLSL` palette caps + Bayer/Atkinson dither in pixel modes.
Bayer dithering specifically is the trick that makes low-palette
grades look *intentional* instead of crushed — gradients break into
ordered patterns the eye reads as texture. Correct call keeping it.

**4. Rim light — one dot product per material.**
`pow(1 - NdotV, k)` added to lit output. On low-detail geometry it's
*functional*, not decoration — silhouettes separate from terrain.
Scale by camera distance so far objects don't over-glow. Cost: a few
ALU ops inside existing material shaders — free.

**5. Toon/ramp diffuse — swap a NdotL for a texture lookup.**
`floor(ndl*steps)/steps` banding, or better: NdotL as UV into a
1×N ramp texture — lets artists restyle lighting by editing a gradient,
not code. Source guidance: push shadow tint toward the *complement* of
the light color, not black — banding alone reads cheap; colored
banding reads art-directed. Cost: one tex fetch per pixel lit.

**6. Unlit + gradient albedo ("lazy unwrapping") — *saves* GPU.**
Skip lighting math entirely on props/UI-adjacent meshes; texture with
vertical gradient strips so form reads via albedo instead of shading.
Element Arena shipped a whole game this way — crisp at any distance,
tiny textures, no lighting cost. Best fit: pickups, deployables,
character accessories.

**7. Analytic occlusion fake — world-space, ~free for simple scenes.**
Instead of SSAO (depth taps × N samples — the expensive kind), pass a
handful of occluder shapes (corner lines, cylinder bases) to the
fragment shader and take `max()` contribution to dim ambient. Impaler
shipped this — artifact-free and effectively free vs SSAO's multi-tap
cost. Our base interiors/generator rooms are exactly the simple-
geometry case it works on.

**8. Scrolling-cell noise gloom — 0.3ms vs 7ms SSAO-style screen fx.**
Wavetale's damage gloom: grid of jittered circles + sinusoidal warp,
~100 ops replacing ~1000. Generalizes: any screen-space overlay
(damage, underwater murk, low-energy tint) should be built from one
warped cell grid, not layered noise octaves.

**9. Texture channel packing — saves bandwidth, not ALU.**
R/G/B/A as four grayscale maps in one fetch (mask/metal/rough/AO or
four dither layers). Mobile-GPU guidance is explicit: fewer texture
fetches > fancier math. Where we sample multiple maps per material,
pack them.

**10. Vertex-shader upmigration — free if it interpolates.**
Anything uniform across a triangle (light dir·N for flat shading,
world-pos gradients, height fog) computed per-vertex and interpolated
is ~1000× fewer evaluations than per-fragment. Height fog especially:
`mix(fogColor, c, smoothstep(h0, h1, worldY))` per vertex is
indistinguishable from per-pixel at our density.

## Techniques to avoid (cost traps)

- **SSAO/HBAO** — multi-tap depth reads; use technique #7 instead.
- **Real bloom at full res** — our BLOOM_MERGE is already downsampled;
  keep it that way. Full-res convolve is the classic budget-killer.
- **Nested filter chains** — every extra EffectPass is a buffer
  roundtrip; fuse or drop.
- **Heavy outlines** — Sobel on depth+normals is 2 buffers × 9 taps;
  fine for a stylized look but ~1ms. Rim light (#4) gets 80% of the
  silhouette benefit inside the material for free.
- **Per-fragment trig in loops** — precompute on CPU to uniforms;
  swizzle vector math (`vec2 texel = 1.0/res` over two floats).

## What we already do right

- Fused single-pass grade (the correct architecture).
- Pixel-scale + dither modes (legit identity + fill-rate savings).
- xBR upscale for low-res render → native (reads sharper than bilinear).
- Lens-dirt masked gradients (the "grit" channel — texture-cheap
  screen texture).
- Wake/bloom emitter gating — only emissive sources bloom, not
  threshold-on-luminance (that was the "washed out" bug Krunker-style
  bloom has).

## Recommended next wins (ordered)

1. ✅ **LANDED** — **Subtle permanent vignette** in the fused grade.
   `VIGNETTE_GLSL` in `rendererShaders.ts`, appended to `gradePass` in
   `renderer.ts` — 12% corner dim + 15% desat inside `smoothstep(0.42,
   0.82)`. Kept deliberately weaker than `#dmg-vignette`'s damage band
   so it reads as lens, never as a hit tell. One fused pass still.
2. ✅ **LANDED** — **Fresnel rim** on the shared atlas body material
   (`PlayerModel.ts makeAtlasMat` `onBeforeCompile`, inside
   `<emissivemap_fragment>`): `pow(1-NdotV, 3)` at 10% cool-neutral
   strength — silhouette separation on low-detail armor, hue left to
   the existing team rims (the `setRim` path is emissive team-tint +
   inverted-hull outline; this layer is view-dependent shape read).
3. ~~Ramp-toon~~ — **already shipped**: `balls.ts` runs
   `MeshToonMaterial` + gradientMap, and `gunlab/previews.ts` has a
   full ramp family (duotone/halftone variants via `ramp()` helpers).
   Covered — what remains is optional *expansion* to more materials,
   not a new technique.
4. ~~Height-fog~~ — **already shipped**: `terrainPresets.ts` runs
   `heightFogAmount` + a `heightFog` term in the terrain shader blocks
   (plus `scene.fog` for base distance). Covered.
5. **Channel-packed mask texture** wherever materials fetch >2 maps.

## Sources

- gmshaders.com/tips_and_tricks — ALU-vs-pass cost model, vectorization
- shaders.com/docs/guide/performance — per-effect ms table
- Aaron Geisler, "Faking Ambient Occlusion" — analytic occluder AO
- AgentLien, "Screen Gloom Optimization in Wavetale" — 7ms→0.3ms case
- Emil Persson, "Graphics Gems for Games" — ROP-bound analysis, low-res
  particle targets
- Ömer Faruk Kara, "Stylised lighting: beyond cel shading" — rim/ramp,
  shadow-complement coloring, RenderDoc-cost discipline
- erichu33 toon-rendering writeup — ramp texture technique
- Amist, "Element Arena art direction" — lazy-unwrap gradient albedo
- ARM mobile GPU best practices — unlit shading, texture packing
