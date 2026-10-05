/**
 * playerClips — animation clip tables + bone-name maps for PlayerModel.
 * Pure data: which clip plays for each state per rig variant, and which
 * source-rig bone feeds each target-rig bone during retargeting.
 */
import * as THREE from 'three';

export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'death' | 'ski' | 'hit' | 'shoot' | 'jet' | 'throw';

// 8-way facing-frame direction. atan2(side, fwd): 0=F, +90°=R, ±180°=B.
export type LocoDir = 'F' | 'FR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'FL';
export const DIR8: LocoDir[] = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
export const DIR_SUFFIX: Record<LocoDir, string> = {
  F: 'Forward', FR: 'ForwardRight', R: 'Right', BR: 'BackwardRight',
  B: 'Backward', BL: 'BackwardLeft', L: 'Left', FL: 'ForwardLeft',
};

// Map our states to clip names. UAL_* clips are retargeted at load from the
// Quaternius Universal Animation Library (CC0) — the robot's native set is
// an emote pack (Dance/Wave/Yes...) with no aim, crouch, or fall poses.
// Each entry falls back to the native clip if retargeting didn't run.
export const ANIM_NAMES: Record<AnimationState, [ual: string, fallback: string]> = {
  'idle':   ['UAL_Idle_Loop',         'Idle'],
  'walk':   ['UAL_Jog_Fwd_Loop',      'Walking'],
  'run':    ['UAL_Sprint_Loop',       'Running'],
  'jump':   ['UAL_Jump_Loop',         'Jump'],
  'death':  ['UAL_Death01',           'Death'],
  // Crouch_Fwd is a real tucked ski silhouette — knees bent, weight low —
  // a straight upgrade over Sitting-as-tuck.
  'ski':    ['UAL_Slide_Loop',        'Sitting'],
  // Plain airborne hang — the NinjaJump tuck read too goofy for a jet
  // burn; the sternum lean layer is what sells thrust direction.
  'jet':    ['UAL_Jump_Loop',         'Jump'],
  'hit':    ['UAL_Hit_Chest',         'No'],
  'shoot':  ['UAL_Pistol_Shoot',      'Punch'],
  // Belt throw / deploy swing — UAL2 is the only source that ships one.
  'throw':  ['UAL_OverhandThrow',     'Punch']
};

// Quaternius Knight_Male (CC0) — real-proportioned heavy silhouette on
// the same bone names as the robot. Native clips, no retarget; the Roll
// tuck doubles as the ski pose.
export const KNIGHT_ANIMS: Record<AnimationState, string> = {
  'idle': 'Idle', 'walk': 'Walk', 'run': 'Run',
  'jump': 'Jump', 'death': 'Death', 'ski': 'Roll',
  'jet': 'Jump', 'hit': 'RecieveHit', 'shoot': 'Shoot_OneHanded',
  'throw': 'Punch',
};

// UAS class bodies (paid packs) — each GLB bakes its own clip set on its
// own rig, so clips bind natively with no retarget. Vexa ships clips for
// every NON-locomotion state (idles, jumps, death, damage, gunshots) but
// zero run/walk: her GLB names them on the ANIM_NAMES fallback slots and
// kevdev supplies locomotion via VEXA_KEVDEV_BONE_MAP below.
export const SCIFISOLDIER_ANIMS: Partial<Record<AnimationState, string>> = {
  'idle': 'Idle_Rifle', 'walk': 'Walk_Rifle', 'run': 'Run_Rifle',
  'jump': 'Jump_Rifle', 'death': 'Death_Rifle', 'ski': 'CrouchingRun_Rifle',
  'jet': 'Jump_Rifle', 'hit': 'Hit', 'shoot': 'Fire_SniperRifle',
  // No overhand in the pack — the one-handed pistol arm swing is the
  // closest release motion; without it 'throw' falls through to 'Punch',
  // which this rig doesn't ship either (warn + holds last pose).
  'throw': 'Fire_1Pistol',
};
export const POLYART_ANIMS: Partial<Record<AnimationState, string>> = {
  'idle': 'Idle_gunMiddle_ar', 'walk': 'WalkFront_Shoot_ar', 'run': 'Run_gunMiddle_AR',
  'jump': 'Jump', 'death': 'Die', 'ski': 'Idle_Ducking_ar',
  'jet': 'Jump', 'hit': 'Idle_Shoot_ar', 'shoot': 'Shoot_SingleShot_AR',
  // No overhand in the GLB — Reload's two-handed body cycle reads as
  // the belt-throw/deploy windup; the Punch fallback doesn't exist here.
  'throw': 'Reload',
};

