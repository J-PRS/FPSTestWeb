/**
 * playerClips — animation clip tables + bone-name maps for PlayerModel.
 * Pure data: which clip plays for each state per rig variant, and which
 * source-rig bone feeds each target-rig bone during retargeting.
 */
import * as THREE from 'three';

export type AnimationState = 'idle' | 'walk' | 'run' | 'jump' | 'death' | 'ski' | 'hit' | 'shoot' | 'jet';

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
  'shoot':  ['UAL_Pistol_Shoot',      'Punch']
};

// Quaternius Knight_Male (CC0) — real-proportioned heavy silhouette on
// the same bone names as the robot. Native clips, no retarget; the Roll
// tuck doubles as the ski pose.
export const KNIGHT_ANIMS: Record<AnimationState, string> = {
  'idle': 'Idle', 'walk': 'Walk', 'run': 'Run',
  'jump': 'Jump', 'death': 'Death', 'ski': 'Roll',
  'jet': 'Jump', 'hit': 'RecieveHit', 'shoot': 'Shoot_OneHanded',
};

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
  'Shoot_OneHanded', 'RecieveHit', 'Punch']);

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

export const normBone = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Shared radial-gradient flash texture — one per process, all remote
// muzzle sprites reuse it
let _flashTex: THREE.CanvasTexture | null = null;
export function makeFlashTexture(): THREE.CanvasTexture {
  if (_flashTex) return _flashTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
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
