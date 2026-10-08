import * as THREE from 'three';

import { metalMat } from './procMetal.js';

// Mannequin re-skin (cached shared recipes — each PlayerModel still
// clones via ownMaterial so damage-flash stays per-instance).
// mannGunMat = the prop-gun recipe (joints), mannJointMat = pickup
// gunmetal (torso).
let _mannGun: THREE.MeshStandardMaterial | null = null;
let _mannMetal: THREE.MeshStandardMaterial | null = null;
function mannGunMat(): THREE.MeshStandardMaterial {
  if (!_mannGun) {
    _mannGun = new THREE.MeshStandardMaterial({ color: 0x2A_2E_33, roughness: 0.55, metalness: 0.6, emissive: 0x33_44_55, emissiveIntensity: 0.8 });
  }
  return _mannGun;
}
function mannJointMat(): THREE.MeshStandardMaterial {
  if (!_mannMetal) {_mannMetal = metalMat();}
  return _mannMetal;
}

/** Per-mesh material pipeline: mannequin reskin recipes, the per-instance
 *  clone cache (so emissive flashes never leak across players sharing a
 *  cached GLB material), the damage-flash mat capture, and the debug
 *  wireframe set. */
export class PlayerMats {
  /** Emissive materials captured at load for the damage white-pop —
   *  ModelFx reads this straight through. */
  readonly flashMats: { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[] = [];
  private clones = new Map<THREE.Material, THREE.Material>();
  private wireMats: THREE.Material[] | null = null;
  wireframeOn = false;

  // Shared GLB materials are cloned per model so one remote's damage
  // flash can't tint the whole fleet.
  private ownMaterial(m: THREE.Material): THREE.Material {
    let c = this.clones.get(m);
    if (!c) { c = m.clone(); this.clones.set(m, c); }
    return c;
  }

  /** Per-mesh load prep: mannequin re-skin (`mann` = the rig variant is
   *  mannequin; `mannRev` swaps its two material roles), per-instance
   *  clone, emissive capture for the damage flash. */
  prep(child: THREE.Mesh, mann: boolean, mannRev: boolean): void {
    if (mann) {
      // The orange/purple stock figure reads as a debug doll on a
      // battlefield — re-skin: torso in the gun-prop recipe, joints in
      // the shared pickup gunmetal.
      const swap = (m: THREE.Material): THREE.Material => {
        if (m.name === 'M_Main') {return mannRev ? mannGunMat() : mannJointMat();}
        if (m.name === 'M_Joints') {return mannRev ? mannJointMat() : mannGunMat();}
        return m;
      };
      child.material = Array.isArray(child.material) ? child.material.map(swap) : swap(child.material);
    }
    child.material = Array.isArray(child.material)
      ? child.material.map((m) => this.ownMaterial(m))
      : this.ownMaterial(child.material);
    // Capture emissive materials for the damage flash — dedupe,
    // a GLB often shares one material across several meshes.
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial
        && !this.flashMats.some(f => f.m === m)) {
        const sm = m as THREE.MeshStandardMaterial;
        this.flashMats.push({ m: sm, e: sm.emissive.clone(), i: sm.emissiveIntensity });
      }
    }
  }

  /** Debug (?debug / menu DEBUG): render the body as wireframe so it can be
   *  eyeballed against the collider capsule. Gun geo swaps re-capture —
   *  fresh attach geo wasn't in the load-time set. */
  captureWireframe(model: THREE.Group | null): void {
    if (!model) {return;}
    const mats = new Set<THREE.Material>();
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {return;}
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {mats.add(m);}
    });
    this.wireMats = [...mats];
  }

  setWireframe(on: boolean, model: THREE.Group | null): void {
    if (!model || on === this.wireframeOn) {return;}
    this.wireframeOn = on;
    if (on) {
      this.captureWireframe(model);
    }
    for (const m of this.wireMats || []) {(m as THREE.MeshBasicMaterial).wireframe = on;}
  }

  /** Per-model material clones — frees their GPU program refs; shared
   *  geometry/textures belong to the cached gltf and stay alive. */
  dispose(): void {
    this.clones.forEach((m) => m.dispose());
    this.clones.clear();
  }
}
