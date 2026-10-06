# Blender MCP Sculpting Pipeline — Reference

Why this doc exists: we discovered a working loop for producing *organic*
creature geometry that our primitive-merge approach can't express, and the
rakk v3 sculpt (`_tools/rakk_sculpt.blend`, `client/public/assets/models/rakk.glb`)
proved it end-to-end. This is the recipe to repeat it.

## The discovery: Skin modifier > metaballs

Metaballs were tried first and produced beaded caterpillar chains — every
ball's influence boundary reads as a lump unless spacing ≪ radius, and
tapered chains (snouts, tails) bead up no matter how dense you pack them.

The right primitive is the **Skin modifier** — Blender's built-in answer to
ZBrush ZSpheres:

- Build a **stick-figure skeleton**: a mesh of vertices + edges following
  the creature's anatomy (spine chain, neck, snout, tail, wing fingers).
- Each vertex carries a `radius` (two values = elliptical cross-section —
  `radius.y` on a Y-running edge is vertical thickness; flat heads and
  snouts come free).
- `Mirror` → `Skin` → `Subdivision Surface` (Catmull-Clark, level 2)
  produces a single continuous, smooth, quad-ish surface. Branching edges
  (finger fan off a wrist) fuse organically.
- Bonus: Skin's **Create Armature** operator generates a bone per edge —
  the skeleton you modeled *is* the rig, which feeds the SkinnedMesh
  path from `2026-10-04_PROCEDURAL_ORGANIC_GEO.md` directly.

Apply order matters: **Mirror first** (it duplicates skeleton edges),
then Skin, then Subsurf. `modifiers.move()` reorders.

## The MCP loop

Blender MCP gives `execute_blender_code` (arbitrary bpy) +
`get_viewport_screenshot`. Viewport screenshots of metaballs/skeletons are
nearly useless — element influence rings drown the surface. The loop that
worked:

```python
# one throwaway camera + workbench renders to files
scene.render.engine = 'BLENDER_WORKBENCH'   # fast, no lights needed
scene.display.shading.light = 'STUDIO'
cam.rotation_euler = (target - cam.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.render.render(write_still=True)      # → _tools/*_prev_*.png
```

Then `read` the PNG (the tool renders images) and iterate. Four angles
minimally: side, front, top, 3/4 perspective. Head close-up for facial
parts. This is the headless-pipeline pattern too — the same code works in
`blender -b` for CI.

## Recipe used for rakk v3 (repeatable)

1. Skeleton mesh via `me.from_pydata(verts, edges, [])` — verts as
   `(pos, rx, ry)` tuples, edges as index pairs. Spine +Y forward
   (Blender +Y → glTF -Z; rotate π in-engine or pre-export).
2. `modifiers.new('Skin','SKIN')`, then set
   `me.skin_vertices[''].data[i].radius = (rx, ry)` and mark roots
   (`.use_root`) on disconnected chains (chest + tail tip).
3. Wing membranes as a separate n-gon mesh — vertex at shoulder, wrist,
   finger tips, scallop midpoints; `Solidify(0.015)` + `Simple` subdiv +
   Mirror. Skin can't make membranes (it tubes each branch), so flat
   geometry stays flat geometry — that's fine, membranes ARE flat.
4. Apply all modifiers, `bmesh.ops.triangulate`, `Decimate` (~0.5 →
   ~5.5k tris), `bpy.ops.wm.save_as_mainfile` (keep the .blend —
   iteration source), `bpy.ops.export_scene.gltf(use_selection=True)`.

## Axis conventions (the part that bites)

- Model along **+Y forward, +Z up** in Blender.
- glTF exporter converts to +Y up, so the creature arrives facing **-Z**
  in three.js — `geometry.rotateY(Math.PI)` if the engine's convention is
  +Z-forward parts (ours is).
- `use_selection=True` + select only what belongs in the file.

## Fitting it to the instanced swarm

`SpeciesSwarm` takes a `BufferGeometry` per part and instancing doesn't
care where it came from. Load path options:

- **Sync**: `GLTFLoader` is async — either preload before swarm creation,
  or return procedural placeholder geometry from `parts()` and hot-swap
  `mesh.geometry` on the created `InstancedMesh` when the GLB lands
  (meshes live in `swarm.meshes`; swapping `.geometry` is legal).
- **Split**: keep separately-articulated sub-meshes as named objects in
  one GLB (RakkBody, RakkWingR) — extract by name, one `SwarmPart` each.
- Tail/curl details baked rigid read fine; the whip flex still animates
  via the part matrix (whole-part S-curve was the win anyway).

## Costs + gotchas hit live

- `MirrorModifier.moveable` doesn't exist (5.2) — modifier attrs are
  version-sensitive; check errors instead of guessing fields.
- `modifiers.move(idx, 0)` for stack order.
- `me.skin_vertices['']` — the default unnamed layer; exists only after
  the modifier is added.
- Decimate **after** triangulate for stable output.
- GLB bakes workbench-ish material data; ~440KB for an 11k-tri body —
  decimate before export, or accept it (one file, instanced).
- MCP shares the user's live scene — clean it up first
  (`select_all`+delete) and save a .blend so the sculpt survives.

## Sources

- Skin modifier (manual, radii, Create Armature):
  https://docs.blender.org/manual/en/5.2/modeling/modifiers/generate/skin.html
- bSpheres addon (ZSpheres-style workflow this approximates):
  https://github.com/PapaTemporal/blender_bspheres
- Blender 5.x SDF/volume grid nodes (alternative "true SDF" route):
  https://www.strayspark.studio/blog/blender-51-sdf-volume-nodes-game-assets
- Skin-modifier creature workflow writeup:
  https://gamedev.net/tutorials/visual-arts/using-the-skin-modifier-in-blender-to-quickly-model-creatures-r5004
