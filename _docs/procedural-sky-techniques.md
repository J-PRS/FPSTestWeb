# Procedural Sky Techniques (2026-10-11)

Reference for stylized/minimal procedural skies — what the good ones are
made of, cheapest→richest, mapped against what we already have
(`world/atmosphericSky.ts`, `sunShafts.ts` — currently off behind
`?shafts=on` — `volumetricClouds.ts`, `directionalFog.ts`).

## The ladder of sky techniques

### 1. Banded gradient — the whole stylized look

A 2- or 3-stop vertical gradient (deep → horizon → top) driven by view
height `h`, with `smoothstep` transitions and per-stop offsets/curves.
This alone is 90% of the "clean stylish sky" read — GDQuest's stylized
sky, Harry Alisavakis' tutorial, and most Godot asset-store skies are a
gradient plus features bolted on. Curve exponent controls how fast the
horizon color dies upward (high curve = band hugs the horizon).

We have it: the two-stop haze mix (`fogColor → horizonColor →
atmosphere`) at `atmosphericSky.ts:140`. The lesson that matters: the
horizon stop must be the FOG color exactly, or terrain and sky never meet
color-for-color.

### 2. Sun disc + halo — `pow(dot(dir, sunDir), k)`

A sun disc is one pow() on the sun-direction dot product. Separable knobs:
disc size (high k ≈ 800-2000), halo size (mid k ≈ 8-64), each with its own
color/intensity. Ours is deliberately absent — "uniform sky brightness"
for competitive readability — but it's the cheapest possible upgrade if
the look ever wants one. Drift Engine's take: `sunAngularRadius` is a
visual parameter independent of light intensity — worth copying if added.

### 3. Sunset/sunrise band

A warm band keyed to sun *elevation* only (strongest at ±0°, gone by
mid-day) — `smoothstep` on `sunDir.y` scaled into a horizon-weighted warm
tint. One uniform, no textures. Day/night cycles get it free.

### 4. Toon/posterized clouds — the Ghibli read

FBM noise sampled on a plane (`dir.xz / dir.y` projection) or cube-mapped,
then `floor(density * steps)` posterization to flatten clouds into hard
cel bands. Hard edges + few steps = stylized; more steps = volumetric.
Coverage slider = one smoothstep threshold. Clouds that emit silver
lining near the sun: `smoothstep(sunDot)` boost on the cloud rim.

We have volumetricClouds (ray-marched, the expensive end) and cloudPuffs
(sprite puffs). A posterized flat layer would be ~30 lines in the sky
shader and cheaper than both — it's the *most* stylized option.

### 5. Stars — cell hash, already have it

Sparse `hash3(floor(dir*220))` pinpoints with a size smoothstep + twinkle.
Ours fades by height and suppresses near the sun — same pattern everyone
uses. Cheap add-ons people use: color variance per cell, shooting stars
(a time-scrolled streak cell), a rotated star cubemap at night.

### 6. Moon — shaded sphere on a direction

`pow(dot(dir, moonDir), bigK)` disc + phase = shifting a shadow terminator
across it (a second dot against a rotated light dir, or lerp of two
hemispheres). Nice-to-have; our night exists only via starIntensity.

### 7. Horizon haze / ground hemisphere

A "below-horizon" deep color + a ground bounce term so the underside
isn't black. Physical skies (Preetham/AtmospherePass models) do
ground-bounce scattering; stylized ones just lerp to a third color. Ours
handles it via the fog melt.

### 8. Sky↔fog agreement — the seam killer

The recurring theme in every reference and our own bug history: the sky's
horizon color and the scene fog must be THE SAME VALUE, synced per frame
(directionalFog → sky uniform). A spec's painted horizon tint owns the
band *above* the seam; never let it touch the seam line itself.

## What the references converge on

- **Parameter count is a trap**: the asset-store skies ship 38 sliders;
  the ones that look good hand you 3 colors + a curve. Less is the point.
- **Wind coherence**: cloud drift should share the same wind vector as
  grass/smoke/trails — "biggest moving thing agrees with the smallest."
