# Trap: non-unit bone quaternions run away exponentially on extreme aim pitch

Symptom: `GLITCH:model-stretch` in the Alt+Q census —
`{"variant":"brawler","clip":"Jump_air","state":"ski","spread":11915202224544,"bones":"head_leaf↔ball_leaf_r"}`.
Finger/head leaf bones measured ~1e10–1e13 m apart inside one skeleton.
User report that pinned it: "when I aim totally up or totally down the
models glitch out and stretch."

## The mechanism

`PoseControl.update` (`client/src/entities/playerPose.ts`) applies
procedural aim pitch by post-multiplying `bone.quaternion` on the aim
bones (head 0.4, spine 0.6). That block only runs when `procPitch ≠ 0` —
pitch beyond the ±0.95 rad (~54°) the masked `Pistol_Aim_*` layer covers.
Inside the covered range `procPitch` is exactly 0 and nothing writes, so
the bug is invisible until near-vertical aim.

The multiply itself is fine math (`last = W⁻¹·P·W`, world-space pitch as a
local post-multiply). The killer is that `bone.quaternion` is never
re-normalized afterward. A |q| of even 1.001 is not a tilt error — in
`Matrix4.compose` a non-unit quaternion acts as scale `|q|²` on the bone's
whole subtree, so `matrixWorld` picks up a growing basis. Next frame
`getWorldQuaternion → matrixWorld.decompose` reads the inflated basis
back, the un-apply/apply round-trip and the mixer `orig` capture both see
the inflated value, and the error compounds **exponentially**. Measured
live on `head`: |q| 1.0000 → 3.29 in ~35 frames at procPitch ≈ −0.76 rad.

Bisection that proved it (`_tools/_bisectprobe.ts`, pitch sweep on
posedump):

- `pose.aimBones = []` → max spread 2.7 m, clean
- `steadyBones`/`locoBones`/`holdBones` emptied individually → still
  exploded (1e4 m)
- all layers off → clean

Only the aim-pitch write is necessary and sufficient. Clip keys are all
unit (`_tools/_quatcheck.ts`) — the seed is runtime fp/decompose drift,
never pinned exactly, but irrelevant once the output is normalized.

## Fix

`.normalize()` after both procedural quaternion writes in
`PoseControl.update` — the aimBones `multiply` and the holdBones
`slerp+multiply`. Quaternion normalize is ~free and only runs while the
layers are active.

## Repro / verification

`_tools/_stretchprobe.ts` — launches
`posedump.html?pmodel=<variant>&state=<state>` headless (needs
`E2E_GPU=1`), sweeps `setRotation` pitch −3.1…3.1 rad, measures max
world-space bone spread per pitch (same math as `auditStretch`).
Before fix: 8.5e9 m at pitch −1.2/−0.8 on brawler ski. After: ≤3.3 m on
brawler AND brute across the full range, zero glitch lines.
`_tools/_stretchprobe3.ts` catches the exploding frame and dumps the
bone's ancestor chain; `_tools/_quattrace2.ts` prints |q|/|last| per
frame (the runaway curve).

## Rules of thumb

- **Any procedural write into `bone.quaternion`/`position`/`scale` must
  leave it canonical** — quaternion normalize, or the skeleton's
  matrixWorld silently becomes a scale matrix and every descendant is
  flung. THREE never normalizes for you; `multiply`/`slerp` of unit
  inputs stays ~unit, but one bad input poisons forever.
- `matrixWorld.decompose`-derived quats (`getWorldQuaternion`) are unit
  only while the basis is orthogonal — once scale creeps in they launder
  the corruption instead of rejecting it. Don't trust them as a clean
  reference inside a feedback loop.
- The `model-stretch`/`model-offset` canaries (`PlayerModel.auditStretch`)
  are the detector — they caught this in the field. When one fires,
  `_stretchprobe.ts` reproduces in seconds; don't diagnose from the log
  line alone.
- Pose-layer writes compose on top of mixer output every frame — anything
  that can drift must self-heal per frame (normalize), not accumulate.
