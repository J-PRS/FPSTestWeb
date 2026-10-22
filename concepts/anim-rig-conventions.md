# Animation rig conventions — facing lives in the clips, not the code

`model.rotation.y` is the only rotation the game owns. Everything else —
which way the body actually faces — is baked into per-clip hip tracks by
whoever authored or retargeted them. Different packs disagree: the M2M
set spans −162°..+180° hip yaw across 32 clips.

## The machinery

- `RIG_MANIFEST` (playerClips.ts) — one row per body: GLB, capsule fit,
  `yaw` (authored forward vs game −Z), `clipYawFix` (unconditional unwind
  for pure-bake rigs), `anims` state→clip map, `walkDirs` 8-way table,
  gun mount.
- `alignHipYaw()` — load-time pass that measures each clip's hip facing,
  takes the modal yaw as the rig's convention, and unwinds outliers
  (>~30°) onto it.
- `class bodies` — armorClass → variant (`scout`/`brawler`/`brute`),
  silhouette IS the class; `anims` tables map states to native clips.

## The rule that bit us (2026-10-22 trap doc)

Measure orientation in the frame you correct in. Local-quat yaw ≠ world
yaw whenever an ancestor carries rotation — M2M rigs parent `pelvis`
under a `root` node baking Blender's −90° X flip, so local deltas and
the world-space `RotY` fix diverged nonlinearly. `alignHipYaw` now
measures the world-Y twist of `parentQ × key`, which the premultiply
shifts 1:1. Any ancestor with a non-Y rotation (armature flips, unit
conversion, mirrored rigs) re-opens this class of bug — check the chain
before trusting a local measure.

## Adding a rig = one manifest row + verification

1. Drop the GLB in `public/assets/models/` (meshopt-compress it).
2. One `RIG_MANIFEST` entry: url, fitH, yaw, anims/walkDirs, mount.
   `sources: []` if it self-animates; name a bake source map if clips
   must be retargeted.
3. Verify facing per state — don't eyeball one pose:

   ```
   node _tools/_clipyaw.mjs <file>.glb      # raw hip yaw per clip
   node _tools/_alignsim.mjs <file>.glb     # what alignHipYaw will do
   posedump.html?pmodel=<variant>&state=<state>  # real PlayerModel, live
   ```

4. Per-state world-yaw spread should be small (±15°, mid-pose sway) —
   per-state offsets of 45°+ mean the canonicalization failed.

## Debug surface

`posedump.html` drives the real `PlayerModel` (load, bake, align, aim
layer — everything) headless-screenshot-able per state/variant/dir.
`headless-test/pose-yaw.js` + `pose-shots.js` script the whole sweep.
