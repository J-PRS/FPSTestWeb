import type * as THREE from 'three';

import { classCapsule } from '../../../shared/botClasses.js';
import {type ShieldBubble, makeContouredShield, makeShieldBubble} from '../effects/shieldBubble.js';

// Status-aura family — the energy-shield bubble plus the one-bit status
// auras (mend/regen/dd/charge), identical lazy-glow plumbing per STATUS
// bit. Split from RemotePlayer.ts; the host keeps position, scene,
// model, and the cloak/stale hide flags the auras read.
export interface AuraHost {
  position: THREE.Vector3;
  /** Armor tier — the shield/aura anchor rides at the class's feet. */
  armorClass?: string;
  scene: THREE.Scene;
  model: { object3D: THREE.Object3D | null } | null;
  cloakHidden: boolean;
  staleHidden: boolean;
}

export class RemoteAuras {
  // Energy-shield bubble — lazily built on first use so un-shielded
  // remotes cost nothing. Lives at scene level (not inside the model) so
  // cloak's setVisible(false) can't silently take it down with the body.
  private shieldBubble: ShieldBubble | null = null;
  private shielded = false;
  private shieldContoured = false;
  // Keyed so a new aura is a table row rather than a fourth copy of the
  // same field/update/hide/show blocks.
  private statusAuras = new Map<string, {
    bubble: ShieldBubble; on: boolean;
    /** Auras that should hug the body (mend) remember their spec so a
     *  pre-model-load sphere can be rebuilt contoured in
     *  upgradeContoured — the shield's two-step, generalized. */
    wantContoured: boolean; contoured: boolean;
    radius: number; color: number;
  }>();

  constructor(private h: AuraHost) {}

  get isShielded(): boolean { return this.shielded; }

  /** Prefer the body-hugging shell once the model's skinned meshes exist;
   *  the sphere is only a pre-load fallback. */
  private buildShield(): void {
    const root = this.h.model?.object3D;
    const contoured = root ? makeContouredShield(root) : null;
    this.shieldContoured = Boolean(contoured);
    this.shieldBubble = contoured ?? makeShieldBubble(this.h.scene);
  }

  /** Post-load upgrade: a shield raised before the GLB landed sits in the
   *  sphere fallback — rebuild it contoured once bones exist. Same swap
   *  for any active aura that wants the body-hugging read. */
  upgradeContoured(): void {
    if (this.shielded && !this.shieldContoured) {
      this.shieldBubble?.dispose();
      this.buildShield();
      this.shieldBubble!.mesh.visible = !this.h.cloakHidden;
    }
    const root = this.h.model?.object3D;
    if (!root) {return;}
    for (const a of this.statusAuras.values()) {
      if (!a.wantContoured || a.contoured) {continue;}
      const c = makeContouredShield(root, a.color);
      if (!c) {continue;}
      const vis = a.bubble.mesh.visible;
      a.bubble.dispose();
      a.bubble = c;
      a.contoured = true;
      c.mesh.visible = vis;
    }
  }

  setShielded(on: boolean): void {
    if (on === this.shielded) {return;}
    this.shielded = on;
    if (on && !this.shieldBubble) {this.buildShield();}
    if (this.shieldBubble) {this.shieldBubble.mesh.visible = on;}
  }

  /** Soaked hit — flare the lattice. */
  flashShield(): void {
    if (this.shielded) {this.shieldBubble?.flash();}
  }

  private setAura(key: string, on: boolean, radius: number, color: number, wantContoured = false): void {
    let a = this.statusAuras.get(key);
    if ((a?.on ?? false) === on) {return;}
    if (!a) {
      const root = this.h.model?.object3D;
      const c = wantContoured && root ? makeContouredShield(root, color) : null;
      a = {
        bubble: c ?? makeShieldBubble(this.h.scene, radius, color),
        on: false, wantContoured, contoured: Boolean(c), radius, color,
      };
      this.statusAuras.set(key, a);
    }
    a.on = on;
    a.bubble.mesh.visible = on && !this.h.cloakHidden;
  }

  // Medkit channel — green energy hugging the body, same read as the
  // local third-person mend shell (sphere only before the model loads).
  setMending(on: boolean): void { this.setAura('mend', on, 1.6, 0x3F_DD_6F, true); }
  get isMending(): boolean { return this.statusAuras.get('mend')?.on ?? false; }

  // Powerup tells — a buffed enemy should be readable at range: regen
  // shimmers teal, double-damage burns red. Server-owned bits.
  setRegenAura(on: boolean): void { this.setAura('regen', on, 1.8, 0x66_FF_EE); }
  setDdAura(on: boolean): void { this.setAura('dd', on, 1.8, 0xFF_44_22); }

  // LG charge telegraph — the walking-bomb warning, same electric tint
  // as the beam so the read is instant. Bit-level flag only: remotes see
  // "loaded", not the exact bank size.
  setCharged(on: boolean): void { this.setAura('charge', on, 1.9, 0x9F_D8_FF); }

  tick(dt: number): void {
    const y = this.h.position.y - classCapsule(this.h.armorClass).eye;
    if (this.shieldBubble) {
      this.shieldBubble.update(dt);
      if (this.shielded) {this.shieldBubble.mesh.position.set(this.h.position.x, y + 1.1, this.h.position.z);}
    }
    for (const a of this.statusAuras.values()) {
      a.bubble.update(dt);
      if (a.on) {a.bubble.mesh.position.set(this.h.position.x, y + 1, this.h.position.z);}
    }
  }

  hide(): void {
    if (this.shieldBubble) {this.shieldBubble.mesh.visible = false;}
    for (const a of this.statusAuras.values()) {a.bubble.mesh.visible = false;}
  }

  show(): void {
    if (this.shieldBubble && this.shielded) {this.shieldBubble.mesh.visible = true;}
    for (const a of this.statusAuras.values()) {if (a.on) {a.bubble.mesh.visible = true;}}
  }

  dispose(): void {
    this.shieldBubble?.dispose();
    for (const a of this.statusAuras.values()) {a.bubble.dispose();}
  }
}