- **Sky as lighting input**: IBL/ambient can read the same sky params so
  the world takes its color (we hand-sync ambient/hemi/dir light instead).
- **Performance**: static sky = drop TIME; clouds at half/quarter res;
  everything else is per-pixel math on one fullscreen dome — cheap.
- **Disc visibility is a design lever**: T2/T:A skies have visible suns;
  we chose uniform brightness for readable tracking. Sprite glare
  (sunShafts) was the middle ground and is now opt-in.

## Sources

- GDQuest godot-4-stylized-sky (github.com/gdquest-demos/godot-4-stylized-sky)
- Harry Alisavakis "My take on shaders: Sky shader" (halisavakis.com)
- Drift Engine sky docs (driftengine.dev/docs/rendering/sky-and-atmosphere)
- Taos Engine ch.10 Atmosphere (taosengine.com/book) — module-shared
  scattering model, dynamic sky bake to texture
- "Stylized Procedural Sky" Godot asset (posterized toon clouds,
  directional gradient, color grading set)
- de Carpentier, "Analytical Ballistic Trajectories" n/a — see
  atmosphere-scattering literature instead (Preetham et al. 1999)

## Grain & dither — the invisible texture layer

Banding fix and tactile grain are the same operation: add a small noise
term before quantization. The interesting taxonomy from the research:

### Dither = banding kill (invisible, do this)

- **Interleaved gradient noise (IGN)** — `fract(52.9829189 * fract(0.06711056*fragX + 0.00583715*fragY))`,
  one line, no texture. Rerun's WebGPU skybox uses exactly this
  (`rgb + (noise-0.5)/(levels-1)` with levels=256). Cheapest correct option.
- **Bayer ordered matrix** — 4×4/8×8 threshold matrix tiled by pixel;
  efficient but shows a regular pattern (used for *retro* dither where
  you WANT the pattern: Obra Dinn, Buckshot Roulette shaders).
