# Player Animation Research — RobotExpressive, CC0 alternatives, blending, IK

Date: 2026-10-02. Question: does RobotExpressive cover basic Tribes anims, should we
swap the model, and is IK / procedural blending feasible in this stack?

## 1. What RobotExpressive actually gives us

`client/public/assets/models/RobotExpressive.glb` ships 14 clips:

`Dance, Death, Idle, Jump, No, Punch, Running, Sitting, Standing,
ThumbsUp, Walking, WalkJump, Wave, Yes`

Mapped today (`PlayerModel.ts` ANIM_NAMES):

| Game state | Clip        | Honest verdict |
|------------|-------------|----------------|
| idle       | Idle        | fine           |
| walk       | Walking     | fine           |
| run        | Running     | fine           |
| jump/fall  | Jump (ping-pong @0.35x) | workable — reads as air-flail |
| ski        | Sitting     | decent tuck, zero directional lean |
| hit        | No          | cheesy but works |
| shoot      | Punch       | wrong silhouette for a rifle |
| death      | Death       | replaced visually by gibs anyway |

**Missing for a Tribes game:**
- No strafe/lean (no directional locomotion set — it's emotes + one run cycle)
- No aim-down-sights / weapon-hold pose (we bolt a gun to `Palm2R` and pitch
  `Head`+`Abdomen` procedurally — already half-procedural)
- No jetpack pose, no real crouch-tuck, no reload, no "flying" silhouette
- No strafe-run blend — a bot strafing looks like it runs forward

The rig itself is a proper humanoid skeleton (Head/Abdomen/Palm2R + limbs —
`buildGibs` found real arm/leg/head bones), so it *can* be animated; the clip
set is the limitation, not the rig. Bone names are custom (`Palm2R`, not
Mixamo's `RightHand`), which matters for retargeting below.

## 2. CC0 model alternatives

Researched options:

- **Quaternius Universal Animation Library** (CC0, Mar 2025): 120+ animations
  on a universal humanoid rig — 8-dir locomotion, jog/sprint, crouch, swim,
  gun aim/fire/reload, deaths, emotes. glTF exports exist. This is the single
  best free "full action tree" source. Designed for the Quaternius Universal
  Base Characters (13k tris, humanoid rig, CC0) but retargetable.
- **Quaternius Robot/Animated packs**: robot characters that fit our art
  direction better than humans — worth checking `Robot` / `Ultimate Animated
  Character Pack` for a rigged robot.
- **Kenney Animated Characters** (CC0): only 3 clips (idle/jump/run) —
  strictly worse than what we have.
- **Mixamo**: huge free anim library BUT license is Adobe "royalty-free for
  use in your project" — not CC0, fine for a shipped game, asset can't be
  redistributed raw. Via `SkeletonUtils.retargetClip` (three.js has an
  official Mixamo→readyplayer.me retarget example), Mixamo clips can drive
  RobotExpressive — needs a bone-name map (`names: {mixamorigHips: 'Root', ...}`)
  and expects ~an afternoon of tuning (forum reports: hip scale, position
  tracks, orientation quirks).

**Recommendation:** keep the robot silhouette (it's charming and matches the
game), but source the *animation set* from the Quaternius UAL or Mixamo via
retargeting. If we ever want human players, Universal Base Characters + UAL
is a complete drop-in.

## 3. Blend tree / state machine options

Current system: single `AnimationAction` crossfade (`fadeIn/fadeOut 0.2`) +
one-shot loop modes. Adequate today, won't scale to directional locomotion.

Options:
- **animouse** (`jango-git/animouse`, TS, MIT-ish): purpose-built Three.js
  animation state machine — 1D linear blend trees (speed axis), 2D polar
  (direction), freeform Delaunay blend trees, transition config. Closest to
  a Unity anim graph for three.js. Small dep, ~zero risk.
- **three-blendtree** (`jmschrack`): minimal Unity-style BlendTree1D/2D —
  thinner, but literally ~200 lines, could be vendored.
- **DIY 1D blend**: `weights = barycentric(speedAxis, [idle, walk, run])` +
  `setEffectiveWeight` — trivial for speed-only blending (~30 lines). For a
  Tribes game most of life is airborne anyway; the 1D speed blend + a
  airborne/ski state covers 90% of what players see on remotes.

**Recommended state set for our game** (smaller than you think — skiing
replaces most ground states):
`idle | groundLocomotion(1D speed blend) | airborne(pitch-lean) | ski/tuck |
strafe(lean additive) | death(gibs) | fire overlay | hit overlay`

Only `fire`/`hit` need to be *overlays* (additive on upper body) — three.js
supports per-bone-track clips, so a "Punch" trimmed to arm bones works as an
additive fire anim; or keep the procedural gun recoil (already done) and skip
a fire anim entirely — nobody sees a remote's recoil anim at 100m anyway.

## 4. IK — feasible, and two real use cases

### Weapon holding (hand IK)
Already 80% done procedurally: gun parents to `Palm2R`, pitch applied to
Head/Abdomen. To make the *off-hand* grip the foregrip or the arm raise to
shoulder height when aiming up: use **`CCDIKSolver`** (ships in
`three/addons/animation/CCDIKSolver.js`, used by the official
`webgl_animation_skinning_ik` example). Chain: UpperArm→LowerArm→Hand,
target = a helper bone we move procedurally. Runs after `mixer.update()` —
same pattern as our `aimBones` un-apply trick. Per-remote cost is small
(CCD is a few quaternion rotates per link per iteration, ~1-10 iterations).

### Foot IK on slopes
The cool one: raycast (well, `terrain.getHeight`) at each foot bone's XY,
plant feet on the ground, bend knees via CCD. Caveats for US specifically:
- Remotes are mostly **airborne/skiing** — foot IK only matters when
  standing/grounded. Apply it only when `onGround && speed < threshold`;
  in air, switch to the tuck.
- RobotExpressive legs are short/stubby — foot-plant gains are modest;
  a **whole-body slope tilt** (rotate hips to terrain normal + crouch the
  downhill leg) reads 80% as good for 10% of the work.
- `threejs-easybugs` (bandinopla) does multi-leg CCD IK + gait for critters
  — useful reference code if we ever want it for crawlers, overkill for
  bipeds.
- CCDIKSolver gotcha (from forums): links list goes child→parent, target
  bones must be parented to the mesh, and joints need `limitation` clamps or
  knees bend sideways. Budget half a day of tuning.

### Verdict on IK
- **Now:** keep the procedural gun + pitch; add a two-bone arm IK or just a
  better shoulder pitch distribution. Cheap, zero deps.
- **Slope feet:** implement terrain tilt + downhill-leg crouch first
  (procedural, ~40 lines, we already raycast terrain every frame for bots).
  Full foot IK only if a humanoid model swap makes legs worth the polish.

## 5. Suggested path

1. **Keep RobotExpressive** — retarget, don't replace. Its stubby charm is
   part of the game's look, and gibs/hit flash/aim-bones are already tuned
   to its rig.
2. **Pull a real clip set**: Quaternius UAL (CC0, safe to ship files) or
   Mixamo→`retargetClip` with a name map. Needed clips: strafe L/R,
   crouch-ski tuck, aim/fire overlay, fall-loop, sprint. That kills the
   `Sitting`-as-ski hack and gives the gun a hold pose.
3. **Upgrade state selection to a 1D speed blend + airborne state**
   (vendored three-blendtree or 30 DIY lines). Anim FSM stays in
   `RemotePlayer` — wire state already carries speed/onGround.
4. **Slope alignment**: procedural hip tilt to terrain normal when grounded.
5. **Optional later**: CCDIKSolver arm chain for proper two-hand weapon
   hold; foot IK only if a leggier model lands.

## References
- three.js `CCDIKSolver`: threejs.org/docs → animation/skinning_ik example
- `SkeletonUtils.retargetClip` + Mixamo example:
  `examples/webgpu_animation_retargeting_readyplayer.html`
- Quaternius Universal Animation Library: quaternius.com (CC0)
- animouse: github.com/jango-git/animouse
- three-blendtree: github.com/jmschrack/three-blendtree
- threejs-easybugs (leg IK ref): github.com/bandinopla/threejs-easybugs
