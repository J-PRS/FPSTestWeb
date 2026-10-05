import * as THREE from 'three';
import { FIST_JAB, FIST_OFF } from './viewmodel/weaponsGeo.js';

// Animation envelopes — the three dip cycles (belt throw, weapon switch,
// melee punch) plus their trigger calls. Split out of ViewModel so that
// file stays pose composition; envelopes only know how to tick a [0..1]
// cycle and (for the switch) swap the live model at the bottom of the dip.

// Belt-item throw (Tribes-style build up): weapon dips, item releases
// mid-animation, weapon raises back. THROW_RELEASE is when the
// projectile should actually spawn.
export const THROW_RELEASE = 0.7; // Tribes Ascend belt-item build-up time
const THROW_LOWER_TIME = 0.18;
const THROW_RAISE_TIME = 0.25;
// Total throw cycle — Player gates primary fire on this: the gun is
// physically lowered, shooting mid-throw means firing through the hip.
export const THROW_TOTAL = THROW_RELEASE + THROW_RAISE_TIME + 0.05;

// Weapon switch: quick lower, swap model at the bottom, raise back up
const SWITCH_LOWER_TIME = 0.12;
const SWITCH_RAISE_TIME = 0.16;
// Sidearm hold-out gates its fire on the raise completing — a "pull it out
// and it's live" beat, same window the viewmodel spends drawing the gun.
export const SIDEARM_DRAW_TIME = SWITCH_LOWER_TIME + SWITCH_RAISE_TIME;

// Melee punch: CoD-style — the weapon drops low/right like holstering while
// an off-hand fist jabs in from bottom-left. Fast in, impact hold, spring back.
const PUNCH_IN = 0.09;
const PUNCH_HOLD = 0.08;
// Confirmed hits dwell at apex — the "hit frame holds the pose" trick from
// melee game-feel: connect reads as planted, whiff snaps back. Visual only;
// it can't gate the damage path (that resolved already).
const PUNCH_HIT_HOLD = 0.15;
const PUNCH_OUT = 0.32;

export interface EnvHost {
  weapons: Map<number, THREE.Group>;
  /** Live weapon slot — the switch envelope rewrites it at the dip's bottom. */
  activeWeapon: number;
  flashMesh: THREE.Object3D;
  flashMesh2: THREE.Object3D;
  fistGroup: THREE.Object3D;
  /** Field-shell state the switch must re-wrap onto the new gun. */
  shieldShells: readonly THREE.Object3D[];
  shellColor: number;
  setShield(on: boolean, color?: number): void;
  /** Muzzle Z per weapon — the flash park moves with the swap. */
  muzzleZ(wt: number): number;
  /** Muzzle node's real position in group space — x/y included, since
   *  bores sit off-axis on most guns. */
  muzzleGroupPos(wt: number, out: THREE.Vector3): boolean;
}

const _flashPark = new THREE.Vector3();

export class VmEnvelopes {
  private switchT = -1;
  private pendingWeapon = -1;
  private throwT = -1;
  private throwScale = 1; // >1 stretches the wind-up — a satchel plant is deliberate
  private punchT = -1;
  private punchLanded = false;

  constructor(private h: EnvHost) {}

  startThrow(timeScale = 1): void {
    this.throwT = 0;
    this.throwScale = timeScale;
  }

  // Melee swing: sweeps the weapon aside instead of kicking — reads as a
  // punch, not a shot. No flash (melee isn't a discharge). `landed` runs
  // the connect variant — the apex hold stretches so the hit visibly STOPS
  // on the target instead of slicing through it.
  punch(landed = false): void {
    this.punchT = 0;
    this.punchLanded = landed;
    this.h.fistGroup.visible = true;
  }

  // Lower → swap model at the bottom → raise. Cosmetic only; firing isn't gated.
  switchWeapon(index: number): void {
    if (index === this.h.activeWeapon && this.switchT < 0) {
      // Same-weapon calls skip the dip — but the guard can't assume the
      // group is already shown: spawn arms activeWeapon=0 while every
      // model still sits built-hidden, so arming BoltLauncher (wt 0)
      // would leave it invisible until the first real swap.
      const cur = this.h.weapons.get(index);
      if (cur && !cur.visible) {cur.visible = true;}
      return;
    }
    this.pendingWeapon = index;
    if (this.switchT < 0) {this.switchT = 0;} // already lowering: just retarget
  }