/** RIG_MANIFEST — one row per body variant: where it loads from, how it
 *  fits the capsule, which anim sources feed its retarget bake, and its
 *  native clip table when it ships one. Adding a rig = one entry here +
 *  one animbake run; nothing else in the codebase needs to know it
 *  exists. `fitH` fits the model's height to the capsule eye
 *  (scale = fitH/size.y); `fixedScale` is for authored proportions
 *  (robot) that were never capsule-fitted. */
export interface RigManifest {
  url: string;
  /** Far-LOD stand-in GLB on the same rig (decimated), if authored. */
  lodUrl?: string;
  /** model.rotation.y — authored forward axis vs the game's -Z. */
  yaw: number;
  fitH?: number;
  fixedScale?: number;
  anims?: Partial<Record<AnimationState, string>>;
  /** Prop-gun + muzzle anchor in model-space meters [x right, y up, z
   *  fwd(-)]. Foreign rigs keep bones in armature frames up to ~100
   *  units off the rendered body, so bone-mounted props can't be
   *  trusted — a fixed socket on the model root is predictable.
   *  Trade-off: the gun stays at chest-forward instead of tracking
   *  the hand, which reads as 'carried' rather than 'swung'. */
  gunLocal?: [number, number, number];
  /** Hand-bone mount (preferred over gunLocal when the rig exposes a
   *  usable palm bone — the gun rides the hand through any pose).
   *  bone: normalized palm key when the grip sits on a non-right hand.
   *  quat: hand-local orientation (xyzw) solved on the posedump loop —
   *    raw quats, not eulers: euler extraction is lossy under these
   *    bone spaces.
   *  euler: plain-euler rigs (mannequin/robot) where recoil composes
   *    through gunBaseX instead of a base quat.
   *  size: real-world gun meters (default 0.7). fat: cross-section
   *    multiplier for rigs whose silhouette shrinks the prop to a rod.
   *  pos: bone-space seat when the near-origin seat hides the receiver
   *    inside the fist. */
  mount?: {
    bone?: string;
    quat?: [number, number, number, number];
    euler?: [number, number, number];
    size?: number;
    fat?: number;
    pos?: [number, number, number];
    /** Parent the prop to the model root and drive it from the bone's
     *  world transform per frame — for rigs whose bone chain carries
     *  rotated non-uniform scale (shear no diagonal compensation can
     *  undo). pos/quat keep their bone-space meanings. */
    world?: boolean;
  };
  /** Post-bake facing fix: when a rig's retarget sources agree on a hip
   *  convention π off the rig's -Z, alignHipYaw adds this to the canonical
   *  target so the whole set unwinds onto the authored forward. */
  clipYawFix?: number;
  /** Directional walk strides the GLB ships natively (polyart's
   *  WalkLeft/WalkRight/WalkBack family). Only pure lateral sectors
   *  snap to the side clips — forward diagonals keep the forward
   *  stride (per JP: strafes are for actual strafing). */
  walkDirs?: Partial<Record<LocoDir, string>>;
  /** Native clips also register under their UAL_ alias (mannequin's set
   *  IS the UAL library). */
  ualAlias?: boolean;
  /** Anim-source ids (playerUal SPECS) this rig's retarget bake draws
   *  from — empty for native-only rigs. */
  sources: string[];
}
export const RIG_MANIFEST: Record<string, RigManifest> = {
  robot:        { url: '/assets/models/RobotExpressive.glb', yaw: 0, fixedScale: 0.5,
                  sources: ['ual1', 'ual2', 'kevdev'] },
  mannequin:    { url: '/assets/models/mannequin_opt.glb', lodUrl: '/assets/models/mannequin_lod1.glb',
                  yaw: 0, fitH: 2, ualAlias: true, sources: ['kevdev'],
                  mount: { euler: [Math.PI / 2, 0, 0] } },
  knight:       { url: '/assets/models/knight.glb', yaw: 0, fitH: 2, sources: [] },
  // All class rigs author facing -Z (the camera check showed backs at
  // the legacy π flip) — no yaw needed.
  // CyberSoldier ships zero clips — his set is 100% retarget: mannequin's
  // native UAL states via CYBER_MANNEQUIN_BONE_MAP + kevdev 8-way
  // locomotion via CYBER_KEVDEV_BONE_MAP.
  'scifisoldier': { url: '/assets/models/class_light.glb',  yaw: 0, fitH: 1.89, anims: SCIFISOLDIER_ANIMS, gunLocal: [0.22, 1.15, -0.35], sources: [],
                    mount: { quat: [-0.471, 0.1186, 0.0367, 0.5126] } },
  // Cyber+vexa are 100% retarget bakes — their source hip convention
  // lands facing +Z (toward the third-person camera), so the whole set
  // gets a π unwind onto the rig's -Z forward.
  'cybersoldier': { url: '/assets/models/class_cyber.glb',  yaw: 0, fitH: 2.2,  gunLocal: [0.28, 1.35, -0.45], sources: ['kevdev', 'mannequin'], clipYawFix: Math.PI,
                    // Bake ships no overhand clip — Pistol_Shoot's fast
                    // arm extension stands in for the belt throw.
                    anims: { throw: 'UAL_Pistol_Shoot' },
                    mount: { quat: [-0.4085, 0.3914, -0.0042, 0.8246] } },
  // Vexa fits 10% over her 2.0m capsule eye — slim anatomy reads small
  // next to the armored classes; the cap keeps the honest hitbox.
  'vexa':         { url: '/assets/models/class_medium.glb', yaw: 0, fitH: 2.2,  gunLocal: [0.26, 1.35, -0.45], sources: ['kevdev'], clipYawFix: Math.PI,
                    mount: { quat: [0.8778, -0.1951, -0.3364, -0.2796] } },
  'polyart':      { url: '/assets/models/class_heavy.glb',  yaw: 0, fitH: 2.76, anims: POLYART_ANIMS, gunLocal: [0.38, 1.7, -0.55], sources: [],
                    walkDirs: { B: 'WalkBack_Shoot_ar', L: 'WalkLeft_Shoot_ar', R: 'WalkRight_Shoot_ar' },
                    mount: { bone: 'handleft', world: true, quat: [-0.0171, -0.0844, -0.7012, -0.0297], size: 1.3, pos: [0, 0, -15] } },
};

