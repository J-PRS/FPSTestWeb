import * as THREE from 'three';
import { FIST_JAB, FIST_OFF, FIST_ROT, HAMMER_ENTER, HAMMER_COCK, HAMMER_CONTACT, HAMMER_EXIT, HAMMER_ROT_ENTER, HAMMER_ROT_COCK, HAMMER_ROT_CONTACT, HAMMER_ROT_EXIT } from './viewmodel/weaponsGeo.js';

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

// Shocklance thrust: a fast forward jab — the bolt fires at the apex.
const THRUST_IN = 0.1;   // reach extension
const THRUST_HOLD = 0.07; // full extension — the zap lands here
const THRUST_OUT = 0.26; // retract
export const THRUST_TOTAL = THRUST_IN + THRUST_HOLD + THRUST_OUT;

// Warhammer swing. The HANDLE leads: the grip sweeps right→left across
// the frame, the head DRAGS behind it (overlapping action — the base of
// the chain moves, the far end lags), then whips into the contact a
// beat later. That lag is what makes a rigid prop read as a swing
// instead of a slide: the head arrives at the crosshair last, and it is
// arriving fast.
//
// Phases: load (anticipation) → sweep (the handle leads) → whip (the
// head catches up — this is the impact) → hit-stop → follow-through.
// The gun is holstered for the whole swing — the hammer IS the melee,
// and two props in one frame read as clutter.
const SWING_LOAD = 0.055;  // the grip loads back-right, the head cocks over
const SWING_SWEEP = 0.05;  // the grip sweeps right→left
const SWING_WHIP = 0.028;  // the head whips the rest of the way in
const SWING_HIT_HOLD = 0.05;   // hit-stop — the head planted on the target
const SWING_WHIFF_HOLD = 0.018; // whiff snaps through
const SWING_OUT = 0.14;    // follow-through + exit
/** Seconds from the press to the contact frame — impact FX land here. */
export const SWING_CONTACT_T = SWING_LOAD + SWING_SWEEP + SWING_WHIP;
/** Seconds from the press to the strike — the whoosh goes with this. */
export const SWING_STRIKE_T = SWING_LOAD;
/** How much of the head's rotation the sweep covers — the rest is the whip. */
const SWING_HEAD_LAG = 0.35;

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
  hammerGroup: THREE.Object3D;
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
  private thrustT = -1;
  private swingT = -1;
  private swingLanded = false;

  constructor(private h: EnvHost) {}

  startThrow(timeScale = 1): void {
    this.throwT = 0;
    this.throwScale = timeScale;
  }

  // Spawn draw — jump straight to the throw envelope's raise segment so
  // the weapon reads "pulled out" on a fresh life instead of pop-in.
  draw(): void {
    this.throwT = THROW_RELEASE;
    this.throwScale = 1;
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

  /** The forward jab — one-shot pull-out weapons (shocklance) time
   *  their discharge to the apex. */
  thrust(): void {
    this.thrustT = 0;
  }

  /** Seconds until the thrust reaches full extension — the caller fires
   *  the bolt at exactly this offset so the zap reads at the stab's end. */
  static readonly THRUST_APEX = THRUST_IN;

  /** The melee swing — warhammer chops across while the gun dips.
   *  `landed` stretches the connect dwell so the head visibly STOPS
   *  on the target instead of sweeping through it. */
  swing(landed = false): void {
    this.swingT = 0;
    this.swingLanded = landed;
    this.h.hammerGroup.visible = true;
  }

  /** Tick all envelopes, returning their scalars for the pose
   *  composition pass. */
  tick(dt: number): { dip: number; switchDip: number; punch: number; thrust: number; swing: number } {
    return {
      dip: this.updateThrowDip(dt),
      switchDip: this.updateSwitchDip(dt),
      punch: this.updatePunchDip(dt),
      thrust: this.updateThrustDip(dt),
      swing: this.updateSwingDip(dt),
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
      if (this.h.shieldShells.length > 0) { this.h.setShield(false); this.h.setShield(true, this.h.shellColor); }
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

  // Thrust envelope: fast reach-out, brief apex dwell, retract — the
  // scalar is the extension 0→1→0 (ease-in on the jab, ease-out on the
  // return so the strike doesn't spring like a kick).
  private updateThrustDip(dt: number): number {
    if (this.thrustT < 0) {return 0;}
    this.thrustT += dt;
    const t = this.thrustT;
    if (t >= THRUST_TOTAL) { this.thrustT = -1; return 0; }
    if (t < THRUST_IN) {
      const u = t / THRUST_IN;
      return u * u * (3 - 2 * u); // smoothstep — accelerates into the lunge
    }
    if (t < THRUST_IN + THRUST_HOLD) {return 1;}
    const u = (t - THRUST_IN - THRUST_HOLD) / THRUST_OUT;
    return 1 - u * u * (3 - 2 * u);
  }

  // Hammer swing envelope: load → sweep → whip → hit-stop → follow-through.
  // Position and rotation run on SEPARATE clocks — the grip's path and
  // the head's rotation are interpolated independently, so the head can
  // lag the handle and then snap into the contact.
  private updateSwingDip(dt: number): number {
    if (this.swingT < 0) {return 0;}
    this.swingT += dt;
    const hold = this.swingLanded ? SWING_HIT_HOLD : SWING_WHIFF_HOLD;
    const total = SWING_LOAD + SWING_SWEEP + SWING_WHIP + hold + SWING_OUT;
    const t = this.swingT;
    const hg = this.h.hammerGroup;
    // The gun steps aside for the whole swing. Re-fetched every tick so a
    // weapon switch mid-swing can't leave the new gun on screen.
    const gun = this.h.weapons.get(this.h.activeWeapon);
    if (gun) {gun.visible = false;}
    if (t >= total) {
      this.swingT = -1;
      hg.visible = false;
      hg.position.copy(HAMMER_ENTER);
      hg.rotation.copy(HAMMER_ROT_ENTER);
      const cur = this.h.weapons.get(this.h.activeWeapon);
      if (cur) {cur.visible = true;}
      return 0;
    }
    if (t < SWING_LOAD) {
      // Load: the grip pulls back-right and the head cocks over the top.
      // The handle is what the player sees coming in.
      const u = t / SWING_LOAD;
      const e = u * u * (3 - 2 * u);
      hg.position.lerpVectors(HAMMER_ENTER, HAMMER_COCK, e);
      hg.rotation.set(
        HAMMER_ROT_ENTER.x + (HAMMER_ROT_COCK.x - HAMMER_ROT_ENTER.x) * e,
        HAMMER_ROT_ENTER.y + (HAMMER_ROT_COCK.y - HAMMER_ROT_ENTER.y) * e,
        HAMMER_ROT_ENTER.z + (HAMMER_ROT_COCK.z - HAMMER_ROT_ENTER.z) * e,
      );
      return 0;
    }
    if (t < SWING_LOAD + SWING_SWEEP) {
      // The handle leads: the grip accelerates across the frame while the
      // head only covers a third of its rotation — it is being dragged.
      const u = (t - SWING_LOAD) / SWING_SWEEP;
      const e = 1 - (1 - u) * (1 - u);
      hg.position.lerpVectors(HAMMER_COCK, HAMMER_CONTACT, e);
      const r = e * SWING_HEAD_LAG;
      hg.rotation.set(
        HAMMER_ROT_COCK.x + (HAMMER_ROT_CONTACT.x - HAMMER_ROT_COCK.x) * r,
        HAMMER_ROT_COCK.y + (HAMMER_ROT_CONTACT.y - HAMMER_ROT_COCK.y) * r,
        HAMMER_ROT_COCK.z + (HAMMER_ROT_CONTACT.z - HAMMER_ROT_COCK.z) * r,
      );
      return 1;
    }
    if (t < SWING_LOAD + SWING_SWEEP + SWING_WHIP) {
      // The whip: the head snaps the rest of the way into the contact.
      // Fast in, hard stop — the impact frame.
      const u = (t - SWING_LOAD - SWING_SWEEP) / SWING_WHIP;
      const e = 1 - (1 - u) * (1 - u) * (1 - u);
      const r = SWING_HEAD_LAG + (1 - SWING_HEAD_LAG) * e;
      hg.position.copy(HAMMER_CONTACT);
      hg.rotation.set(
        HAMMER_ROT_COCK.x + (HAMMER_ROT_CONTACT.x - HAMMER_ROT_COCK.x) * r,
        HAMMER_ROT_COCK.y + (HAMMER_ROT_CONTACT.y - HAMMER_ROT_COCK.y) * r,
        HAMMER_ROT_COCK.z + (HAMMER_ROT_CONTACT.z - HAMMER_ROT_COCK.z) * r,
      );
      return 1;
    }
    if (t < SWING_LOAD + SWING_SWEEP + SWING_WHIP + hold) {
      // Hit-stop: the head is planted on the target.
      hg.position.copy(HAMMER_CONTACT);
      hg.rotation.copy(HAMMER_ROT_CONTACT);
      return 1;
    }
    // Follow-through: the head carries on past the target and out of the
    // bottom-left. It keeps rotating (momentum) while the grip settles.
    const u = (t - SWING_LOAD - SWING_SWEEP - SWING_WHIP - hold) / SWING_OUT;
    const ep = u * u * (3 - 2 * u);
    const er = 1 - (1 - u) * (1 - u);
    hg.position.lerpVectors(HAMMER_CONTACT, HAMMER_EXIT, ep);
    hg.rotation.set(
      HAMMER_ROT_CONTACT.x + (HAMMER_ROT_EXIT.x - HAMMER_ROT_CONTACT.x) * er,
      HAMMER_ROT_CONTACT.y + (HAMMER_ROT_EXIT.y - HAMMER_ROT_CONTACT.y) * er,
      HAMMER_ROT_CONTACT.z + (HAMMER_ROT_EXIT.z - HAMMER_ROT_CONTACT.z) * er,
    );
    return 1 - u;
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
      this.h.fistGroup.rotation.copy(FIST_ROT);
      return 0;
    }
    // oxlint-disable-next-line init-declarations -- assigned later
    let env!: number;
    if (t < PUNCH_IN) {env = t / PUNCH_IN;}
    else if (t < PUNCH_IN + hold) {env = 1;}
    else {env = 1 - (t - PUNCH_IN - hold) / PUNCH_OUT;}
    // Fist leads: it jabs in on the weapon's way out and snaps back first
    let ft = Math.max(0, 1 - (t - PUNCH_IN - hold - 0.05) / 0.12);
    if (t < PUNCH_IN) {ft = t / PUNCH_IN;}
    else if (t < PUNCH_IN + hold + 0.05) {ft = 1;}
    const ease = 1 - (1 - ft) * (1 - ft); // ease-out — fast launch, lands hard
    this.h.fistGroup.position.lerpVectors(FIST_OFF, FIST_JAB, ease);
    // Chop roll — the warhammer cocks high (wound back) and follows
    // through low; without the roll the prop reads as a straight jab,
    // not a swing.
    this.h.fistGroup.rotation.z = FIST_ROT.z - 0.55 + ease * 0.95;
    return env;
  }
}
