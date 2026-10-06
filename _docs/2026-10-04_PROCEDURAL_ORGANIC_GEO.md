# Procedural Organic Creature Geometry — Reference

Why this doc exists: our creature bodies are `mergeGeometries()` unions of
primitives. Unions produce hard seams and silhouette breaks — that is *why*
rakk v1 read as "a bat made of black planes" and v2 still looks assembled.
Organic bodies need smooth blending, which primitives cannot express. This
doc surveys the viable techniques and recommends one for this codebase.

## The technique landscape

### 1. SDF + smooth-min → polygonize once  (recommended)

This is the Spore creature-creator approach, and ZBrush ZSpheres, and the
standard "SDF character modeling" recipe in the shader-toy world.

A body is a **signed distance field** — a function `f(p) -> d` returning
distance to the nearest surface (negative inside). Build it from cheap
primitives evaluated in code (no meshes involved at this stage):

```
sdSphere(p, c, r)            = |p - c| - r
sdCapsule(p, a, b, r)        = dist(p, segment(a,b)) - r
sdStick(p, a, b, rA, rB)     = capsule with taper (legs, tails, necks)
sdEllipsoid(p, c, rx, ry, rz)= scaled-sphere approx
```

Then blend primitives with **smooth-min** instead of `min`:

```
smin(a, b, k) = min(a,b) - h*h*0.25/k     (polynomial variant)
              where h = max(k - |a-b|, 0)
```

`k` is the blend radius: `k=0.05` is a tight muscle junction, `k=0.3` is a
fat melting join. Because capsules take *two endpoints*, you place segments
along a curve — a drooping snout, an arcing tail — for free. No primitive
in three.js can bend; an SDF chain can.

**Surface extraction**: evaluate the field on a regular grid and polygonize
the zero-isosurface. Marching Cubes is the canonical algorithm; **surface
nets** (Naive Surface Nets / smooth variant) is ~150 lines, produces nicer
quads-ish triangulation at the same cost, and gives smooth normals straight
from the field gradient (`n = ∇f/|∇f|`, finite-difference or analytic).
Output is an ordinary `BufferGeometry`.

