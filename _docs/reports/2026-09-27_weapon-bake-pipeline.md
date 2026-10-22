# Weapon bake pipeline (three.js → headless Blender → baked assets)

Goal: JP's Unity-prototype look — baked AO crevices, edge wear, mottled finish —
without hand-painted art. Procedural weapon models get real texture-space
shading baked offline and swapped in at runtime.

## The pipeline

```
weapons built in ViewModel.ts (procedural primitives)
        │  export.js   (headless chrome, /vmdump.html?export=1)
        ▼  GLB per weapon → _tools/vmdump/models/w{wt}.glb
        │  bake.py      (Blender 5.2 headless: blender -b --python bake.py -- in.glb out)
        │             joins → smart UV → exports _uv.glb → texture-baker bakes
        │             real mesh maps (AO/curvature/thickness/world-normal) →
        │             Cycles EMIT bake (part color × mottle) → numpy composite
        ▼  w{wt}_ao.png + w{wt}_baked.glb   (UV'd mesh + baked albedo map)
        │  copy to client/public/weapons/
        ▼  ViewModel.loadBakedWeapons() swaps procedural meshes for baked GLB
```

Run the whole thing with `_tools/vmdump/bake_all.sh` (export → bake all → copy).
Per-weapon: `node export.js`, then `blender -b --python bake.py -- models/w9.glb models/w9`,
then `node probe3.js` for a render screenshot (`w9_baked.png`).

## What the bake actually produces

One Cycles EMIT bake (color × mottle) + texture-baker mesh maps + numpy composite:

1. **texture-baker** (Rust CLI, `.tb/bin/texture-baker.exe` — `cargo install
   texture-baker --root .tb`) runs on the UV'd GLB per weapon at 1024px,
   `--aa 2 --thickness --world-normal --no-normal --no-position`. It emits the
   real Substance-style maps: **raycast AO** (128 rays/texel — bores, pinch
   grooves, contact shadows), **mesh curvature** (0.5 flat, >0.5 convex =
   exposed edges, <0.5 concave = creases), **world normal** (Y-up orientation).
2. **Part paint** — per-part colors ride in the GLB as vertex colors; multiple
   COLOR_n attrs merge into PARTCOL via component-wise MIN (white fill loses).
3. **Emit bake** — `colAttr * (AO ramp 0.3 + stain/mottle/grain noise layers)`.
4. **Composite** (numpy): per-weapon median-luminance normalization to ~0.55
   (authored albedos span 0.06-0.4; ACES @ 0.4 crushes anything under ~0.2) →
   `× (0.35+0.65·tbAO)` real occlusion → `× (1-0.30·concave)` crease darkening →
   two-layer edge wear: thin uniform rim on every convex edge + wide splotchy
   layer masked by two-octave noise → warm-dust/cool-grime orientation tint
   from the world-normal map → mild `×1.35+0.04` lift.
5. The old Sobel-on-object-normals edge detector is gone — real curvature
   replaces it (catches coplanar edges Sobel missed, never fires across
   smooth-cone faces).

1024px atlas per weapon, `Smart UV Project` for the unwrap (angle_limit 1.15,
margin 0.02). Texture is the *whole albedo* — `MeshLambertMaterial({map})`,
no separate color multiply.

## Hard-won gotchas (don't relearn these)

- **Blender 5.2 API drift**: `ShaderNodeAmbientOcclusion` has no 'Samples'
  input; `node.select = True` not `select_set`; `bpy.ops.object.bake` fails if
  anything besides the joined mesh is selected; `image.save()` silently no-ops
  on baked images unless `is_dirty` — fall back to `save_render`.
- **Double color-space decode**: Cycles writes LINEAR values into the PNG.
  Tagging the texture `SRGBColorSpace` decodes again → renders ~2 stops dark.
  Load with `LinearSRGBColorSpace`.
- **Chrome caches public/ assets**: the loader URL needs `?v=${Date.now()}`
  or headless screenshots show last bake's texture forever.
- **The preview is dark by design**: game renderer is ACESFilmic at
  `TONE_MAPPING_EXPOSURE = 0.4`. Baked weapons render dark in vmdump even when
  the texture is fine — judge bakes by the PNG first, render second.
- **Vertex colors are the paint**: don't strip COLOR_0 before export; the bake
  needs them or every part turns the same gray.
- **Glow parts stay procedural**: MeshBasicMaterial meshes are skipped on both
  ends (export hides them, loader only removes non-Basic meshes).
- **texture-baker build**: `cargo install` needs ~single-job (`CARGO_BUILD_JOBS=1`)
  on this box — parallel wgpu compile OOMs the paging file. It needs UVs to
  exist, hence the `_uv.glb` export mid-script. Its PNGs are 16-bit; load via
  `bpy.data.images.load` → pixels float 0..1. glTF UV origin is top-left →
  `np.flipud` when indexing its maps against Blender's bottom-up pixels.
- **Chaingun barrels are animated** — the triad is exported as a `barrels`
  node, excluded from the join, and gets its own 256px emit bake
  (`w3b_ao.png`). Runtime adopts that node as the spin target (`startsWith`
  because Blender dedups names to `barrels.001`); a merged GLB with no barrels
  node is skipped entirely so the procedural barrels keep spinning.

## Screenshot/iterate loop

`node probe3.js` → `w9_baked.png` (single weapon, fast); `node shot.js` →
`w{0..9}_{off,on}.png` full matrix. Always attach renders when showing JP —
he judges pixels, not descriptions.

## Status / tuning dials

All 12 weapons bake through the full pipeline (real AO + curvature) and load;
logs `[vm] w{N} baked swap`. Dials in bake.py: normalization target (0.55,
gain cap 8), AO multiply floor (0.35), concave darkening (0.30), curvature
edge gain (×8), wear rim cap (0.9), splotch noise seeds, dust/grime tint
strength, final lift (1.35/+0.04). texture-baker knobs: `--aa`, `--ao-rays`
(default 128), `--dilation`, `--curvature-method mesh|normals`.
