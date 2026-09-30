import * as THREE from 'three';

import { getProjectileConfig } from '../projectiles/index.js';
import { makeFlashTexture } from './playerClips.js';

const _white = new THREE.Color(0xffffff);
const _leanEul = new THREE.Euler();
const _leanNo = new THREE.Quaternion();
const _leanYes = new THREE.Quaternion();
const _leanOff = new THREE.Vector3();
const _leanA = new THREE.Vector3();
const _leanB = new THREE.Vector3();

// Jet-lean pivot: the pack thrusts from the sternum, so the body tilts
// about that point and the legs swing — feet-pivot lean reads as a
// cardboard cutout tipping over.
const LEAN_PIVOT_Y = 1.3;

/** The model's view of the pieces the FX pass touches — everything it
 *  doesn't own (gun transform, muzzle sprite, shared material baselines)
 *  comes through here so PlayerModel stays the single owner. */
export interface ModelFxHost {
  model: THREE.Group | null;
  gun: THREE.Group | null;
  muzzleFlash: THREE.Sprite | null;
  flashMats: { m: THREE.MeshStandardMaterial; e: THREE.Color; i: number }[];
  gunUnit: number;
  gunBaseY: number;
  gunBaseZ: number;
  gunBaseX: number;
  gunKickZ: number;
  /** setRotation's applied roll — lean rebuilds rotation.z from it, so
   *  reading the euler back would double-apply. */
  lastRoll: number;
}

/** Per-frame cosmetic FX on the body model: recoil + muzzle flash, the
 *  swap/throw/punch/land prop-gun envelopes, whole-body jet lean with
 *  sternum pivot compensation, and the emissive damage flash. Owns all
 *  the envelope timers; PlayerModel's update calls tick(dt). */
export class ModelFx {
  private swapT = -1;
  private throwT = -1;
  private punchT = -1;
  private landT = -1;
  private landAmp = 0;
  private landE = 0;
  private recoil = 0;
  private flashTTL = 0;
  private dmgFlash = 0;
  // Jet lean: targets set by setBodyLean, damped toward in tick so the
  // tilt eases in/out instead of snapping per frame.
  private leanP = 0; private leanR = 0;
  private leanPT = 0; private leanRT = 0;

  constructor(private readonly h: ModelFxHost) {}