// armorClass → dedicated body GLB, derived from the manifest — table
// presence marks the variant as class-native: the silhouette IS the
// class (no _classScale stack). A present `anims` table means the GLB's
// own clips drive it; vexa ships no table — her clips sit on the
// ANIM_NAMES fallback slots while the kevdev bake supplies UAL_*
// locomotion (VEXA_KEVDEV_BONE_MAP).
export const CLASS_BODY_SPEC: Record<string, {
  url: string; yaw: number; fitH: number;
  anims?: Partial<Record<AnimationState, string>>;
  gunLocal?: [number, number, number];
  mount?: RigManifest['mount'];
  walkDirs?: RigManifest['walkDirs'];
}> = Object.fromEntries(
  Object.entries(RIG_MANIFEST)
    .filter(([, r]) => r.fitH !== undefined && r.fixedScale === undefined && r.url.includes('/class_'))
    .map(([k, r]) => [k, { url: r.url, yaw: r.yaw, fitH: r.fitH!, anims: r.anims, gunLocal: r.gunLocal, mount: r.mount, walkDirs: r.walkDirs }]),
);

// armorClass from the wire → class-body variant. A mid-match re-fit swaps
// the whole GLB (RemotePlayer.setClass).
export const CLASS_BODY_VARIANT: Record<string, string> = {
  light: 'scifisoldier', medium: 'cybersoldier', heavy: 'polyart',
};

