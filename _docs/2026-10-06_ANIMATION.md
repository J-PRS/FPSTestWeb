# Humanoid Animation — how the rigs, clips, and bake fit together

Written 2026-10-06 after auditing the class-body clip inventory.
Reference doc for touching player/bot bodies.

## Architecture

```
source anim packs        rig GLBs                per-variant pack          runtime
─────────────────        ─────────               ──────────────────        ────────
robot-anims.glb   ┐                              assets/anims/
robot-anims2.glb  ├─ retarget+resample ──►  <variant>.glb  ──► PlayerModel
kevdev-anims.glb  ┘   (bakeUALClips,             (armature-only,            (binds clips
                       offline via              named-joint tracks)        by name)
                      _tools/animbake/bake.ts)
```

- `playerClips.ts` is the table file: `RIG_MANIFEST` (one row per body),
  `ANIM_NAMES` (state → clip-name fallbacks), bone maps, `CLASS_BODY_VARIANT`
  (armorClass → rig).
- `playerUal.ts` is the retarget machinery: `SPECS` (source pack → boneMap +
  hip conventions) and `bakeUALClips()` — runs offline via
  `_tools/animbake/run.mjs`, falls back to runtime bake if the pack is missing.
- `PlayerModel.ts` consumes: loads rig GLB → prefers `assets/anims/<variant>.glb`
  → falls back to `ANIM_NAMES` native clips → drives `PoseControl` per state.

## State set (the contract)

`AnimationState`: `idle walk run jump death ski jet hit shoot throw`.
Krunker-grade — keep it this small. Every rig must resolve all ten states
through `anims` (native names) or the retarget bake; unresolved states fall
through `ANIM_NAMES` fallbacks (`'Punch'`, `'Walking'`...) which most class
rigs don't ship → warn + frozen last pose.

## Per-rig clip inventory (measured 2026-10-06)

| variant | class | native clips in GLB | baked pack | notes |
|---|---|---|---|---|
| `scifisoldier` | light | 26 — covers all states (`*_Rifle` family) | **empty** | relies entirely on natives; no `clipYawFix` — check facing |
| `cybersoldier` | medium | **zero** | 43 retargeted | 100% retarget (`kevdev`+`mannequin` maps, `clipYawFix: π`) — most fragile rig |
| `vexa` | (unassigned) | ~9 non-locomotion | 21 loco | kevdev supplies all locomotion |
| `polyart` | heavy | 16 — full set + `WalkLeft/Right/Back_Shoot_ar` strafes | 21 loco | native table `POLYART_ANIMS` + `walkDirs` |
| `knight` | — | native | 21 loco | same bone names as robot |
| `mannequin` | — | IS the UAL library (`ualAlias`) | 21 loco | canonical rig — everything aliases to it |
| `robot` | — | 16 native | 46 (all 3 sources) | original retarget target |

`class_*.glb` are **paid UAS assets — gitignored** (`client/public/assets/
models/class_*.glb`). They must exist locally for class bodies to load;
the animbake needs them in `client/public/assets/models/` too.

## Conventions that bite

- `yaw` in RIG_MANIFEST is *authored* forward vs game -Z; `clipYawFix` is
  the *retarget-source* hip convention correction. They're different axes
  of wrongness — a rig can have right yaw and still play clips facing
  backward. Verify empirically with posedump screenshots — cyber's
  correct value turned out to be `0`, not the manifest's original `π`.
- `fitH` fits model height to the capsule eye — the silhouette IS the
  class. `fixedScale` is only for authored proportions (robot).
- Bone matching is name-sanitized lowercase-alphanumeric (`normBone`) —
  Blender `.L`/`.R`, UAL `DEF-*`, UE names all normalize through it.
- Handled mount quirk lives in `mount:` — bone-space `quat` for palm
  mounts, `world: true` for rigs with sheared bone chains (polyart).

## Gun mounts: palm-line vs authored quat (2026-10)

Rig `mount:` in `playerClips.ts` picks one of three seats:

- `palms` — **palm-line mount (preferred)**. Seat = the grip palm (the
  `mount.bone` override or the auto-detected right palm), barrel axis =
  the live `grip → foregrip` palm line recomputed every frame. No authored
  quat — it can't drift when a clip's hand basis differs, which is why
  polyart's solved quat kept presenting the gun outside the hands.
- `world` — prop parents to the model root, tracks bone world transform +
  authored `quat`/`pos`. For rigs whose non-uniform armature scale shears
  a bone-parented prop.
- default — bone-parented with `quat`/`euler` + `pos`/`size`/`fat`.

Palm-mount knobs:

| Field | Meaning |
|---|---|
| `palmFwd` | Metres to slide the seat along the barrel — the gun's origin is mid-gun, so seat ≈ half-gun-length forward of the rear palm puts the butt in the grip |
| `palmYaw` | Radians around model-up to swing the muzzle sideways (±~0.25 visible) |
| `palmUp` | Metres to lift the seat — palms seat inside the fist, ~0.05 rides on the grip |
| `palmsFlip` | Invert the palm line for rigs whose resolved grip is the FORE hand |
| `pos` | Bone-space nudge on the seat |
| `size` | Prop scale (polyart 1.3) |

Palm-line guard: `|dir.z| < 0.15` falls back to model forward — hand
splits (one-hand clips) give lateral axes; **either z sign is valid**,
rigs grip both handednesses (polyart's line runs +Z). Grip handedness:
resolve which palm is rear — `Hand_Right` z=−0.42 vs `Hand_Left` z=+0.94
means right=rear, foregrip=left.

Debug loop: `posedump.html?pmodel=<variant>&state=idle` exposes
`window.__pm` and `__cam` — `heavygun-top.js`/`heavygun-shot.js` in
headless-test are the seat/dump scripts; palm fields are settable at
runtime (`pm.gunPalmYaw = x`) for sign sweeps before committing.

## Directional locomotion: the root-yaw problem (2026-10)

Directional stride clips (kevdev `Walk01_*`, `Run01_*`, `Sprint01_*`
packs; Mixamo `Left/Right/Backward` families) are authored two ways:

- **Facing-frame clips** — body keeps one facing, legs supply the
  lateral/back footwork. This is what a blendspace wants: the controller
  owns yaw (the aim), the clip owns gait.
- **Travel-frame clips** — the hips carry a ~180° (or 90°) yaw so the
  character physically turns toward travel. Right for a turn-in-place
  system, wrong for an FPS where the body must stay on the aim.

Kevdev's directional set is travel-frame: playing it raw pivots the
whole rig (the "tomb raider" strafe).

### What engines do (researched 2026-10)

- **Unity** — *Root Transform Rotation / Bake into Pose*. Root yaw is
  extracted from the clip and pinned to a fixed facing; the controller
  owns actual heading. The docs call out strafing explicitly as the case
  where the body-forward heuristic fails and an offset is required.
- **UE blendspaces / Babylon `RootMotionSource.Root`** — hip travel AND
  yaw are treated as root motion to *extract*, not pose to keep.
- **Layered masks** (UE linked layers, Unity avatar masks; the V Rising
  writeup) — legs layer owns direction, upper-body layer owns aim; when
  the pelvis convention differs they hang a proxy joint under the root
  to carry the chest reference.

### Robust fix for our pipeline

Per-key yaw normalization **at bake time** (`_tools/animbake/bake.ts`),
NOT a runtime modal vote:

1. For each directional clip's hip quat track, compute the hip-forward
   XZ yaw **per key** in the hip's parent frame (static armature
   transform — never pose-derived).
2. Premultiply each key by the rotation bringing that key's yaw to the
   canonical facing (+Z for mannequin). Per-key — not one delta from
   frame 0 — so intra-clip pelvis sway survives while facing pins.
3. Re-enable the directional candidates the runtime now skips for
   `mannequin` (see `clipCandidates` — it currently falls back to
   reversed-walk + strafe lean).
4. Verify with the hip-yaw probe (`headless-test/hipyaw.js`): every
   `UAL_{Walk,Run,Sprint}01_*` clip must measure ~0°, not ±180°.

### What NOT to do (measured, 2026-10-06)

`alignHipYaw()` corrects hip-yaw outliers by voting a modal canonical
across the clip set — fine when one bad clip disagrees with a consistent
family (polyart `Idle_Ducking_ar`). On mannequin the kevdev directional
set is ~21 clips vs ~20 natives — the vote is a coin flip, and whichever
hemisphere wins, half the locomotion set gets rotated the wrong way.
Single-delta-from-first-key also can't fix clips whose pelvis yaw isn't
constant. Reverted; the gate stays `CLASS_BODY_SPEC`-only until the
bake-side normalization lands.

Runtime workaround in place: mannequin skips directional candidates →
backpedal = reversed forward loop (`setLocomotionReversed`), strafes =
forward loop + `setBodyLean` roll, aim layer keeps the upper body on
target. Legs read as forward gait during strafe — acceptable but not
the authored strafe footwork.

## Transitions: the T-pose rule (2026-10 fix)

**Never let total running action weight drop below 1.** The mixer fills
the uncovered fraction of a bone with the *bind pose* — a T-pose flash
on screen. Symptom: mashing shoot/throw or sweeping locomotion dirs
(every 8-sector dir is a fresh crossfade) flashes bind pose.

