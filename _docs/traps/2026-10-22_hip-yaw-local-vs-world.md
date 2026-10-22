# Trap: hip-yaw alignment measured local quats on a rig whose parent is pitched

Symptom: player bodies faced different directions per anim state — walk
sat ~45° left of travel, ski ~45° right, airborne ~135° right. The gun
(socketed on the model root) always pointed true, so the offsets were
baked inside the clips, not in `model.rotation.y`.

## The mechanism

`playerAnim.alignHipYaw()` canonicalizes each clip's hip-track facing by:
measuring the frame-0 hip yaw, taking the set's modal yaw as the rig's
forward convention, and premultiplying a `RotY(-delta)` fix in the hip's
parent frame (a world-space yaw correction).

The M2M rigs (`class_scout/brawler/brute.glb`) parent `pelvis` under a
`root` node that bakes Blender's Z-up→Y-up conversion as a **-90° X
rotation**. `yawOf()` read the raw local quat's +Z yaw — in that pitched
frame, local-yaw deltas between clips are NOT the world-yaw deltas the
`RotY` fix applies. Corrections landed at wrong magnitudes: `Walk` went
175°→106° local instead of the canonical −124°, and rendered facing
still scattered ±60–125° by state.

On `polyart`/`class_heavy` the parent happened to be identity — the same
code "worked" there by accident, which is why the bug looked like a data
problem in the new rigs rather than a math bug.

## Fix

Measure yaw in the frame the correction acts in. `worldYawOf()` computes
the twist about world Y of `parentQ * keyQuat`; a world `RotY(δ)`
premultiply shifts that measure by exactly δ, so modal-canonical voting
and per-clip deltas are consistent under any parent orientation.
Verified live via `posedump.html?pmodel=<variant>&state=<state>` +
pelvis world-yaw readback: scout went from [-125..+60]° spread to
[-13..-1]° across idle/walk/run/ski/jump/jet.

## The trap, generalized

Any time you compare or equalize per-keyframe orientations by reading a
bone's LOCAL quaternion, check the parent chain first. If any ancestor
carries a non-identity rotation (armature flips, unit-conversion nodes,
mirrored rigs), local-quat angles and world-space corrections diverge
nonlinearly — the fix will *do something*, look plausible, and still be
wrong. Measure in the frame you correct in.

Same class of bug to watch for: `clipYawFix` (unconditional unwind for
pure-bake rigs), any retarget code that sums local yaw across rigs, and
bone-space gun mounts evaluated against world-space aim.

## Debug tools that made this cheap

- `_tools/_clipyaw.mjs` — dumps frame-0/range hip yaw per clip per GLB
  (three.js + meshopt in node, no Blender needed).
- `_tools/_alignsim.mjs` — replays the canonical/delta math offline.
- `_tools/_tracknodes.mjs` — lists non-bone quat tracks + parent chain.
- `headless-test/pose-shots.js` / `pose-yaw.js` — screenshot or measure
  rendered pelvis world yaw per state through real `PlayerModel` load,
  bake and all.