// Death clips per class body — corpse-clamp like 'Death'/'UAL_Death01'.
export const CLASS_BODY_DEATH_CLIPS = new Set(['Death_Rifle', 'Die', 'Death']);

// RobotExpressive bone → UAL source bone. RobotExpressive bones carry
// Blender names (UpperArm.L); UAL uses DEF-* (DEF-upper_arm.L). Both sides
// get name-sanitized by GLTFLoader, so matching is done on lowercase
// alphanumerics — see findSrcBones().
export const UAL_BONE_MAP: Record<string, string> = {
  Hips: 'hips',
  Abdomen: 'spine001',
  // GLTFLoader dedupes name clashes — the mesh under Body is 'Torso', the
  // spine bone got renamed 'Torso_1'.
  Torso_1: 'spine003',
  Neck: 'neck',
  Head: 'head',
  ShoulderL: 'shoulderl', UpperArmL: 'upper_arml', LowerArmL: 'forearml', Palm2L: 'handl',
  ShoulderR: 'shoulderr', UpperArmR: 'upper_armr', LowerArmR: 'forearmr', Palm2R: 'handr',
  UpperLegL: 'thighl', LowerLegL: 'shinl',
  UpperLegR: 'thighr', LowerLegR: 'shinr',
  // Foot.L/R are deliberately unmapped — they're IK-target bones detached
  // from the leg chain; feet get snapped to the shin tips procedurally.
};

// Same mapping against the UAL2 rig — v2 switched to UE-style bone names
// (thigh_l, upperarm_l, spine_01..03) and 'pelvis' for hips.
export const UAL2_BONE_MAP: Record<string, string> = {
  Hips: 'pelvis',
  Abdomen: 'spine01',
  Torso_1: 'spine03',
  Neck: 'neck01',
  Head: 'head',
  ShoulderL: 'claviclel', UpperArmL: 'upperarml', LowerArmL: 'lowerarml', Palm2L: 'handl',
  ShoulderR: 'clavicler', UpperArmR: 'upperarmr', LowerArmR: 'lowerarmr', Palm2R: 'handr',
  UpperLegL: 'thighl', LowerLegL: 'calfl',
  UpperLegR: 'thighr', LowerLegR: 'calfr',
};

// Clips that must not LoopRepeat — a flinch or a fire that loops reads as a
// twitch loop instead of a single reaction. Callers time-revert the state.
export const ONESHOT_CLIPS = new Set(['No', 'Punch', 'UAL_Pistol_Shoot', 'UAL_Hit_Chest', 'UAL_Hit_Head',
  // Knight-native singles — a fire/flinch that loops reads as a twitch.
  'Shoot_OneHanded', 'RecieveHit', 'Punch',
  // Class-body flinches + fires (Yurowm / SciFiWarrior clip names).
  'Hit', 'Damage1', 'Damage2', 'Damage3', 'Reload',
  'Fire_1Pistol', 'Fire_2Pistol', 'Fire_SniperRifle',
  'Shoot_SingleShot_AR', 'Shoot_BurstShot_AR', 'Shoot_AutoShot_AR',
  'UAL_OverhandThrow', 'UAL_Hit_Knockback']);