  /** Build the muzzle flash sprite — called by attachGun once the prop
   *  gun group exists (kept next to it in gun-local space). */
  static buildMuzzleFlash(): THREE.Sprite {
    const flashMat = new THREE.SpriteMaterial({
      map: makeFlashTexture(),
      color: 0xaad4ff,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const s = new THREE.Sprite(flashMat);
    s.scale.setScalar(0); // hidden until fire()
    s.position.set(0, 0.05, 1.0); // barrel tip (gun-local)
    return s;
  }

  /** Third-person weapon swap — the same lower→switch→raise the
   *  viewmodel plays (its timings: 0.12s down, 0.16s up). The prop gun
   *  doesn't actually change; the dip IS the swap read. */
  weaponSwap(): void {
    if (this.h.gun) { this.swapT = 0; this.throwT = -1; this.punchT = -1; }
  }

  /** Belt throw — same beat as the viewmodel's THROW_DIP: gun down and
   *  rolled outward while the off hand releases, then back to ready. */
  weaponThrow(): void {
    if (this.h.gun) { this.throwT = 0; this.swapT = -1; this.punchT = -1; }
  }

  /** Melee — butt-stroke sweep: the gun shoves forward-right with a hard
   *  roll, mirroring the viewmodel's punch arc. */
  weaponPunch(): void {
    if (this.h.gun) { this.punchT = 0; this.swapT = -1; this.throwT = -1; }
  }

  /** Landing compress — a quick forward pitch scaled by impact speed,
   *  stacked inside the lean write (jet lean keeps working on top). */
  landPulse(impactSpeed: number): void {
    if (impactSpeed < 6) return; // stepping off a ledge isn't a landing
    this.landAmp = Math.min(1, impactSpeed / 30);
    this.landT = 0;
  }

  /** Damage white-pop — creature-style hit readability on the body. */
  damageFlash(): void {
    this.dmgFlash = 0.15;
  }

  // Procedural fire kick + muzzle flash — weaponType tints the flash so
  // an LG blast reads differently to a shotgun.
  fire(weaponType?: number): void {
    this.recoil = 1;
    this.flashTTL = 0.09;
    // Reset to the default tint too — a shotgun shouldn't leave the next
    // LG shot flashing amber.
    if (this.h.muzzleFlash) {
      const glow = weaponType !== undefined ? getProjectileConfig(weaponType)?.glowColor : undefined;
      (this.h.muzzleFlash.material as THREE.SpriteMaterial).color.set(glow ?? 0xaad4ff);
    }
  }

  /** Directional body lean (jet thrust tilt): pitch = forward/back,
   *  roll = sideways. Set every frame a jet is active; pass 0,0 to ease
   *  back to level. */
  setBodyLean(pitch: number, roll: number): void {
    this.leanPT = pitch;
    this.leanRT = roll;
  }

  tick(dt: number): void {
    this.tickGunFx(dt);
    this.tickJetLean(dt);
    this.tickDamageFlash(dt);
  }

  /** Attack→hold→release envelope: advances the timer, returns 0..1.
   *  The prop-gun tells (swap/throw/punch/land) are all this curve with
   *  viewmodel-matched timings. */
  private env(field: 'swapT' | 'throwT' | 'punchT' | 'landT', dt: number, up: number, hold: number, down: number): number {
    let t = this[field];
    if (t < 0) return 0;
    this[field] = t += dt;
    const e = t < up ? t / up : t < up + hold ? 1 : Math.max(0, 1 - (t - up - hold) / down);
    if (e <= 0 && t > up + hold) this[field] = -1;
    return e;
  }

  private tickGunFx(dt: number): void {
    const swapDip = this.env('swapT', dt, 0.12, 0, 0.16);
    const throwE = this.env('throwT', dt, 0.14, 0.12, 0.26);
    const punchE = this.env('punchT', dt, 0.09, 0.08, 0.32);
    // Landing: sharp compress then a slower settle — read in tickJetLean.
    this.landE = this.env('landT', dt, 0.07, 0, 0.32) * this.landAmp;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 7);
    const { gun } = this.h;
    if (gun) {
      const k = this.recoil * this.recoil; // snappy attack, soft release
      // All prop motions compose into one transform: swap dips down,
      // throw drops + rolls out, punch shoves forward-right.
      gun.position.x = punchE * 0.18 * this.h.gunUnit;
      gun.position.y = this.h.gunBaseY - (swapDip * 0.3 + throwE * 0.25 + punchE * 0.15) * this.h.gunUnit;
      gun.position.z = this.h.gunBaseZ - k * this.h.gunKickZ + (swapDip * 0.1 + throwE * 0.08 + punchE * 0.3) * this.h.gunUnit;
      gun.rotation.x = this.h.gunBaseX - k * 0.45 + swapDip * 0.6 + throwE * 0.35 + punchE * 0.25;
      gun.rotation.z = throwE * 0.45 + punchE * 0.5;
    }
    const flash = this.h.muzzleFlash;
    if (flash && this.flashTTL > 0) {
      this.flashTTL = Math.max(0, this.flashTTL - dt);
      const f = this.flashTTL / 0.09;
      flash.scale.setScalar(0.5 * f + 0.15 * f * f);
      (flash.material as THREE.SpriteMaterial).opacity = f;
    } else if (flash && flash.scale.x > 0) {
      flash.scale.setScalar(0);
    }
  }

  // Jet lean: ease toward the target, then write the composed tilt
  // on top of yaw/roll. setRotation may run before or after update,
  // so rotation.z is rebuilt here from lastRoll + lean — never read
  // the euler back, or the lean would double-apply.
  private tickJetLean(dt: number): void {
    const { model } = this.h;
    if (!model || (this.leanPT === 0 && this.leanRT === 0 && this.leanP === 0 && this.leanR === 0 && this.landE === 0)) return;
    const k = 1 - Math.exp(-dt * 7);
    this.leanP += (this.leanPT - this.leanP) * k;
    this.leanR += (this.leanRT - this.leanR) * k;
    if (Math.abs(this.leanP) < 1e-3 && this.leanPT === 0) this.leanP = 0;
    if (Math.abs(this.leanR) < 1e-3 && this.leanRT === 0) this.leanR = 0;
    // Landing pitch stacks on the lean — the absorb crouch reads as the
    // whole body tipping forward a beat, not just the knees.
    const pitch = this.leanP + this.landE * 0.18;
    model.rotation.x = pitch;
    model.rotation.z = this.h.lastRoll + this.leanR;
    // Pivot compensation: keep the sternum where the un-leaned pose
    // would put it, so the tilt swings the legs instead of the chest.
    const yaw = model.rotation.y;
    _leanNo.setFromEuler(_leanEul.set(0, yaw, this.h.lastRoll, 'YXZ'));
    _leanYes.setFromEuler(_leanEul.set(pitch, yaw, this.h.lastRoll + this.leanR, 'YXZ'));
    _leanOff.set(0, LEAN_PIVOT_Y, 0);
    _leanA.copy(_leanOff).applyQuaternion(_leanNo);
    _leanB.copy(_leanOff).applyQuaternion(_leanYes);
    model.position.add(_leanA.sub(_leanB));
  }

  // Damage flash: emissive snaps toward white then decays back to each
  // material's own baseline (the gun keeps its 0x334455 glow).
  private tickDamageFlash(dt: number): void {
    if (this.dmgFlash <= 0) return;
    this.dmgFlash = Math.max(0, this.dmgFlash - dt);
    const k = this.dmgFlash / 0.15;
    for (const f of this.h.flashMats) {
      f.m.emissive.copy(f.e).lerp(_white, k);
      f.m.emissiveIntensity = f.i + k * 2.5;
    }
  }
}
