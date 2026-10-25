import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mkGltfLoader, loadGltfCached } from '../gltfLoad.js';
import { RIG_MANIFEST } from './playerClips.js';
import type { PlayerModelVariant } from './PlayerModel.js';

// SkeletonUtils.clone runs ~10-30ms synchronously the first time a rig
// variant is copied — a remote joining mid-match pays it on that frame
// (the w:player worst-spike in the perf flame). The pool pre-clones each
// armor-class rig during boot warmup; joins grab a clone off the shelf,
// and the shelf refills on a macrotask.
const _pool = new Map<PlayerModelVariant, THREE.Group[]>();
const _warmed = new Set<PlayerModelVariant>();
const loader = mkGltfLoader();

export function warmRig(variant: PlayerModelVariant, n = 1): void {
  const url = RIG_MANIFEST[variant]?.url;
  if (!url) {return;}
  void loadGltfCached(loader, url).then((gltf): void => {
    let clones = _pool.get(variant);
    if (!clones) {clones = []; _pool.set(variant, clones);}
    while (clones.length < n) {clones.push(SkeletonUtils.clone(gltf.scene) as THREE.Group);}
  });
  _warmed.add(variant);
}

/** Grab a pre-cloned rig scene if the pool has one, else null (caller
 *  falls back to a live clone). Always refills in the background. */
export function takeRig(variant: PlayerModelVariant, source: THREE.Group): THREE.Group | null {
  const clones = _pool.get(variant);
  const out = clones && clones.length > 0 ? clones.pop()! : null;
  // Refill on a macrotask so a burst of joins doesn't stall the frame.
  if (out) {setTimeout((): void => { clones!.push(SkeletonUtils.clone(source) as THREE.Group); }, 0);}
  return out;
}