// Per-variant clip overrides — states whose ANIM_NAMES pair can't resolve
// on that rig. cybersoldier ski: mannequin's clip set has no Slide_Loop
// (UAL2 is robot-locked) and 'Sitting' isn't a mannequin clip either, so
// skis parked him on the idle loop — Crouch_Fwd is the same tuck the
// mannequin itself uses for ski. Mannequin's own specials live here too
// (armed idle, crouch-tuck ski) — overrides and specials were the same
// concept on two code paths.
export const VARIANT_CLIP_OVERRIDES: Record<string, Partial<Record<AnimationState, string | string[]>>> = {
  cybersoldier: {
    ski: 'UAL_Crouch_Fwd_Loop',
    // Same armed stance as the mannequin — his mannequin-source bake
    // ships Pistol_Idle; Idle_Loop dangles the socket-mounted gun.
    idle: 'UAL_Pistol_Idle_Loop',
  },
  mannequin: {
    // No native slide clip — the UAL2 retarget bakes limb-axis artifacts
    // on this rig, so ski rides the tucked Crouch_Fwd.
    ski: ['UAL_Crouch_Fwd_Loop', 'Crouch_Fwd_Loop'],
    // Default stance is armed — the relaxed Idle_Loop dangles the gun at
    // the thigh; Pistol_Idle holds it raised and reads as "in combat".
    idle: 'UAL_Pistol_Idle_Loop',
  },
};

/** Ordered clip candidates for (variant, state, dir) — the resolution
 *  cascade as data, shared by PlayerModel and the coverage test so the
 *  two can't drift. Try each in turn; the first name the loaded set has
 *  wins. `dir` marks dedicated locomotion strides (callers keep the
 *  reverse/lean fallbacks off while one drives). */
export interface ClipCandidate { name: string; dir: boolean }
export function clipCandidates(variant: string, state: AnimationState, dir: LocoDir): ClipCandidate[] {
  if (variant === 'knight') {return [{ name: KNIGHT_ANIMS[state], dir: false }];}
  const spec = CLASS_BODY_SPEC[variant];
  if (spec?.anims) {
    const out: ClipCandidate[] = [];
    // Rigs shipping directional strides (polyart's Walk* family) resolve
    // pure lateral/back sectors onto them — forward diagonals keep the
    // forward stride (strafe clips only for actual strafing).
    if (state === 'walk' && dir !== 'F' && dir !== 'FL' && dir !== 'FR' && spec.walkDirs) {
      const axis = dir === 'L' ? 'L' : dir === 'R' ? 'R' : 'B';
      const n = spec.walkDirs[axis];
      if (n) {out.push({ name: n, dir: true });}
    }
    if (spec.anims[state]) { out.push({ name: spec.anims[state]!, dir: false }); return out; }
    // States the table lacks (e.g. 'throw') fall through to the generic
    // UAL candidates — the baked pack carries them where the rig was
    // retargeted; missing clips resolve to hold-previous, not a snap.
  }
  const out: ClipCandidate[] = [];
  if (state === 'walk' || state === 'run') {
    if (dir === 'F') {
      // 'F' prefers the UAL jog/sprint; variants without it take the
      // kevdev forward stride instead of idling through the walk.
      out.push({ name: ANIM_NAMES[state][0], dir: false });
      for (const s of state === 'run' ? ['Sprint01', 'Run01'] : ['Walk01'])
        {out.push({ name: `UAL_${s}_Forward`, dir: true });}
    } else {
      // The Sprint set only covers the forward hemisphere — back-half
      // run sectors ride the Run clips.
      const fwdHemi = dir === 'FL' || dir === 'FR' || dir === 'L' || dir === 'R';
      const set = state === 'run' ? (fwdHemi ? 'Sprint01' : 'Run01') : 'Walk01';
      out.push({ name: `UAL_${set}_${DIR_SUFFIX[dir]}`, dir: true });
    }
  }
  const ov = VARIANT_CLIP_OVERRIDES[variant]?.[state];
  for (const n of ov === undefined ? [] : Array.isArray(ov) ? ov : [ov]) {out.push({ name: n, dir: false });}
  out.push({ name: ANIM_NAMES[state][0], dir: false }, { name: ANIM_NAMES[state][1], dir: false });
  return out;
}