  /** Tick all three envelopes, returning their dip scalars for the pose
   *  composition pass. */
  tick(dt: number): { dip: number; switchDip: number; punch: number } {
    return {
      dip: this.updateThrowDip(dt),
      switchDip: this.updateSwitchDip(dt),
      punch: this.updatePunchDip(dt),
    };
  }

  // Throw anim: quick lower, hold through release, spring back up
  private updateThrowDip(dt: number): number {
    if (this.throwT < 0) {return 0;}
    this.throwT += dt;
    const t = this.throwT / this.throwScale; // normalized — release lands at THROW_RELEASE*scale
    if (t >= THROW_TOTAL) {
      this.throwT = -1;
      return 0;
    }
    if (t < THROW_LOWER_TIME) {return t / THROW_LOWER_TIME;}
    if (t < THROW_RELEASE + 0.07) {return 1;}
    return Math.max(0, 1 - (t - THROW_RELEASE - 0.07) / THROW_RAISE_TIME);
  }

  // Weapon switch: lower, swap at the bottom, raise
  private updateSwitchDip(dt: number): number {
    if (this.switchT < 0) {return 0;}
    this.switchT += dt;
    const t = this.switchT;
    if (t < SWITCH_LOWER_TIME) {return t / SWITCH_LOWER_TIME;}
    if (this.pendingWeapon >= 0 && this.pendingWeapon !== this.h.activeWeapon) {
      const prev = this.h.weapons.get(this.h.activeWeapon);
      if (prev) {prev.visible = false;}
      this.h.activeWeapon = this.pendingWeapon;
      const next = this.h.weapons.get(this.h.activeWeapon);
      if (next) {next.visible = true;}
      // The field shell wraps the OLD gun's silhouette — re-wrap the new one.
      if (this.h.shieldShells.length) { this.h.setShield(false); this.h.setShield(true, this.h.shellColor); }
      // Park the flash at the muzzle NODE — the old z-only park left the
      // quads on the group centerline, buried inside guns whose bore is
      // offset in x/y (plasma repeater's muzzle is off-center).
      if (this.h.muzzleGroupPos(this.h.activeWeapon, _flashPark)) {
        this.h.flashMesh.position.copy(_flashPark);
        this.h.flashMesh2.position.copy(_flashPark);
      } else {
        this.h.flashMesh.position.z = this.h.muzzleZ(this.h.activeWeapon);
        this.h.flashMesh2.position.z = this.h.flashMesh.position.z;
      }
    }
    const dip = Math.max(0, 1 - (t - SWITCH_LOWER_TIME) / SWITCH_RAISE_TIME);
    if (dip <= 0) { this.switchT = -1; this.pendingWeapon = -1; }
    return dip;
  }

  // Punch swing envelope: snap in, brief apex hold, spring back out.
  // Also flies the fist — weapon envelope drives the gun, this moves the glove.
  private updatePunchDip(dt: number): number {
    if (this.punchT < 0) {return 0;}
    this.punchT += dt;
    const t = this.punchT;
    const hold = this.punchLanded ? PUNCH_HIT_HOLD : PUNCH_HOLD;
    const total = PUNCH_IN + hold + PUNCH_OUT;
    if (t >= total) {
      this.punchT = -1;
      this.h.fistGroup.visible = false;
      this.h.fistGroup.position.copy(FIST_OFF);
      return 0;
    }
    let env: number;
    if (t < PUNCH_IN) {env = t / PUNCH_IN;}
    else if (t < PUNCH_IN + hold) {env = 1;}
    else {env = 1 - (t - PUNCH_IN - hold) / PUNCH_OUT;}
    // Fist leads: it jabs in on the weapon's way out and snaps back first
    const ft = t < PUNCH_IN ? t / PUNCH_IN : t < PUNCH_IN + hold + 0.05 ? 1 : Math.max(0, 1 - (t - PUNCH_IN - hold - 0.05) / 0.12);
    const ease = 1 - (1 - ft) * (1 - ft); // ease-out — fast launch, lands hard
    this.h.fistGroup.position.lerpVectors(FIST_OFF, FIST_JAB, ease);
    return env;
  }
}
