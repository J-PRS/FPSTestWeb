# Enemy outline / ally rim — inverted hull, 2026-10-19

Friend-or-foe readability pass: enemies get a red silhouette outline +
fresnel rim, allies a quieter green rim, bodies stay neutral. Shipped as
an inverted-hull shader on `PlayerModel` plus a gunlab experiment bench.

## Architecture

- `PlayerModel.setOutline(hex|null)` lazily clones each `SkinnedMesh`
  (shared geometry + shared skeleton → animates for free) under a
  `BackSide` flat material. The held gun prop gets plain `Mesh` hulls,
  rebuilt on `setWeapon`. ~1 extra draw per body mesh (~15/remote) —
  the LOD-off-at-distance knob exists if draw calls ever hurt.
- `PlayerModel.setRim(hex|null)` injects a fresnel emissive term into
  the per-instance material clones (`playerMats.ts`) — zero extra draws.
- `remotes.ts:applyTeamTint` runs every tick: `friendly = theirTeam ===
  localTeam` → allies `setOutline(null) + setRim(0x44CC55)`, enemies
  `setOutline(0xF04A4A) + setRim(0xF04A4A)`. Teamless/FFA bodies read
  enemy by design. Colors: OW scarlet `0xF04A4A` (TF2 brick `0xB8383B`
  fallback noted), ally squad-green `0x44CC55` (OW ally blue `~0x66A3FF`
  alternative noted).
- Gunlab: three independent rail selects — **team** (armor tint:
  neutral/red/blue, `armor` material only), **mark** (none/outline/rim/
  out+rim), **side** (enemy/ally/neutral color) — all persisted.

## Hull shader (the part that took iteration)

`MeshBasicMaterial` + `onBeforeCompile`, two extrusions:

```glsl
transformed += normalize(hullObjN) * uHull;        // geometric nudge
#include <project_vertex>
vec4 hullN = projectionMatrix * vec4(hullViewN, 0.0);
gl_Position.xy += normalize(hullN.xy + vec2(1e-6)) * uHullPx * sqrt(max(w, 0.25));
```

- `uHull = 0.006` — only enough to un-z-fight backfaces.
- `uHullPx = 0.019`, scaled by `√w` → rim width ∝ √distance:
  ~2.5px at 10m, ~1px at 60m, sub-pixel past 120m. Constant-px read
  too fat at range; world-constant vanished; sqrt splits it.
- `depthTest: true, depthWrite: false, renderOrder: 2` — outline only
  when the enemy is actually visible (OW rule; wallhack-red was
  deliberately rejected).

## Bugs found (each reproduced → diagnosed → fixed)

1. **Hull covered the whole model** — `depthTest:false + renderOrder
   999` painted interior backfaces over the body. Fixed by depth-tested
   ordering, then pivoted to depthTest:true (terrain was overpainting
   the rim anyway).
2. **Gun rendered black + no hull** — prop geometry had no `normal`
   attribute → flat-black lighting AND NaN extrude. `computeVertexNormals()`
   on normal-less geos.
3. **Corner cracks** — non-indexed geometry: coincident verts carry
   per-face normals, extrude divergently. Gun hull: weld position-only
   clone → smooth normals.
4. **Body ring glitchy/shredded** — same split-normal cause on plate
   hard edges. Body hulls now weld a copy carrying position +
   skinIndex/skinWeight (verts with differing weights stay split —
   skinning preserved).
5. **Gun shader variant failed to compile** — `objectNormal`/
   `transformedNormal` only exist under `USE_SKINNING||USE_ENVMAP`;
   guarded with a `normal`/`normalMatrix` fallback.
6. **Outline invisible at range / thin on small rigs** — world-space
   nudge is subpixel past ~20m and rides model scale → clip-space push.
7. **THE BIG ONE — skinned hulls pushed INWARD** — three defines
   `FLIP_SIDED` for `side === BackSide` and `defaultnormal_vertex`
   negates `transformedNormal`. The shell shrank *inside* the body:
   "outline only at extreme closeup". Gun worked because its branch
   used the raw `normal` attribute. Fix: `hullViewN = -transformedNormal`
   on the skinned path.
8. **Far = fat ring** — constant-px dominated small distant bodies →
   √distance scaling.

## Gib/pulverize preview (same session)

- `pulverize` + `pulverize 0.1x` buttons run the real kill path:
  `model.deathParts()` → `PlayerDebris` (smoke, shell burst) + body
  hides ~1.6s. Speed scalar scales dt, flash decay, respawn.
- `playerGibs.ts` learned rigid-mesh detection: plates weighted to a
  single bone bake via one matrix transform (cheap, whole-plate chunks)
  instead of the per-vertex skinning bake; baked geos are welded
  (position+skin attrs) — was 3× vert count as raw tri soup.
- Space bug worth remembering: `LAB_SCENE` is `creatureLayer` (re-
  parented per preview), not scene root — world-space part.pos needed
  `worldToLocal` or the burst landed offset.

## Knobs / files

- `uHull`, `uHullPx`, hull color call sites:
  `client/src/entities/PlayerModel.ts` (setOutline ~L887)
- Rim patch: `client/src/entities/playerMats.ts` (`setRim`)
- Game wiring: `client/src/game/remotes.ts` (`applyTeamTint`)
- Gunlab: `client/src/gunlab.ts` rail, `client/src/gunlab/previews.ts`
  (applyTeam/gib/debris tick)
- Gibs: `client/src/entities/playerGibs.ts`
- Tools: `_tools/e2e/_outlineshot.ts` (lineup + mark=outline shot),
  `_tools/e2e/_gibshot.ts` (mid-burst frames), `_tools/e2e/_hullprobe.ts`
  (scene-level hull census on real wire bots)

## Verified / open

- Hull census on real bots: enemies 37-38 hulls + gun hull visible in
  scene; allies hulls:0 + green rim — probe `_hullprobe.ts`.
- Gunlab visual: clean ring on all three rigs after FLIP_SIDED fix.
- NOT verified: enemy outline look at real engagement distances in a
  live match (probe proves presence, not aesthetics); hull draw-call
  cost on a full server unmeasured — if Alt+Q shows pain, LOD hulls off
  past ~30m.