// Mannequin (DEF-* Rigify rig) → UAL2 source bones. GLTFLoader strips dots
// from node names, so 'DEF-upper_arm.L' arrives as 'DEF-upper_armL'.
export const MANNEQUIN_UAL2_BONE_MAP: Record<string, string> = {
  'DEF-hips': 'pelvis',
  'DEF-spine001': 'spine01',
  'DEF-spine003': 'spine03',
  'DEF-neck': 'neck01',
  'DEF-head': 'head',
  'DEF-shoulderL': 'claviclel', 'DEF-upper_armL': 'upperarml', 'DEF-forearmL': 'lowerarml', 'DEF-handL': 'handl',
  'DEF-shoulderR': 'clavicler', 'DEF-upper_armR': 'upperarmr', 'DEF-forearmR': 'lowerarmr', 'DEF-handR': 'handr',
  'DEF-thighL': 'thighl', 'DEF-shinL': 'calfl',
  'DEF-thighR': 'thighr', 'DEF-shinR': 'calfr',
};

// Kevin Iglesias Human Basic Motions (free tier) — the directional
// locomotion source UAL's free packs lack (8-dir Walk/Run, 5-dir Sprint).
// B-* rig names arrive norm'd to 'bhips', 'bupperarml', etc.
// Values are prefix-free — bakeSource prepends spec.prefix ('b') when it
// looks nodes up, so 'bhips' here would resolve as 'bbhips' and match
// nothing. The B-* rig names arrive norm'd to 'bhips', 'bupperarml', etc.
export const KEVDEV_BONE_MAP: Record<string, string> = {
  Hips: 'hips',
  Abdomen: 'spine',
  Torso_1: 'chest',
  Neck: 'neck',
  Head: 'head',
  ShoulderL: 'shoulderl', UpperArmL: 'upperarml', LowerArmL: 'forearml', Palm2L: 'handl',
  ShoulderR: 'shoulderr', UpperArmR: 'upperarmr', LowerArmR: 'forearmr', Palm2R: 'handr',
  UpperLegL: 'thighl', LowerLegL: 'shinl',
  UpperLegR: 'thighr', LowerLegR: 'shinr',
};

// Mannequin DEF-* rig → kevdev B-* names (same targets as the UAL2 map).
export const MANNEQUIN_KEVDEV_BONE_MAP: Record<string, string> = {
  'DEF-hips': 'hips',
  'DEF-spine001': 'spine',
  'DEF-spine003': 'chest',
  'DEF-neck': 'neck',
  'DEF-head': 'head',
  'DEF-shoulderL': 'shoulderl', 'DEF-upper_armL': 'upperarml', 'DEF-forearmL': 'forearml', 'DEF-handL': 'handl',
  'DEF-shoulderR': 'shoulderr', 'DEF-upper_armR': 'upperarmr', 'DEF-forearmR': 'forearmr', 'DEF-handR': 'handr',
  'DEF-thighL': 'thighl', 'DEF-shinL': 'shinl',
  'DEF-thighR': 'thighr', 'DEF-shinR': 'shinr',
};

