# Trap: mid-ray mist sample anchors the fog bank pattern to the camera

Symptom: a "caustics-like" dapple + distant grain crawling over terrain —
**only while translating** (walking/skiing), nothing on pure camera
rotation. Slope-selective, present on every texture preset, unaffected by
`?shadows=off`, gone under `?terrainstub=1`.

## The mechanism

`heightFogAmount` (`client/src/world/terrainShaders.ts`) modulates height-
fog extinction by a drifting two-octave noise field — intended as slow
mist banks. The noise was sampled at the view ray's **midpoint**:

```glsl
vec3 mid = ro + delta * (dist * 0.5);
vec2 np = mid.xz * 0.008 + vec2(1.0, 0.1) * mistTime * 0.02;
```

`mid` tracks the camera: as `ro` translates, the sampled point slides
through the noise field, so the ±45% extinction modulation repaints
itself across the surface underfoot — a moving light/dark web over
fogged terrain. Rotating changes `mid` little (ro fixed); walking moves
it constantly. Exactly the reported signature.

## Fix

Sample at the ray's terrain **endpoint** (`ro + delta`). The bank pattern
pins to world space, drifts only on `mistTime` (the intended ~2.5 m/s
wind), and can no longer crawl relative to the surface.

## Bisect path (what actually isolated it)

Four suspects were eliminated in order, each by a kill-switch — theory
alone misdiagnosed this three times:

1. `seaTint` caustic web + `grainFade`/`detFade` detail layers disabled —
   artifact persisted (all restored; only underwater/time-animated or
   sub-140m terms, wrong signature anyway).
2. `?shadows=off` — persisted: not shadow-acne swim.
3. `?terrainstub=1` — **gone**: keeps vertex displacement + N·L + simple
   fog, so the cause lives in the procedural palette **or** the extended
   fog stack (ramp/dirTint/volumes/mist) — not geometry.
4. New `?mist=off` and `?fogvol=off` gates in `Terrain` — `mist=off`
   killed it. Pinpointed.

Ride-along fixes landed while hunting (kept — real but unrelated):
shadow-camera texel-grid snapping in light space (`scene.ts`,
stable-CSM), and `bandkeep()` wavelength AA on every unbandlimited
high-frequency noise term (sub-pixel procedural noise is a genuine
shimmer class; kill only fires below 2 px so visible detail is kept).

## Rules of thumb

- **A world-painted term sampled at a camera-keyed point crawls.** Any
  noise/density/modulation evaluated at `ro + k·delta` (mid-ray, fixed
  fraction) is anchored to the viewer — it will slide on every
  translation. Sample at the surface hit point, or in world space.
- **Motion-only artifacts need kill-switch bisects, not screenshots.**
  Static captures are blind to them; add cheap `?x=off` uniform gates
  (`mist`, `fogvol`, `shadows`, `terrainstub` now exist) and let the
  person who sees the artifact flip them.
- **Don't disable visual layers as a diagnostic** — it damages the thing
  you're trying to preserve and still doesn't isolate the cause. Gate,
  don't delete.
- `?terrainstub=1` splits "geometry vs fragment-stack" in one reload —
  first test to run on any painted-terrain artifact.
