// Locomotion clip surgery — mannequin/knight rigs carry authored root
// motion and full-body tracks our layered system has to carve up.
import * as THREE from 'three';
import { normBone, DIR8, DIR_SUFFIX, type LocoDir } from './playerClips.js';

// Direction data lives in playerClips with the other resolution tables;
// re-exported here where the surgery callers already import from.
export { DIR8, DIR_SUFFIX, type LocoDir };

const _dampA = new THREE.Quaternion();
const _dampB = new THREE.Quaternion();

// Norm'd bone names that carry the rig's world-translation — the entity
// owns world position, so these tracks pin their XZ or loop clips walk
// the mesh out from under the hitbox. 'pelvis' suffix catches authored
// rigs like Vexa's Base_HumanPelvis.
const ROOT_POS_BONES = new Set(['defhips', 'root', 'hips', 'bone']);

/** Strip hip/root XZ translation — the entity owns world position; left
 *  in, loop clips translate the mesh out from under the hitbox.
 *  `extraRoots` lets the caller pass rig-specific carriers computed from
 *  the model itself: authored rigs animate their armature-level parents
 *  too (Vexa moves `Armature`, Yurowm `Rig`), which no name table covers. */
export function stripHipXZ(clip: THREE.AnimationClip, extraRoots?: ReadonlySet<string>): void {
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.position')) {continue;}
    const node = normBone(tr.name.slice(0, tr.name.indexOf('.')));
    if (!ROOT_POS_BONES.has(node) && !node.endsWith('pelvis') && !(extraRoots?.has(node))) {continue;}
    const v = tr.values;
    const [v0, , v2] = v;
  for (let i = 3; i < v.length; i += 3) { v[i] = v0; v[i + 2] = v2; }
  }
}

/** Clamp hip/root Y excursion — same "entity owns position" rule as
 *  stripHipXZ, but Y needs a band not a pin: crouch/bob dips are legit
 *  pose, while authored jump arcs (polyart 'Jump' bakes +0.8m into the
 *  hips) float the mesh clear out of the collider while the capsule
 *  does the actual moving. Deviation is measured from the first key so
 *  each clip keeps its own stance height. */
export function clampHipY(clip: THREE.AnimationClip, maxDev = 0.25, extraRoots?: ReadonlySet<string>): void {
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.position')) {continue;}
    const node = normBone(tr.name.slice(0, tr.name.indexOf('.')));
    if (!ROOT_POS_BONES.has(node) && !node.endsWith('pelvis') && !(extraRoots?.has(node))) {continue;}
    const v = tr.values, base = v[1]!;
    for (let i = 1; i < v.length; i += 3) {
      const d = v[i]! - base;
      if (Math.abs(d) > maxDev) {v[i] = base + Math.sign(d) * maxDev;}
    }
  }
}

// Nodes above the hips that authored rigs animate as root motion — the
// ancestor chain of the skeleton's shallowest joint (Vexa animates
// 'Armature', Yurowm 'Rig'). No name table covers these; computed from
// the loaded hierarchy once per model.
export function computeRootMotionNodes(model: THREE.Object3D): Set<string> {
  const set = new Set<string>();
  model.traverse((o): void => {
    const sk = o as THREE.SkinnedMesh;
    if (!sk.isSkinnedMesh || !sk.skeleton) {return;}
    let root: THREE.Object3D | null = null, rootDepth = Infinity;
    for (const b of sk.skeleton.bones) {
      let d = 0; for (let p = b.parent; p && p !== model; p = p.parent) {d += 1;}
      if (d < rootDepth) { root = b; rootDepth = d; }
    }
    for (let n = root; n && n !== model; n = n.parent) {
      if (n.name) {set.add(normBone(n.name));}
    }
  });
  return set;
}

