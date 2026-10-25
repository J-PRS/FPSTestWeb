import * as THREE from 'three';
import { makeShieldMaterial } from '../effects/shieldBubble.js';
import type { ViewModel } from './ViewModel.js';

const DEPTH_SHELL_MAT = new THREE.MeshBasicMaterial({ colorWrite: false });

// First-person surface FX — cloak ghosting (whole-layer fade via
// depth-only silhouette shells, not per-surface alpha) and the
// shield/mend hex-fresnel field crawling over the gun.

export function ghostifyMesh(v: ViewModel, mesh: THREE.Mesh): void {

    const shell = new THREE.Mesh(mesh.geometry, DEPTH_SHELL_MAT);
    shell.renderOrder = mesh.renderOrder;
    mesh.parent?.add(shell);
    shell.position.copy(mesh.position);
    shell.quaternion.copy(mesh.quaternion);
    shell.scale.copy(mesh.scale);
    // Animated weapon parts move their transforms AFTER shelling — the
    // copy above freezes the pose. Keep the source; updateShieldShells
    // re-syncs per frame (same trick as the shield clone pairs).
    shell.userData.src = mesh;
    v.ghostShells.push(shell);
  }

export function ghostify(v: ViewModel, m: THREE.Material): void {
    // Shared-palette materials (bodyMat/darkMat serve every weapon) may
    // already be in the set — a second capture would store the faded
    // 0.3 as the restore value and stick them translucent forever.
    if (v.ghostMats.some((g): boolean => g.m === m)) {return;}
    v.ghostMats.push({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });
    m.opacity = Math.min(m.opacity, m.transparent ? 0.25 : 0.3);
    m.transparent = true;
    m.depthWrite = false; // shells own the depth now — color pass only blends
    // `transparent` is a shader define — post-compile flips are inert until
    // the program rebuilds (three.js #23866).
    m.needsUpdate = true;
  }

export function setGhost(v: ViewModel, on: boolean): void {
    // Idempotent ON — resyncs/gamestate replays can re-fire onCloak(true)
    // while already cloaked; re-running the sweep would ghost shells and
    // re-snapshot faded opacities.
    if (on && v.ghostMats.length > 0) {return;}
    if (!on) {
      for (const g of v.ghostMats) {
        g.m.opacity = g.opacity;
        g.m.transparent = g.transparent;
        g.m.depthWrite = g.depthWrite;
        g.m.needsUpdate = true;
      }
      v.ghostMats = [];
      for (const s of v.ghostShells) {s.parent?.remove(s);}
      v.ghostShells = [];
      return;
    }
    const seen = new Set<THREE.Material>();
    const toShell: THREE.Mesh[] = [];
    v.group.traverse((o): void => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) {
        const spr = o as THREE.Sprite;
        if (spr.isSprite && spr.material && !seen.has(spr.material)) {
          seen.add(spr.material);
          ghostify(v, spr.material);
        }
        return;
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      let shelled = false;
      for (const m of mats) {
        if (!m || seen.has(m)) {continue;}
        seen.add(m);
        if (!m.transparent && !shelled) { toShell.push(mesh); shelled = true; }
        ghostify(v, m);
      }
    });
    for (const mesh of toShell) {ghostifyMesh(v, mesh);}
  }

// Energy shield, first-person read: the same hex+fresnel field that wraps
// the third-person bubble crawls over the gun's surface — the player who
// raised it sees the charge on their own weapon. shellColor/shieldShells
// state stays on ViewModel — the switch envelope re-wraps mid-dip.

export function setShield(v: ViewModel, on: boolean, color = 0x66_CC_FF): void {
    if (!on) {
      for (const s of v.shieldShells) {s.parent?.remove(s);}
      v.shieldShells = [];
      return;
    }
    if (v.shieldShells.length > 0) {return;}
    v.shellColor = color;
    const src = v.weapons.get(v.activeWeapon);
    if (!src) {return;}
    const shell = src.clone(true);
    shell.traverse((o): void => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {m.material = makeShieldMaterial(color);}
    });
    shell.scale.setScalar(1.06);
    src.parent?.add(shell);
    // Animated weapons (chaingun barrel spin, etc.) transform the
    // ORIGINAL's children — the clone is a frozen snapshot. Pair each
    // shell node with its source once (traverse order is identical on a
    // clone(true)); updateShieldShells then just copies transforms — no
    // per-frame traversal or allocation.
    const srcKids: THREE.Object3D[] = []; src.traverse((o): void => {srcKids.push(o);});
    const pairs: [THREE.Object3D, THREE.Object3D][] = [];
    let i = 0;
    shell.traverse((o): void => {if (i > 0) {pairs.push([o, srcKids[i]!]);} i++;});
    shell.userData.pairs = pairs;
    v.shieldShells.push(shell);
  }
/** Tick the field animation on the gun shells (called from update). */
export function updateShieldShells(v: ViewModel, dt: number): void {
    for (const s of v.shieldShells) {
      const pairs = s.userData.pairs as [THREE.Object3D, THREE.Object3D][] | undefined;
      if (pairs) {
        for (const [shellNode, srcNode] of pairs) {
          shellNode.position.copy(srcNode.position);
          shellNode.quaternion.copy(srcNode.quaternion);
          shellNode.scale.copy(srcNode.scale);
        }
      }
      s.traverse((o): void => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial;
        if (m?.uniforms?.uTime) {m.uniforms.uTime.value += dt;}
      });
    }
    // Cloak depth-shells: one node each, follow its animated source.
    for (const s of v.ghostShells) {
      const src = s.userData.src as THREE.Object3D | undefined;
      if (src) {
        s.position.copy(src.position);
        s.quaternion.copy(src.quaternion);
        s.scale.copy(src.scale);
      }
    }
  }

