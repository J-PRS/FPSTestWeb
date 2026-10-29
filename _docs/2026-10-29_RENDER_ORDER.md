# Render order reference — how the client stacks transparents

> Written 2026-10-29 after the "terrain draws over VFX" bug. Source of
> truth is the code; this doc is the map. Verified against
> `client/src/**` `renderOrder`/`depthTest`/`depthWrite`/`transparent`
> declarations on that date.

## How three.js actually draws

1. **Opaque pass** — everything with `transparent: false`, sorted
   front-to-back by depth. `renderOrder` still applies inside the pass.
   Depth buffer does all the work; ordering only affects overdraw cost.
2. **Transparent pass** — everything with `transparent: true`, sorted by
   `renderOrder` ascending, then by object depth **back-to-front**
   (painter's algorithm, per-object origin — never per-triangle). Alpha
   blending is order-dependent: whoever draws last wins the pixel.

Consequences that bite:

- A transparent mesh with `depthWrite: true` punches a depth hole —
  transparents drawn *after* it fail the depth test and vanish.
- A transparent mesh that's effectively opaque (`alpha ≈ 1`) drawn
  *after* a VFX object overpaints it — the VFX wrote no depth to stop it.
- `depthTest: false` does not mean "always on top" — it only ignores the
  depth buffer. A transparent drawn *later* still blends over it. For a
  truly never-occluded element you need `depthTest:false` **and** a
  late `renderOrder`.

## The tier table (client/src)

| Order | What | Why |
|-------|------|-----|
| −100 | `cubeDome` sky (`mapAssets.ts`) | Opaque pass, `depthTest:false` — pure background fill, first |
| −2 | terrain clipmap levels (`terrain.ts`) | Transparent *by design* (one shader program — only the outer ring needs alpha). Depth-write on. Must precede ALL VFX or its alpha≈1 fragments overpaint them |
| −1 | remote-detail patches (`?terrainRemoteDetail=1`), sun shafts | After the clipmaps they overlay, before VFX |
| 0 | **all world-anchored VFX** — beams, glows, bursts, nugget/crown shafts, decals, blob shadows, gizmo rings, tracers, deployable translucents | The default tier: `depthWrite:false` + z-sort lets painter's algorithm do its job |
| 1 | water surface, volumetric cloud deck, ground mist | Atmosphere layer — deliberately tints gameplay beneath it |
| 2 | cloud puffs, `PlayerModel` hull outlines, station dome | Nested-transparency ordering + outline-after-body |
| 3 | station motes | Inside the dome |
| 5–7 | gunlab internals | Separate scene, irrelevant to the game view |
| 99 | maplab ball beams | maplab only, `depthTest:false` x-ray probe |
| 900 | `beamBuild` bolts, debug terrain wires | `depthTest:false` — deliberate through-wall read |
| 901 | collider wire (F1 debug) | Above the cyan clipmap wires |
| 950 | damage numbers, flagRun TAS readout | `depthTest:false` hit feedback — must never be occluded |
| 999 | wireframe gizmos, feet marker, `pickDot` | Debug/overlay tier |
| 9999 | netProbe ghosts | Debug only |

## The rules

1. **World objects stay at renderOrder 0.** `renderOrder` is for
   deliberate layering (atmosphere, overlays, debug), not for fixing
   depth problems — that's what the depth buffer is for.
2. **Every `transparent:true` gets `depthWrite:false`** — unless it IS
   the pseudo-opaque ground (terrain). A depth-writing transparent
   culls later transparents behind it.
3. **`depthTest:false` + renderOrder ≥900** is the never-occluded
   pattern (damage numbers, through-wall bolts, debug wires).
   `depthTest:false` at renderOrder 0 still gets blended over.
4. **Terrain is the special case**: it lives in the transparent pass
   (shared program — `opaque` is a program parameter, so a mixed set
   mints a second ~83 KB program, a ~1 s serial compile inside the
   veil). Because its fragments are alpha≈1 and it writes depth, it
   MUST draw first in the pass (−2/−1). VFX then depth-test against it
   and occlude behind ridges correctly.
5. **Additive blending is order-independent** — the safe default for
   glows/sparks/beams. Alpha blending needs the sort to be right.

## Known traps, documented

- **Sim-vs-render height gap** — the collider is the fixed 5 m lattice
  (`getHeight`/`hmChord`); the drawn surface is the camera-dependent
  clipmap (`getRenderedHeight`), diverging by *meters* at range. Objects
  resting on sim ground (nuggets, crown beams, explosion origins at the
  swept hitPoint) can sit *inside* a rendered bulge — reads as
  "rendering behind terrain" while depth ordering is actually correct.
  F1's yellow collider wire vs cyan clipmap wire shows the live gap;
  Alt+Q has `terrainDivLine`/`divergenceStats`.
- **Ground decals** (blob shadows) were at 999 "to render after
  terrain" and painted dark over explosions. Terrain at −2 makes that
  unnecessary — decals belong at 0.
- **`sunShafts` (−1) ties with remote patches** — resolved by z-sort
  (sky-distance vs near patch); harmless.
- **The proper fix** for transparent terrain (separate opaque inner
  program + transparent edge ring) was rejected on shader-compile cost,
  not on correctness. Revisit if the veil can pre-compile async.

## When adding a new visual

Ask two questions:

1. Does it blend? → `transparent:true` + `depthWrite:false`,
   renderOrder 0. Done — the table handles it.
2. Must it ignore occlusion? → `depthTest:false` + renderOrder ≥900,
   and say why in a comment (the tier is a contract, not a suggestion).

Do NOT add intermediate renderOrders (4, 8, 50…) to fix a clipping
glitch — check whether the object should write depth, or whether it's
anchored under the rendered surface (sim/render gap above) first.
