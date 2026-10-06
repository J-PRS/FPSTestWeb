# Ichor & Juice — splatter/decal reference report (2026-10-04)

Research notes + implementation plan for creature-hit feedback: PG "blood"
(alien ichor, blue/orange, never red), ground decals, and the broader
satisfaction ladder. Sources at the bottom.

---

## 1. Palette decision

- **Ichor, not blood.** Blue `0x7fb4e8` for soft-bodied fodder (grubs,
  nuggets-family), orange `0xe08a3c` for hot/armored things (baneling,
  roller, overlord), teal `0x3fc9b0` for crawlers/scarabs. PG, and thematically
  correct — these are magma-field creatures, not mammals.
- White was floated and rejected — reads as foam/milk. Only acceptable use:
  a brief bright core inside a blue/orange spray (already have damageFlash).
- Per-species `ichor` field on the creature target interface is the delivery
  mechanism — one color constant each, read by the fx layer.

## 2. Decal techniques — what the research says

### Rejected: `THREE.DecalGeometry` (geometry decals)
- Carves a mesh chunk out of the target geometry per decal → one draw call
  per splat, allocation + re-upload per spawn.
- Distorts/stretches on slanted surfaces (projection is planar, not
  surface-conforming — known open three.js issue #21187, decals replicate
  around corners).
- Breaks on geometry seams and multiple intersecting geoms; must rebuild if
  the surface moves.
- Only viable for static, simple geometry at low counts. Not us.

### Rejected: real fluid sims / raymarched metaballs
- SPH/marching-cubes/raymarch metaball pipelines exist in WebGL
  (sjpt/metaballsWebgl, GPU Gems ch.7) but need multi-pass spatial
  subdivision + marching cubes — a project, not a feature.
- Even the MK11 team's film-quality blood was *baked offline sims →
  geometry caches*, not runtime fluid (SIGGRAPH 2019 talk).
- SplatterFX (the Unity reference implementation everyone cites) uses
  decals + render-texture overlays, not sims. Consensus: runtime fluid is
  the wrong tool for splats.

### Accepted: shader-projected decals (what we already have)
- `terrain.addScorch(x, z, r)` projects decals in the terrain fragment
  shader — zero draw calls, zero CPU per decal, survives the clipmap's
  chord approximation, projects onto anything the shader covers.
- This is the industry "correct answer" for ground splats (Forward+/
  clustered decals are the AAA version of the same idea: projection, not
  geometry).

### Accepted: instanced particles + pooling for the burst
- Benchmarks (blacktrigram pooling writeup): naive per-particle `Vector3`
  clones burn 400–1200 allocations per splatter — GC pressure mid-combat.
  Pooled + instanced ≈ zero allocation.
- Our debris/goo system already IS an instanced pooled burst — retint it.

## 3. The recipe (three tiers)

### Tier 1 — the burst (where satisfaction actually lives)
- 4–8 instanced goo quads in the victim's ichor color, launched along the
  **projectile's direction** — directional splatter reads far better than a
  radial puff; the shot "pushes" through the body.
- Droplets velocity-stretch (one shader/vertex line — streak look free).
- Droplets that land spawn micro-stains — the ground accumulates the fight.
- Cost: reuses the debris pool; zero new draw calls.

### Tier 2 — the stain (persistence)
- Extend the scorch slot system with a `tint` channel (one extra
  `Float32Array` uniform, same pattern `fieldTintArr` already uses).
- Shader lerps toward tint instead of pure black; ichor splat = tinted
  scorch with softer falloff + slower fade than char marks.
- Kill = one bigger stain under the corpse, ~60s life vs scorch's 5s;
  brief tinted ember rim on spawn (the `ember` channel already exists).
- Cost: ~10 lines of terrain shader + one uniform array. Zero draw calls.

### Tier 3 — free seasoning
- **Scale-pop on hit**: squash 0.9→1.05 over ~80ms in the swarm matrix
  write — one sin envelope, massive readability.
