import * as THREE from 'three';

import { metalMat } from './procMetal.js';
import { enhanceWeaponMaterial } from '../effects/vertexAO.js';

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
    if (!c) {
      c = m.clone();
      // clone() drops onBeforeCompile and JSON-roundtrips userData (the
      // wear/grime textures die in it) — re-arm the grunge shader from
      // the SOURCE material's live refs on baked-gunmetal bodies.
      if (m.userData.__grunge) {
        delete c.userData.__grunge;
        c.userData.__wearTex = m.userData.__wearTex;
        c.userData.__grimeTex = m.userData.__grimeTex;
        c.userData.__wearInt = m.userData.__wearInt;
        enhanceWeaponMaterial(c);
      }
      this.clones.set(m, c);
    }
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
      ? child.material.map((m): THREE.Material<THREE.MaterialEventMap> => this.ownMaterial(m))
      : this.ownMaterial(child.material);
    // Capture emissive materials for the damage flash — dedupe,
    // a GLB often shares one material across several meshes.
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial
        && !this.flashMats.some((f): boolean => f.m === m)) {
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
    model.traverse((o): void => {
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

  private baseCols = new Map<THREE.Material, THREE.Color>();
  private tint: THREE.Color | null = null;

  /** Team paint — lerps the 'armor' material's captured base color
   *  toward a muted team hue; 'dark' frame and 'accent' glow stay
   *  authored so plates read as painted armor over the same chassis.
   *  Rigs without an 'armor' material tint everything (legacy bodies).
   *  Full-saturation lerp reads as plastic, so the hue is muted first. */
  setTint(hex: number | null): void {
    this.tint = hex === null ? null : new THREE.Color(hex).lerp(new THREE.Color(0x20_20_24), 0.2);
    const mats = [...this.clones.values()];
    const targets = mats.some((m): boolean => m.name === 'armor')
      ? mats.filter((m): boolean => m.name === 'armor')
      : mats;
    for (const m of targets) {
      const sm = m as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial) {continue;}
      let base = this.baseCols.get(m);
      if (!base) { base = sm.color.clone(); this.baseCols.set(m, base); }
      sm.color.copy(base);
      if (this.tint) {sm.color.lerp(this.tint, 0.7);}
    }
  }

  /** Fresnel rim — emissive edge glow injected into the cloned body
   *  materials (rim lives on the surface, not a separate shell — a
   *  softer read than the hull outline). Uniform-driven so on/off
   *  costs nothing after the one-time program patch. */
  /** Non-body materials that want the same rim (the hand prop's own
   *  material lives outside the clone set). */
  readonly extraRim: THREE.Material[] = [];

  setRim(hex: number | null): void {
    const col = hex === null ? 0 : hex;
    for (const m of [...this.clones.values(), ...this.extraRim]) {
      const sm = m as THREE.MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial) {continue;}
      let u = sm.userData.rimU as { value: THREE.Color } | undefined;
      if (!u) {
        u = { value: new THREE.Color(0) };
        sm.userData.rimU = u;
        const U = u;
        // Chain, not overwrite — a grunge bake may already own the hook.
        const prev = sm.onBeforeCompile;
        sm.onBeforeCompile = (sh, r): void => {
          prev?.(sh, r);
          sh.uniforms.uRim = U;
          sh.fragmentShader = `uniform vec3 uRim;\n${sh.fragmentShader}`.replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n totalEmissiveRadiance += uRim * pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 3.0);');
        };
        sm.needsUpdate = true;
      }
      u.value.setHex(col);
    }
  }

  /** Per-model material clones — frees their GPU program refs; shared
   *  geometry/textures belong to the cached gltf and stay alive. */
  dispose(): void {
    this.clones.forEach((m): void => m.dispose());
    this.clones.clear();
  }
}