Root cause: `AnimationAction.fadeIn(d)`/`fadeOut(d)` schedule hardcoded
`0→1` / `1→0` weight interpolants. Re-firing an action that's already
mid-fade snaps its weight to 0 first, then ramps back — those frames are
partially uncovered.

Solution in `PlayerModel`: a manual fader, no private APIs.

- `fades` map `{action → {from, to, t, dur}}`, stepped in `update()`
  via `setEffectiveWeight` — public API only, upgrade-safe.
- `fadeAction(a, to, dur)` captures `getEffectiveWeight()` as `from`
  and `stopFading()` clears any pending three interpolant, so the manual
  ramp is the only weight driver. Re-fires ramp from wherever the action
  currently is — weight curves stay continuous under spam.
- Fades to 0 end with `a.stop()` to free bindings (same contract as
  three's weight-0 auto-disable). Stale entries self-prune: the update
  loop drops fade-to-1 entries on actions that got `stop()`ed elsewhere
  (the frozen/distal `setEffectiveWeight` swap path).

Verification: `headless-test/spam-probe.js <variant>` dumps running
actions + weights per transition — 12 shoot/throw alternations + dir
sweep must show zero sampled frames with coverage < 1.

## Adding or fixing a rig

1. Drop the GLB in `client/public/assets/models/`, add a RIG_MANIFEST row
   (url, yaw, fitH/fixedScale, anims if it ships clips, sources if it
   needs retarget).
2. If it needs retarget: add/verify a bone map in playerClips.ts, add the
   variant to `_tools/animbake/bake.ts` RIGS, run `node _tools/animbake/run.mjs`.
3. Verify: `classlineup_test.html` (all three classes side by side),
   `posedump.html` (per-clip pose inspection), `animCoverage.test.ts`
   (which states resolve per rig).

## Tribes clip checklist — essential → optional

Ranked by how much a wrong/missing clip hurts readability in a Tribes
fight (fast movers at range, silhouette must announce what a body is
doing):

| # | State(s) | Why it ranks here |
|---|---|---|
| 1 | `death` | The kill payoff — no death clip = corpses standing. Highest. **Alternatives that already work here:** gibs — `PlayerModel.deathParts()`/`buildGibParts` bakes posed body-part fragments that scatter under gravity (the splash-damage death), and corpse-clamp exists (`CLASS_BODY_DEATH_CLIPS`). A rig with no death clip can still die readably via gib scatter — the clip is only strictly needed for the intact-body fall. |
| 2 | `run` + directional `walk` (fwd/back/left/right/diagonals) | Ground movers are 90% of what you see. Directional strides matter for strafe-reads (polyart's `WalkL/R/Back` is the model). |
| 3 | `shoot` | Reads intent — you dodge the windup, not the tracer. |
| 4 | `ski` | THE Tribes silhouette — tuck/crouch glide. A standing-skier looks broken even if the sim is right. |
| 5 | `jet` | Airborne thrust pose; pairs with ski for the flight arc read. |
| 6 | `jump`/`land` | Jump-start + landing absorb — sells weight. |
| 7 | `idle` | Cheap, but a permanently T-posed spawn area reads broken. |
| 8 | `hit` | Damage feedback on the victim — small flinch, big value. |
| 9 | `throw` | Belt/grenade release — the flag toss and disc-throw share it. |
| 10 | `melee` | Basher/knife swing — only matters if melee is a real weapon. |
| 11 | Aim-pitch (additive spine/head) | Not a clip — a per-frame bone override we already do (`aimPitch`). Half-body aim is what sells "looking up/down slope". |

Forgotten ones that are actually needed: `hit`, `death`, `land`, and
idle. `ski` is missing from the list you gave but is non-negotiable for
the genre. Nice-to-haves past this: crouch-walk, taunt, carry-flag pose,
reload (we don't reload).

## The strategic shortcut (research, 2026-10)

The fragile part is our hand-written bone maps. The industry pattern for
"just make humanoids animate":

- **Standardize on one skeleton** — the mannequin rig IS the UAL library.
  Re-rigging a broken class body onto that skeleton in Blender once
  (copy bone names/weights) kills its retarget dependency permanently.
- **Auto-rig** — Mixamo/AccuRIG upload → returns a standard skeleton +
  clip library access; cheaper than debugging a bone map when a rig is
  deeply off-convention.
- **Drop-in retargeters** — `@three-ws/retarget` or
  `upf-gti/retargeting-threejs` do canonical-skeleton retargeting with
  rest-pose + hip-axis correction built in; candidate replacement for the
  hand maps if they keep drifting.