- `damageFlash` already exists; keep.

## 4. The "heavier machine" tier (quality-gated `Juice: HIGH`)

Ordered by juice-per-cost:

1. **Hitstop** — 40–80ms freeze/slow-mo on kill. Free computationally;
   the single biggest documented satisfaction multiplier (MK/Doom Eternal
   rely on it). Needs the frame loop to support a time-scale dip cleanly.
2. **Physics giblets** — instanced lobes with velocity + gravity + terrain
   bounce on death-pop; the grub literally bursts into pieces. A few
   hundred verts, trivial GPU, moderate CPU (bounce tests).
3. **Corpse deflation** — bodies squash/deflate into their stain instead
   of vanishing. One scale envelope on existing swarm matrices.
4. **Persistent splat buffer (RTT)** — SplatterFX's approach: splats paint
   into a low-res world-space render texture that the terrain shader
   samples; stains accumulate permanently and overlap all match — the
   field literally scars. One offscreen texture + RTT writes on hit + one
   extra terrain fetch. Replaces the 16-slot scorch channel for blood.
5. **Wounded drip trails** — a bleeding bloatgrub/hit creature dribbles
   micro-stains as it crawls. Nearly free once the splat buffer exists;
   big character readability.
6. **Fake metaballs** — droplet burst renders to a half-res offscreen,
   alpha-threshold pass globs them together (classic 2D liquid trick).
   One extra pass; sells "liquid" without simming it.
7. **Screen/camera seasoning** — micro-shake on nearby kills, brief
   chromatic-vignette pulse on big events, directional hit vignette.

## 5. Implementation notes (code touchpoints)

- Creature hit → `takeDamage` callers already route through the fx layer;
  the spray needs the *projectile direction* — impact functions should
  thread `dir` through (some already do for knockback).
- Ichor color belongs on the `Targetable`/species descriptor next to
  `debrisKind`/`dieCue` — it's the same family of per-species fx data.
- Terrain `scorchList` → add `tint: [r,g,b]` + `splatTintArr` uniform;
  fragment shader: `col = mix(col, tint, mask * intensity)` instead of
  `col *= 1 - mask * intensity` when tint is set (keep black for scorches).
- 16 scorch slots is tight if splats share it — splats probably want their
  own list (~24 slots) with the same shader pattern, OR the RTT buffer
  replaces both for the HIGH tier.
- Non-terrain surfaces: shader decals only cover the terrain mesh;
  splats on flag stands/structures would need a second surface path —
  scope-tier-1 to terrain only, structure splats = deferred.

## 6. Sources

- three.js forum "How to draw stuff on stuff" — geometry vs Forward+
  decal tradeoffs: https://discourse.threejs.org/t/how-to-draw-stuff-on-stuff/48934
- DecalGeometry docs + distortion issue:
  https://threejs.org/docs/pages/DecalGeometry.html ·
  https://github.com/mrdoob/three.js/issues/21187
- MK11 blood FX (baked fluid sims → geometry caches), SIGGRAPH 2019:
  https://blog.siggraph.org/2020/03/creating-the-killer-content-in-mortal-kombat-11.html/
- SplatterFX (Unity) — decal + RTT-overlay architecture:
  https://assetstore.unity.com/packages/tools/particles-effects/splatterfx-impact-splatter-system-377082
- blacktrigram pooled-particle benchmark — 1202 → ~0 allocations per splat:
  https://github.com/Hack23/blacktrigram/blob/2995e76f/docs/performance/blood-particles-pooling-benchmark.md
- Metaball precedents (rejected): GPU Gems 3 ch.7 point-sampled metaballs;
  sjpt/metaballsWebgl marching-cubes-in-shader.
- Scarabaeoid grub anatomy (for the body rework already shipped): Ritcher
  terminology via the Phanaeus larva paper + UMN Extension white-grub
  guide — C-shaped, dorsal hump, folded segments, small sclerotized brown
  head capsule, translucent rear showing gut.