// Clips the mannequin's aim layer rides under: everything EXCEPT full-body
// oneshots (shoot/hit/death own the arms) and the Pistol_Aim_* sources.
export function isLayeredClip(name: string): boolean {
  return !name.includes('Aim') && !name.startsWith('Death') &&
    !name.startsWith('Hit_') && name !== 'Pistol_Shoot' &&
    name !== 'Two-hand Blast' && name !== 'Throw Object' && name !== 'OverhandThrow';
}

// Arms only — spine/neck/head stay with the locomotion clip so the torso
// keeps its run-bob and sway (owning them froze the torso over running
// legs, which read as sliding). Aim pitch on the torso comes from the
// procedural aimBones pass instead.
export const AIM_BONE_MASK = new Set([
  'defshoulderl', 'defshoulderr',
  'defupperarml', 'defupperarmr', 'defforearml', 'defforearmr',
  'defhandl', 'defhandr',
  // UAL2 robot chain — without these the masked layer filtered every arm
  // track out and robot aimed by spine pitch alone.
  'shoulderl', 'shoulderr', 'upperarml', 'upperarmr',
  'lowerarml', 'lowerarmr', 'palm1l', 'palm1r', 'palm2l', 'palm2r', 'palm3l', 'palm3r',
  'handl', 'handr',
  // Mesh2Motion UE-style chain (brute): clavicle_l → claviclel etc.
  'claviclel', 'clavicler',
]);

// Torso norms that may join the aim mask on rigs whose aim clips carry
// pitch in the spine tracks (robot: the arm-only residual sweeps
// horizontally). Hips/legs stay out so locomotion still owns them.
export const AIM_TORSO_BONES = new Set([
  'abdomen', 'torso', 'torso1', 'neck', 'head',
  'defspine001', 'defspine002', 'defspine003', 'defneck', 'defhead',
  'spine', 'chest', 'rigspine2', 'rigspine3', 'rigneck', 'righead',
  // Mesh2Motion UE-style torso (brute): spine_01..03 / neck_01 norms.
  'spine01', 'spine02', 'spine03', 'neck01',
]);

// Torso chain whose locomotion sway gets halved — spine roll is what
// swung the aimed gun side to side. Position tracks (hip bob) untouched.
export const SWAY_BONES = new Set([
  'defhips', 'defspine001', 'defspine002', 'defspine003', 'defneck', 'defhead',
  // Class-body rigs (CyberSoldier / Yurowm Rig* / SciFiWarrior).
  'hips', 'spine', 'chest', 'neck', 'head',
  'rigass', 'rigspine1', 'rigspine2', 'rigspine3', 'rigneck', 'righead',
]);

/** Dampen torso-chain sway: full-run spine roll carries the aimed arms
 *  with it and reads as the CoD sprint wade — waving the gun side to
 *  side. Each quaternion key slerps `amt` toward the track's baseline,
 *  so the bob timing and stride direction survive at reduced amplitude.
 *  Directional clips get the stronger damp — the kevdev strafes author
 *  a ~90° spine twist toward travel, which drags the aimed muzzle
 *  off-bore; ~0.8 leaves a readable lean into the step. Position tracks
 *  (hip bob) are untouched. `swayBones` comes from the caller because
 *  the mask lives next to the other rig-bone tables in PlayerModel. */
export function dampenSway(clip: THREE.AnimationClip, swayBones: ReadonlySet<string>, amt = 0.5): void {
  for (const tr of clip.tracks) {
    if (!tr.name.endsWith('.quaternion')) {continue;}
    const node = normBone(tr.name.slice(0, tr.name.indexOf('.')));
    if (!swayBones.has(node)) {continue;}
    const v = tr.values;
    _dampA.set(v[0], v[1], v[2], v[3]);
    for (let i = 4; i < v.length; i += 4) {
      _dampB.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
      _dampB.slerp(_dampA, amt);
      v[i] = _dampB.x; v[i + 1] = _dampB.y; v[i + 2] = _dampB.z; v[i + 3] = _dampB.w;
    }
  }
}