- **Blue noise** — the quality pick (Playdead's INSIDE talk): isotropic,
  no low-frequency clumping. Needs a tiled blue-noise texture (free CC0
  ones exist, e.g. Christoph Peters' set). Survives scaling/compression
  better than Bayer — Pope switched Obra Dinn to it for that reason.
- Apply BEFORE tonemapping/quantization and note: under TAA, white/IGN
  noise re-integrates to "orange peel"; engines offset the blue-noise
  texture per frame (flipbook) to keep TAA clean. We don't run TAA —
  static IGN is fine.
- Order matters: dither applied *before* tonemap = noisy banding.

### Film grain = the "tactile" aesthetic (visible, amplitude-capped)

- Not static noise: **animated** high-freq noise, pixel-locked cells
  (quantize fragCoord by grain size — resize-stable), updated on a
  discrete frame index at ~24fps cadence so it "exposes" like film
  instead of sliding.
- **Luminance-shaped**: suppress in crushed blacks/whites, concentrate
  in midtones — photographic response, avoids colored specks in flat
  regions. Optional slight channel decorrelation for chroma grain.
- Keep ≤ ~1.5% amplitude for "invisible yet tactile"; retro presets run
  5-35% but that's a different art direction than ours.

### For our sky specifically

- `color += (ign(gl_FragCoord.xy) - 0.5) * (1.0/255.0) * k` at the end
  of the frag, pre-tonemap include. Static, no TIME — invisible but the
  horizon band stops stepping.
- Optional low-freq painterly unevenness: `fbm(dir * 2.0) * 0.03` on
  luminance — large-scale variation, not per-pixel static.
- Post-process film grain (if ever wanted globally) belongs in a
  composite pass, not the sky shader — same luminance-shaping rules.

Sources: Epic forums blue-noise postprocess tutorial (Playdead INSIDE
technique), godotshaders "Rerun gradient skybox with dithering" (IGN
impl), anisopteragames Bayer-dither writeup, Zucconi's Obra Dinn
showcase, gamedev.net time-varying film grain (pixel-locked cells,
24fps cadence, luminance response).

## Cloud techniques — cheap → expensive

The full taxonomy, mapped against `volumetricClouds.ts` (ray-marched)
and `cloudPuffs.ts` (sprites) — we already sit at both ends:

### Flat plane + scrolling noise (cheapest real clouds)

- A subdivided horizontal plane overhead, FBM/simplex noise in UV or
  world-XZ, scroll two layers at different scales/speeds — multiply them
  and clouds appear to "melt together." One draw call, no transparency
  sorting issues if `discard`/alpha-tested.
- The Godot "Spatial Clouds" trick: two planes, top + bottom shaders,
  displace verts by noise for fake thickness.
- Projected-plane variant: no mesh at all — in the sky shader,
  `p = dir.xz / dir.y` maps the dome ray onto a virtual cloud plane;
  sample FBM there. Zero geometry, works inside the sky dome pass.
- Limits: no flying through, silhouette is flat — perfect for
  third-person/grounded views, which is all our FPS needs from above.

### Toon/posterized layer (stylized pick)

- Same plane noise, then `floor(d * steps)/steps` posterization → hard
  cel edges, Ghibli read. Coverage = one smoothstep threshold; silver
  lining = `smoothstep(sunDot)` rim boost near the sun direction.
- ~30 lines inside the sky frag; cheaper than sprites and no overdraw.

### Billboard/sprite puffs

- Cluster of 5-50 textured sprites per cloud (Harris/SkyWorks lineage);
  mix a few shared textures, per-sprite rotation/scale for variety.
- Fly-through caveat: sprites popping out at camera pass read bad —
  fade or lock them near transition. Our cloudPuffs is this already.
- Cost = overdraw, not verts; keep few big puffs, not many small.

### Impostors

- Render a cloud once to a small texture, reproject/reuse it across
  frames — exploits frame coherence, historically used for flight sims
  where hundreds of clouds must coexist. Big machinery for a browser
  game; only worth it if we ever want dense cloud *fields*.

### Full volumetric raymarch (most expensive)

- Density = FBM(base shape) − coverage threshold, marched along the ray
  with lighting steps toward the sun. Reference cost: ~128 steps × 6
  light steps/px naive (unusable); Horizon: Zero Dawn's scheme (big
  steps + skip when density < threshold, detail octaves only near edges)
  is the canonical game version — that's what our volumetricClouds does.
- Standard optimizations: quarter-res buffer + temporal reprojection,
  jittered march start (blue-noise offset), early-out on transmittance
  ~1, fewer steps on low-density sections.
- Honest verdict for us: it's the only technique that supports
  fly-through and dramatic sky moments, but it's the heaviest pass we
  run for the least gameplay payoff. A posterized plane layer would
  serve the stylized look better and is ~free.

### Halos/miscellaneous garnish

- Sun-forward silver lining on any cloud type: boost emission where
  `dot(dir, sunDir)` is high — sells the "backlit" read everywhere.
- Wind coherence (same vector as grass/trails) — noted in the main
  section, applies to every cloud technique.
- Cirrus layer = a second high-altitude flat plane at low alpha; cheap
  depth cue.

Sources: Harris "Real-Time Cloud Rendering" (impostors/particles,
flightsim lineage), "Realistic and Fast Cloud Rendering" survey (sprite
cluster stats), Tóth "Optimisations for Real-Time Volumetric
Cloudscapes" (¼-res + jitter + temporal AA, 1/16 steps), Schneider &
Vos HZD talk (threshold skip scheme), godotshaders Spatial/Cloudy sky
(two-plane + multiply-scrolled noise), Quibli Cloud2D (morphing plane
clouds), Unity Cloudscape (textureless flat-plane stylized).

## If we ever rework ours

1. Sun disc: `color += sunColor * pow(sunDot, 1200.0)` + halo
   `pow(sunDot, 24.0) * 0.15` — behind a spec/uniform flag.
2. Elevation-keyed sunset band — one smoothstep on sunDir.y.
3. Optional toon-cloud layer — FBM on `dir.xz/dir.y`, posterized, silver
   lining near sunDot; cheaper than volumetricClouds and more stylish.
4. Keep: horizon = fogColor exactly, star suppression near sun.
