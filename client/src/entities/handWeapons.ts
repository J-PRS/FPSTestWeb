import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WeaponType } from '../../../shared/weapons.js';
import { MODEL_BUILDERS } from './viewmodel/weaponsGeo.js';
import { mkChaingun } from './viewmodel/weaponsGeoBallistic.js';

// Hand-prop weapon geometry — the remote/3P gun used to be one generic
// box+cylinder silhouette for every weapon. The real per-weapon shapes
// already exist (the first-person viewmodel builders), so we bake each
// into ONE merged BufferGeometry at hand-prop proportions: 1 mesh + 1
// shared material per remote = the same draw cost as the old prop.
//
// Viewmodel space: guns are authored barrel-forward along -Z at ~0.5m
// scale. The hand prop convention is barrel +Z, ~1.05m long, grip end at
// z≈-0.2 — the same footprint the old prop geo laid out, so the existing
// bone/socket transform math keeps working unchanged.

// Types with no builder (belt throws, melee, beams) fall back to the
// caller's generic prop. Implodisc reuses the Disc model — same launcher.
const ALIASES = new Map<number, number>([
  [WeaponType.Implodisc, WeaponType.Disc],
  [WeaponType.BeltDisc, WeaponType.Disc],
  // HealBeam borrows the repair gun — same hand-held beam tool.
  [WeaponType.HealBeam, WeaponType.Repair],
]);

const builders = new Map<number, () => THREE.Group>(MODEL_BUILDERS);
builders.set(WeaponType.Chaingun, (): THREE.Group<THREE.Object3DEventMap> => mkChaingun().g);

export interface HandWeaponModel {
  geo: THREE.BufferGeometry;
  /** Per-part materials in group order — mergeGeometries(useGroups) numbers
   *  each group by source-part index, so index i answers part i. */
  mats: THREE.Material[];
}

const cache = new Map<number, HandWeaponModel>();

/** Merged hand-prop geometry + materials for a weapon, or undefined when
 *  the type has no authored model (the caller's generic prop covers it). */
export function handWeaponGeo(wt: number): HandWeaponModel | undefined {
  const id = ALIASES.get(wt) ?? wt;
  const hit = cache.get(id);
  if (hit) {return hit;}
  const mk = builders.get(id);
  if (!mk) {return undefined;}

  const group = mk();
  group.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  group.traverse((o): void => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) {return;}
    // Mixed indexed/non-indexed sources won't merge — flatten first.
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    parts.push(g);
    // Flattened multi-material parts can't keep their sub-ranges — take
    // the head material; every authored part here is single-material.
    mats.push(Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material);
  });
  // useGroups keeps the per-part material split — without it the merged
  // gun renders in one stock grey and the glow bits lose their emissive.
  const merged = mergeGeometries(parts, true);
  parts.forEach((p): void => p.dispose());
  if (!merged) {return undefined;}

  // -Z barrel → +Z, then scale to the hand-prop footprint (~1.05m) and
  // park the grip end where the old prop sat.
  merged.rotateY(Math.PI);
  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox!.getSize(size);
  const s = 1.05 / Math.max(size.x, size.y, size.z);
  merged.scale(s, s, s);
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  merged.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z - 0.2);
  merged.computeBoundingSphere();
  const out = { geo: merged, mats };
  cache.set(id, out);
  return out;
}
