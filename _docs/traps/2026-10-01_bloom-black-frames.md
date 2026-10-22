# Traps hit chasing the "black frame" / black-region bug (bloom pipeline)

Symptom: with GLOW on, parts of the world render pure black — first seen as
one-frame flashes, later reproduced as a **persistent black region tied to
view direction** (stand still facing the spot → stays black, look away →
gone). HUD (DOM) and the viewmodel (separate pass) always survive. The
region's edge is hard/geometric — curved or slanted, not a soft smear.

Every one of the dead ends below produced a plausible fix that did nothing.
The lesson: isolate *which pass produces* the black before theorizing.

## The actual mechanism (best current model)

postprocessing's `BloomEffect` with `mipmapBlur` runs its own internal
chain: luminance filter → mip downsample → Kawase upsample → merge. The
merge shader is literally one line:

    outputColor = texture2D(map, uv) * intensity;   // SCREEN-blended over the frame

If ANY texel in that internal bloom texture is NaN, `screen(NaN)` = NaN =
pure black — and because the deep mips are tiny, **one bad texel upsamples
into a huge screen-space diamond/blob**. Direction-dependent + persistent
happens when the NaN is produced (or cached) in a mip level tied to what's
on screen.

Fix that finally worked: subclass `BloomEffect` and swap the merge shader
via `setFragmentShader` (protected — must subclass, can't call on the
instance) to fold non-finite samples to 0 *before* the blend. Worst case a
region loses its halo instead of going black. See `BLOOM_MERGE_GLSL` in
`client/src/core/rendererShaders.ts` and `SafeBloomEffect` in
`renderer.ts`.

## Dead ends that each looked right

### "HDR Inf texel → NaN in luminance" — true but insufficient

Additive stacks (EMIT_GAIN × trails/explosions, sun disc) overflow fp16 at
65504 → Inf → `Inf − Inf`/`0 × Inf` inside blur taps → NaN → full-frame
black. PlayCanvas shipped this exact bug (issue #7658, fixed by sanitizing
the downsample). We added `HdrSanitize` EffectPasses before AND after
bloom (`SANITIZE_GLSL` — NaN fails every IEEE comparison, so
`c >= 0.0 ? min(c, 64.0) : 0.0` is a portable isnan).

**Still flashed.** The input being clean doesn't seal the *internal*
bloom texture — the guard had to move into the merge shader itself.

### "GLOW off = fine ⇒ scene is clean" — misleading correlation

The EffectComposer runs even with bloom disabled (RenderPass still draws
through it), so a corrupted scene vertex would show in both modes. BUT the
inverse is also wrong: the flash correlating with glow does NOT prove a
vertex NaN — it proves the *bloom merge output* is bad. Toggling GLOW
while staring at a persistent black spot is the fastest bisect:
flips with the toggle → bloom chain; stays black → a real object
rendering black.

### "NaN vertex = screen-covering triangle" — plausible, unproven

NaN `gl_Position` is undefined behavior; some drivers rasterize the
triangle stretched to screen center instead of culling. A normal-blended
dark mesh (smoke puff quad, shadow, decal) can darken the frame —
additive geometry can't (additive black adds nothing). The screenshot's
hard curved edge fit a giant dark billboard.

Built a scanner for it (`client/src/core/nanScan.ts`, `?nanscan=1`):
every frame it walks `matrixWorld`, `instanceMatrix`, skinned
`boneMatrices`, camera matrices, and ALL attributes of geometries with
any `DynamicDrawUsage`/instanced buffer (the quarks `BatchedRenderer`
keeps particle data in instanced attrs and IS in the scene graph —
`s.add(batcher)`); every 8th frame it adds full position-buffer scans.
Also scans `|v| > 1e5` — a finite giant vertex draws the same triangle.

**No hits during a flash.** The bug wasn't CPU-side buffer corruption.

Scanner gotchas found the hard way:
- `skeleton.boneMatrices` is `Float32Array | null` — guard it.
- `geometry.attributes` values can be `InterleavedBufferAttribute` — no
  `.usage`/`.array`; check before scanning.
- A huge FINITE boundingSphere (1e6, 1e7) is legit — starfield and sky
  dome — flag only non-finite.

### Lens dirt — ruled out by `?dirt=off`

`?dirt=off` URL param disables only the LensDirt pass (dirt rides the
bloom toggle). Flashes persisted.

## Diagnostic tooling left in place

- `?nanscan=1` — the buffer/transform scanner above; reports first
  sighting per buffer as `[nanscan] BAD <attr> @<i>=<v> on <object>`
  (label includes vert count, material type, world position).
- `?nanscan=1` + **B key** — raycast probe through screen center; logs
  `[nanprobe]` with every mesh along the ray. For naming a persistent
  black-rendering object.
- `?dirt=off` — isolate the lens-dirt stage while keeping bloom on.

## GLSL NaN sources to suspect in scene shaders (for next time)

- `normalize(zeroVector)` — undefined; NaN on some drivers (Apple
  Silicon confirmed by Khronos WG), zero on others. Degenerate normals
  or a vertex exactly on the camera plane.
- `pow(negative, x)`, `sqrt(negative)`, `log(x ≤ 0)`, `acos(x outside
  [-1,1])` from float slop in `dot()` results.
- `x / 0.0` → Inf; `Inf − Inf`, `0 × Inf`, `smoothstep(e0, e0, x)`
  (division by `e1−e0` = 0) → NaN.
- `dFdx/dFdy` of uniform texcoords → 0/0 (three.js issue #17559 — black
  dots from a normal map on degenerate UVs).
- fp16 overflow at **65504** in HalfFloat buffers — additive HDR stacks
  reach it easily; sanitize to a ceiling well below it.
