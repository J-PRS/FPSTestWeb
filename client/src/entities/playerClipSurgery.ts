// Locomotion clip surgery — mannequin/knight rigs carry authored root
// motion and full-body tracks our layered system has to carve up.
import * as THREE from 'three';
import { normBone } from './playerClips.js';

// 8-way facing-frame direction. atan2(side, fwd): 0=F, +90°=R, ±180°=B.
export type LocoDir = 'F' | 'FR' | 'R' | 'BR' | 'B' | 'BL' | 'L' | 'FL';
export const DIR8: LocoDir[] = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
export const DIR_SUFFIX: Record<LocoDir, string> = {
  F: 'Forward', FR: 'ForwardRight', R: 'Right', BR: 'BackwardRight',
  B: 'Backward', BL: 'BackwardLeft', L: 'Left', FL: 'ForwardLeft',
};

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
    if (!tr.name.endsWith('.position')) continue;
    const node = normBone(tr.name.slice(0, tr.name.indexOf('.')));
    if (!ROOT_POS_BONES.has(node) && !node.endsWith('pelvis') && !(extraRoots?.has(node))) continue;
    const v = tr.values;
    for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
  }
}

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
    if (!tr.name.endsWith('.quaternion')) continue;
    const node = normBone(tr.name.slice(0, tr.name.indexOf('.')));
    if (!swayBones.has(node)) continue;
    const v = tr.values;
    _dampA.set(v[0], v[1], v[2], v[3]);
    for (let i = 4; i < v.length; i += 4) {
      _dampB.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
      _dampB.slerp(_dampA, amt);
      v[i] = _dampB.x; v[i + 1] = _dampB.y; v[i + 2] = _dampB.z; v[i + 3] = _dampB.w;
    }
  }
}