**Free vertex colors**: carry a material-id through the smin (`vec2 smin`
keeps the dominant primitive's id — see the shader-dev reference below) and
bake per-vertex tint zones: dark dorsal, pale belly, bone crest. Works with
`MeshLambertMaterial({ vertexColors: true })`, zero texture memory.

**What it's bad at**: `smin` is inherently soft. Hard blades, talon hooks,
crest plates, eye quads stay as rigid primitive parts — which is correct:
bone and chitin *should* read hard against soft hide.

### 2. Swept / lofted tubes along curves

Extrude an elliptical ring along a `CatmullRomCurve3` with per-sample
radius/rotation. `TubeGeometry` is the toy version; a custom loft (~80
lines) gives radius taper + elliptical cross-sections + ring twist.

Best for: whippy tails, necks, tentacles, wing finger struts, horns.
Limitation: still a hard union at junctions — smooth *parts*, not a smooth
*creature*. Use it for appendages, not torsos.

### 3. Subdivision surfaces

Author a coarse quad cage, subdivide once (Catmull-Clark, or three.js's
`LoopSubdivision` addon for triangles). Beautiful surfaces, but authoring
a good cage is more fiddly than placing capsule endpoints, and it doesn't
blend separate parts either. Skip for our pipeline.

### 4. Domain warping / displacement

Add low-frequency noise to the field (`f(p) + n(p)*s`) or displace vertices
post-hoc. Cheap secondary detail: skin lumps, muscle asymmetry, horn ripples.
Apply AFTER the base shape is right; it decorates, it doesn't rescue.

## The instancing constraint — read this first

`SpeciesRenderer` is `InstancedMesh`-per-part: every instance is a rigid
transform. **No per-instance vertex deformation, period.** SDF bake affects
the *shared geometry*, not per-instance shape — that's fine and even good
(bake once → all 512 rakks share it).

Consequences:

- Joints (wing hinge, tail root) stay rigid articulations. Even the real
  Morrowind cliffracer was segmented — this is honest low-poly practice,
  not a hack.
- The trick that hides joints: **overlap the child part deep inside the
  parent's volume**. With SDF bodies, burying a wing shoulder capsule
  inside the torso blob makes the hinge invisible — the seam only shows
  as a crease at large angles, exactly like a real shoulder.
- Keep per-part counts low; every extra part is +1 matrix write per
  creature per frame.

## Proposed API: `entities/blobGeo.ts`

```ts
type Prim =
  | { kind: 'ball', p: V3, r: number, tint?: number }
  | { kind: 'cap',  a: V3, b: V3, rA: number, rB: number, tint?: number };

// builds the smin field, polygonizes, returns geometry + optional
// vertex-color buffer
function blobGeo(prims: Prim[], opts: {
  cell?: number;     // grid resolution, default ~0.05 world units
  k?: number;        // smin blend radius
  pad?: number;      // bounds padding
  colors?: boolean;  // bake dominant-prim tint into 'color' attribute
}): BufferGeometry;
```

Implementation notes:

- Bounding box = union of prim bounds + pad; grid from `cell`.
- Surface-nets: mark cells whose 8 corners straddle the surface; vertex per
  cell at edge-intersection centroid; quads between adjacent sign-crossing
  cells (two tris, pick the diagonal by field curvature or just fixed).
- Normals: `normalize(∇f)` sampled at each vertex — butter-smooth for free.
- Bake lazily like the current `_bodyGeo` pattern: first `rakkParts()`
  call, cached forever. A 48³-ish grid is ~110k field evals ≈ low-ms —
  once, at spawn-in of the species module, not per instance.
- Keep it deterministic: no `Math.random` in fields; static arrays only.

## Rakk v3 sketch (if we build it)

- **Body SDF**: torso ellipsoid → neck stick → flat head ellipsoid →
  snout stick → rump stick — one smin group, zero seams from skull to
  tail root.
- **Wings**: unchanged rigid 2-joint parts, but shoulder ball buried in
  the torso volume.
- **Tail**: SDF chain of shrinking capsules along an arc (whip curve),
  talon cone stays rigid.
- **Crest/talon/eyes**: hard primitives — correct contrast.

## Beyond in-repo geometry: AI / tooling pipelines

Instancing constrains *deformation*, not geometry *source* — a GLB file
extracts to an ordinary `BufferGeometry` and drops into `SwarmPart` the
same as a procedural one (or splits into rigid sub-meshes at bone bounds
to keep the articulated-wing trick). So the mesh can come from anywhere.

### AI text/image→3D generation

Current generation tools are genuinely usable for stylized creatures:

- **Meshy 7** — best out-of-box game asset quality: ~30k tri mesh + PBR
  maps from a prompt or reference photo, direct GLB/FBX/OBJ export, plus
  `smart-topology`/`target_polycount` options for cleaner topology.
- **Rodin Gen-2.5** (Hyper3D) — carves the most surface detail, but
  returns ~500k tris; needs a hard decimation pass. Close-up grade.
- **Tripo 3.1** — fastest/cheapest, decent geometry, bakes color into a
  single texture by default. Draft/blockout tier.
- **Hunyuan3D** — open-source, self-hostable, rougher textures needing
  refinement.

Reality check: *nobody ships raw output*. Expect a decimate + topology
cleanup + texture pass regardless. For our deliberately-low-poly look the
value is the silhouette/sculpt, not the density — treat AI output as a
clay block to decimate, not a finished asset.

### Full agent pipelines (exist already)

Public reference: `animated-asset-skill` — a prompt → Seedream concept art
→ Hunyuan-3D mesh → voxelizer → **headless Blender derives the skeleton
from the voxel grid** (legs = bottom split blobs, tail = trailing slices,
head = front rise) → procedural gait clips → rigged glTF. The rig/gaits
are verified *numerically*, never eyeballed — that's the pattern worth
copying even if we don't use the pipeline.

### Blender procedural (we have live MCP access)

Blender metaballs are literally the same blob math as the SDF proposal —
smooth unions, no seams — but with a real modeling tool doing the meshing:

```
metaball skeleton → convert to mesh → voxel remesh → decimate → GLB
```

Drivable end-to-end through the Blender MCP (execute code, viewport
screenshots for review), exports straight into
`client/public/assets/models/`, and `GLTFLoader` hands us the geometry.

### Ranked paths for the rakk

1. **Blender metaball sculpt via MCP** — true smooth-union body, real
   tool, zero deps/cost, iterate via screenshots. Then decimate to
   ~3–8k tris → `rakk.glb` → split wings/tail for articulation.
2. **In-repo SDF mesher** (`blobGeo.ts` above) — same math, no Blender
   roundtrip, stays fully procedural. More code, less tooling risk.
3. **AI gen (Meshy/Hunyuan3D API)** — highest raw fidelity ceiling;
   needs an API key, a decimate pass, and an asset/license to track.
4. **Hybrid** — AI for concept silhouette, Blender metaballs for the
   shipped mesh. Art direction without inheriting AI mesh jank.

Fallback discipline either way: keep the procedural visual archived so
each generated attempt is an A/B, not a commitment.

## Runtime deformation: rigid parts vs. bendable meshes

The mesh-generation question and the animation question are separable —
whatever produces the geometry, three render paths exist:

### A. Rigid articulated parts (current)

Cut at joint boundaries; each part is a per-instance matrix inside one
`InstancedMesh` per part. Cheapest possible rendering (one draw call per
part for the whole swarm) but joints are hard hinges — wing membranes
can't billow, tails can't whip smoothly; seams show at large angles.
Mitigation: bury child roots inside parent volume so the hinge hides in
flesh, which SDF/smooth-union bodies make painless.

### B. SkinnedMesh per creature (recommended for hero species)

One mesh + bone hierarchy + vertex weights → continuous deformation,
real wing folding and tail lash. Standard path: Blender rig → skin
weights → GLB → `Skeleton`. Cost: **one draw call per creature** instead
of instancing — a non-issue at single/low-dozens rakk counts, and the
only path where the membrane stretches rather than hinges. Rig scope is
small: spine chain + 2 wing chains + tail chain + jaw ≈ 7–10 bones,
driven procedurally from `animT`/`state` — no clip assets needed.

### C. Instanced skinning (scale card)

Keep one draw call AND skinning: `skinIndex`/`skinWeight` vertex attrs +
per-instance bone matrices packed into `InstancedBufferAttribute`/texture,
linear-blend-skinning patched into the material via `onBeforeCompile`
(~100 lines shader patch, known community pattern — three.js doesn't ship
it). Use only if swarm counts ever reach hundreds of skinned creatures.

### D. Morph targets

Bake N poses, lerp per instance. Cheap but pose space is fixed; limbs
blend mushy between keyframes. Skip for articulated creatures.

### Verdict

Rakk wants B: counts are low, and wings/tail are exactly the features
skinning does better than hinges. Keep the instanced pipeline as the
swarm fallback and for genuinely rigid species (strifer, turretter);
opt species into `SkinnedMesh` where anatomy earns it.

## Sources

- three.js `MarchingCubes` addon (live-mesh variant; we'd write our own
  geometry-returning evaluator):
  https://threejs.org/docs/pages/MarchingCubes.html
- SDF primitive + smooth-boolean reference (sdCapsule, sdStick, smin,
  character-modeling variant):
  https://github.com/MiniMax-AI/skills/blob/main/skills/shader-dev/reference/sdf-3d.md
- Spore/metaball character generation writeup (dominant-prim coloring idea):
  https://github.com/utkarshdwivedi3997/character-creator
- Skeleton→cage→Catmull-Clark parametric creature pipeline (alt route,
  Rust): https://docs.rs/symbios-avatar/latest/symbios_avatar/
- Composable SDF scene-graph API (naming/structure inspiration):
  https://github.com/schem-at/nucleation/blob/main/docs/features/sdf-and-fields.md
- three.js procedural-creatures skill (spec-driven smin bodies + gait):
  https://threejs-skills.com/skills/threejs-procedural-creatures.html
- AI 3D gen head-to-head (Meshy/Tripo/Rodin/Hunyuan, tri counts, texture
  quality): https://fuser.studio/articles/meshy-vs-rodin-vs-tripo
- Meshy Text-to-3D API (preview→refine workflow, smart-topology):
  https://docs.meshy.ai/api/text-to-3d.md
- Tripo generation API (smart_low_poly, quad topo, per-part output):
  https://developers.tripo3d.ai/en/docs/generation-text-to-model
- Agent pipeline: prompt → concept → Hunyuan-3D → voxelize →
  voxel-derived rig + procedural gaits → glTF (numeric gait verification):
  https://github.com/rehan-remade/animated-asset-skill
- Blender remesh/retopo options (voxel remesher caveats, decimate):
  https://docs.blender.org/manual/sl/latest/modeling/meshes/retopology.html