// `_N` tails are GLTFLoader dedupe suffixes (multi-skin GLBs repeat joint
// names), not authored bones — strip before normalizing.
export const normBone = (s: string) => s.replace(/_\d+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Vexa rig → kevdev B-* names. The Base_Human* chain is semantically 1:1
// with the robot's — extra limb segments (Upperarm2/3, digits, lash/eye
// helpers) stay unmapped and inherit their parent's motion.
export const VEXA_KEVDEV_BONE_MAP: Record<string, string> = {
  Base_HumanPelvis: 'hips',
  Base_HumanSpine1: 'spine', Base_HumanRibcage: 'chest',
  Base_HumanNeck: 'neck', Base_HumanHead: 'head',
  Base_HumanLCollarbone: 'shoulderl', Base_HumanLUpperarm1: 'upperarml',
  Base_HumanLForearm1: 'forearml', Base_HumanLPalm: 'handl',
  Base_HumanRCollarbone: 'shoulderr', Base_HumanRUpperarm1: 'upperarmr',
  Base_HumanRForearm1: 'forearmr', Base_HumanRPalm: 'handr',
  Base_HumanLThigh: 'thighl', Base_HumanLCalf: 'shinl',
  Base_HumanRThigh: 'thighr', Base_HumanRCalf: 'shinr',
};

// Polyart (class_heavy) rig → kevdev B-* names — the rig's loco pack is
// produced by the same retarget path as the other class bodies.
export const POLYART_KEVDEV_BONE_MAP: Record<string, string> = {
  Hips: 'hips', Spine: 'spine', Chest: 'chest', Neck: 'neck', Head: 'head',
  Shoulder_Left: 'shoulderl', UpperArm_Left: 'upperarml', LowerArm_Left: 'forearml', Hand_Left: 'handl',
  Shoulder_Right: 'shoulderr', UpperArm_Right: 'upperarmr', LowerArm_Right: 'forearmr', Hand_Right: 'handr',
  UpperLeg_Left: 'thighl', LowerLeg_Left: 'shinl',
  UpperLeg_Right: 'thighr', LowerLeg_Right: 'shinr',
};

// Polyart rig → UAL2 (robot-anims2, UE-style names normalized) — only the
// oneshot set feeds it (throw/knockback/slide/ninja), not locomotion.
export const POLYART_UAL2_BONE_MAP: Record<string, string> = {
  Hips: 'pelvis', Spine: 'spine01', Chest: 'spine03', Neck: 'neck01', Head: 'head',
  Shoulder_Left: 'claviclel', UpperArm_Left: 'upperarml', LowerArm_Left: 'lowerarml', Hand_Left: 'handl',
  Shoulder_Right: 'clavicler', UpperArm_Right: 'upperarmr', LowerArm_Right: 'lowerarmr', Hand_Right: 'handr',
  UpperLeg_Left: 'thighl', LowerLeg_Left: 'calfl', Foot_Left: 'footl', Toe_Left: 'balll',
  UpperLeg_Right: 'thighr', LowerLeg_Right: 'calfr', Foot_Right: 'footr', Toe_Right: 'ballr',
};

// CyberSoldier rig → kevdev canonical names. His Hips/Spine/UpperArml-style
// chain is semantically 1:1 with the B-* skeleton; fingers/feet stay
// unmapped and inherit their parent's motion.
export const CYBER_KEVDEV_BONE_MAP: Record<string, string> = {
  Hips: 'hips', Spine: 'spine', Chest: 'chest', Neck: 'neck', Head: 'head',
  ShoulderL: 'shoulderl', UpperArml: 'upperarml', LowerArmL: 'forearml', HandL: 'handl',
  ShoulderR: 'shoulderr', UpperArmr: 'upperarmr', LowerArmR: 'forearmr', HandR: 'handr',
  UpperLegL: 'thighl', LowerLegL: 'shinl', UpperLegR: 'thighr', LowerLegR: 'shinr',
};

// CyberSoldier rig → mannequin DEF-* names (minus the 'DEF-' prefix; the
// bake prepends spec.prefix). Same canonical space as the kevdev map —
// MANNEQUIN_KEVDEV_BONE_MAP inverted.
export const CYBER_MANNEQUIN_BONE_MAP: Record<string, string> = {
  Hips: 'hips', Spine: 'spine001', Chest: 'spine003', Neck: 'neck', Head: 'head',
  ShoulderL: 'shoulderL', UpperArml: 'upper_armL', LowerArmL: 'forearmL', HandL: 'handL',
  ShoulderR: 'shoulderR', UpperArmr: 'upper_armR', LowerArmR: 'forearmR', HandR: 'handR',
  UpperLegL: 'thighL', LowerLegL: 'shinL', UpperLegR: 'thighR', LowerLegR: 'shinR',
};

// Shared radial-gradient flash texture — one per process, all remote
// muzzle sprites reuse it
let _flashTex: THREE.CanvasTexture | null = null;
export function makeFlashTexture(): THREE.CanvasTexture {
  if (_flashTex) {return _flashTex;}
  const c = document.createElement('canvas');
  c.height = 64;
  c.width = c.height;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,220,150,0.8)');
  g.addColorStop(1, 'rgba(255,180,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _flashTex = new THREE.CanvasTexture(c);
  return _flashTex;
}
