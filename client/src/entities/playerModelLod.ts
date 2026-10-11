// Far-LOD geometry swap, split out of PlayerModel: mannequin_lod1.glb is
// the same rig decimated ~80% — geometry carries the skin weights, so
// swapping geo alone keeps the pose. The skeleton/mixer is untouched.
// Only exists for 'mannequin'.

import type * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

const _creased = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

// Creased normals once per source geo — clones share the result through
// the WeakMap so a fleet doesn't re-fold the same mesh.
export function smoothShade(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  let g = _creased.get(geo);
  if (!g) { g = toCreasedNormals(geo); _creased.set(geo, g); }
  return g;
}

export class PlayerModelLod {
  private lodGeos: THREE.BufferGeometry[] | null = null;
  private lodLoadP: Promise<void> | null = null;
  lod = 0;

  constructor(
    private readonly meshes: THREE.SkinnedMesh[],
    private readonly loadLod: () => Promise<THREE.BufferGeometry[]>,
  ) {}

  /** Swap request — same early-outs the model had: level 0 or a missing
   *  lod1 payload applies whatever's already resident; level 1 kicks the
   *  one async fetch. */
  set(level: 0 | 1): void {
    if (level === this.lod) {return;}
    this.lod = level;
    if (level === 0 || !this.lodGeos) { this.apply(); return; }
    if (!this.lodLoadP) {
      this.lodLoadP = this.loadLod().then((geos): void => {
        this.lodGeos = geos;
        if (this.lod === 1) {this.apply();}
      return; }).catch((): void => { this.lodLoadP = null; });
    }
  }

  /** baseGeo stash on userData lets the swap round-trip exactly — the
   *  GLB geometry is never mutated, only reassigned. */
  apply(): void {
    if (this.lod === 1 && !this.lodGeos) {return;}
    const toLod = this.lod === 1;
    this.meshes.forEach((m, i): void => {
      if (toLod) {
        if (!m.userData.baseGeo) {m.userData.baseGeo = m.geometry;}
        const g = this.lodGeos![i];
        if (g) {m.geometry = g;}
      } else if (m.userData.baseGeo) {
        m.geometry = m.userData.baseGeo as THREE.BufferGeometry;
      }
      m.computeBoundingSphere();
      if (m.boundingSphere) {m.boundingSphere.radius += 0.6;}
    });
  }
}
