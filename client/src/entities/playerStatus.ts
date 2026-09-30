import * as THREE from 'three';

import { STATUS } from '../../../shared/status.js';
import { SHIELD_DMG_PER_ENERGY } from './player/skills.js';
import { makeContouredShield, makeShieldBubble, ShieldBubble } from '../effects/shieldBubble.js';

// Toggle-status family — cloak/shield/mend flags + the wire status byte
// + the third-person shield bubble + spectator ghost-flight. Split from
// Player.ts: owns the flags and their setters; the host keeps everything
// they reach (energy, model visibility, pending inputs, hooks).
export interface StatusHost {
  isDead: boolean;
  thirdPerson: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  energy: number;
  scene: THREE.Scene;
  model: { setVisible(v: boolean): void; object3D: THREE.Object3D | null } | null;
  skills: { forceShieldOff(): void; reset(): void };
  input: { firePending: boolean; jetPending: boolean };
  onCloak: ((on: boolean) => void) | null;
  onShield: ((on: boolean) => void) | null;
  onMend: ((on: boolean) => void) | null;
  onSpectate: ((on: boolean) => void) | null;
}

export class PlayerStatus {
  cloaked = false;
  shielded = false;
  mending = false;
  spectating = false;

  // Third-person bubble — lazily built so a non-shield slot costs nothing.
  shieldBubble: ShieldBubble | null = null;

  constructor(private h: StatusHost) {}

  // All toggle states collapse into the wire status byte — one place
  // computes it so a new channel never forgets its wire bit.
  bits(): number {
    return (this.cloaked ? STATUS.CLOAK : 0)
         | (this.shielded ? STATUS.SHIELD : 0)
         | (this.mending ? STATUS.MEND : 0);
  }

  setCloaked(on: boolean): void {
    const h = this.h;
    if (this.cloaked === on) return;
    this.cloaked = on;
    h.model?.setVisible(h.thirdPerson && !h.isDead && !this.spectating && !on);
    h.onCloak?.(on);
  }

  setShielded(on: boolean): void {
    const h = this.h;
    if (this.shielded === on) return;
    this.shielded = on;
    if (on && !this.shieldBubble) {
      const root = h.model?.object3D;
      this.shieldBubble = (root ? makeContouredShield(root) : null) ?? makeShieldBubble(h.scene);
    }
    // Own bubble only renders in third person — in first person it would
    // swallow the camera; the gun shell + vignette are the FP read instead.
    this.syncBubbleVisibility();
    h.onShield?.(on);
  }

  syncBubbleVisibility(): void {
    if (this.shieldBubble) this.shieldBubble.mesh.visible = this.shielded && this.h.thirdPerson;
  }

  setMending(on: boolean): void {
    if (this.mending === on) return;
    this.mending = on;
    this.h.onMend?.(on);
  }

  /** Bubble follows the body and keeps fading while up. */
  tickBubble(dt: number): void {
    if (!this.shieldBubble) return;
    this.shieldBubble.update(dt);
    if (this.shielded) this.shieldBubble.mesh.position.set(this.h.pos.x, this.h.pos.y - 0.6, this.h.pos.z);
  }

  /** Inbound damage while the bubble is up burns energy (10 dmg = 1 energy)
   *  instead of health. Returns the health damage that still gets through —
   *  zero while the tank holds. */
  absorbShieldDamage(dmg: number): number {
    const h = this.h;
    if (!this.shielded) return dmg;
    h.energy = Math.max(0, h.energy - dmg / SHIELD_DMG_PER_ENERGY);
    this.shieldBubble?.flash();
    if (h.energy <= 0) {
      h.skills.forceShieldOff();
      return 0; // popped exactly on empty — the breaking hit is still soaked
    }
    return 0;
  }

  toggleSpectator(): void {
    const h = this.h;
    if (h.isDead) return; // dead already gives you this cam
    this.spectating = !this.spectating;
    // Land mid-toggle-off in the air and the body floats — drop the ghost's
    // drift so gravity owns the fall again. Also drop any fire/jet clicks
    // queued while ghosted so they don't discharge on the way out.
    if (!this.spectating) {
      h.vel.set(0, 0, 0);
      h.input.firePending = false;
      h.input.jetPending = false;
    }
    h.model?.setVisible(!this.spectating && h.thirdPerson && !h.isDead && !this.cloaked);
    h.onSpectate?.(this.spectating);
  }
}
