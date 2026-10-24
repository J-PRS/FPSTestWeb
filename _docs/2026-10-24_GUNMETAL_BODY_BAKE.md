# Gunmetal wear/grime bake on body rigs (2026-10-24)

Reference for applying the weapon AO+wear+grunge pipeline to player
bodies — what it is, what broke, and the knobs. Implemented for
`juggernaut` (`RIG_MANIFEST.gunmetal`).

## What the "gunmetal texture" actually is

Two halves in `client/src/effects/vertexAO.ts`:

1. **Bake, once at load** (`bakeVertexAO` / `bakeWearOnly`): per-vertex
   hemisphere raycasts for AO, sharp-edge classification into
   `aedge`/`abary`/`aalt` attributes, a small per-triangle wear-line
   atlas texture, optional `grime` (concave-valley dirt mask).
2. **Shader, per pixel** (`enhanceWeaponMaterial`): injected
   `onBeforeCompile` chunk — fbm mottle, patchy AO-gated wear
   brightening, micro-scratches, grime darkening. No texture files;
   the baked attributes are the inputs.

So it is dynamic shading *over* baked geometry data — the bake exists
because raycasts/edge-classification can't run per-frame.

## Application point (bodies)

`RigManifest.gunmetal: true` → `PlayerModel.load` bakes the **cached
GLB template** once per URL (`gunmetalBaked` set), then every
`SkeletonUtils.clone` shares the baked geometry. Matte recipe applied
to the GLB materials first: `metalness 0.1`, `roughness 0.72` (painted
plate, not machined metal), `__wearInt 2.5`.

```ts
bakeVertexAO(gltf.scene, { grime: true, wearBoost: 0.5, edgeAngle: 28 });
```

## The hang — object-unit scale bug

`bakeWearTexture` subdivides each flagged edge into `len / 4mm` raster
strokes measured in **object-space units**. All prior callers (guns,
flag pole, swarm parts) are meter-scale, so the assumption never bit.
Body rigs inherit brute's skeleton with vertices at ~100× units
(armature scale 0.01): edges measured ~1000 "units" → ~250k real
`ctx.stroke` calls per edge → main thread parked for minutes. Gunlab
looked frozen; posedump timed out at `waitForFunction`.

Fix (all in vertexAO.ts + playerMats.ts):

- `bakeWearTexture(geo, us)` — `wlen` scaled by object→world scale,
  pieces capped at 64 (they only feed noise-fade granularity).
- `uObjScale` shader uniform — the 9mm edge band and every noise
  frequency (`*35`, `*90`, `*700`, `*110`) multiply `vWpos`/`eDist`
  into world units. `__unitScale` = `mesh.getWorldScale().x` stamped
  on geometry + material in both bake entry points.
- `playerMats.ownMaterial` re-arms the shader on clones: `clone()`
  drops `onBeforeCompile` and JSON-roundtrips `userData` (killing
  texture refs) — copies `__wearTex/__grimeTex/__wearInt/__unitScale`
  from the source then calls `enhanceWeaponMaterial`.
- `setRim` chains `prev?.(sh, r)` instead of overwriting
  `onBeforeCompile` — it was silently clobbering the grunge hook on
  rim-enabled bodies.

## Why weapon defaults needed re-tuning

Same recipe, different asset class — the knobs exist for this:

| Knob | Weapon default | Jugg | Why |
|---|---|---|---|
| edge flag | 50° dihedral | `edgeAngle: 28` | ellipsoid/cone plate seams sit at 15-25° — nothing flagged at 50 |
| `uWearInt` | 1 | 2.5 | 9mm band on a 2.8m body is sub-perceptual at gameplay distance |
| `wearBoost` | per-weapon table | 0.5 | turretter/swarm precedent for readable scuff on large surfaces |

`edgeAngle` threads to `bakeEdgeLines` as `1 - cos(angle)`. 28 flags
most facet seams — if it reads as wireframe noise in-game, try 35-40.

## Gotchas for the next rig

- Bake mutates shared geometry — the `gunmetalBaked` URL guard is
  load-bearing, do not bake per clone.
- `bakeVertexAO` blocks the main thread (~1.2s on the 2.9k-tri jugg);
  once per URL it's fine, but don't flag it on several rigs that all
  load at match start.
- `setTint`'s 'armor' material targeting still works post-bake; rim and
  grunge coexist via the chained hook.
- `?wearviz=1` paints `vec3(wear, vColor, edge)` — the reliable way to
  verify flag coverage when the shaded result is too subtle to judge.
- Skinned meshes bind rigid plates (`JOINTS_0` single bone) — the bake
  is pose-agnostic, runs at bind pose.
