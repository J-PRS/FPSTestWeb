import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import type { PlayerModel } from './PlayerModel.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import { pickLocomotionAnim } from './locomotionAnim.js';

// Model-anim drive — turns RemotePlayer's movement/state into PlayerModel
// animation: locomotion/jet/jump picks, landing pulse, air trail, shoot/hit
// oneshots and the distance-tiered mixer LOD. Split out of RemotePlayer so
// that file stays netcode; this family owns all its internal timers.

const _trailP = new THREE.Vector3();
const _trailTint = new THREE.Color(0.75, 0.85, 1.0); // cool air-sheen — jets tint it warmer on top

export interface AnimHost {
  readonly position: THREE.Vector3;
  /** Start-of-frame pos — speed derivation copies it out at the end. */
  readonly previousPosition: THREE.Vector3;
  readonly rotation: { yaw: number; pitch: number; roll: number };
  readonly velocity: THREE.Vector3;
  readonly feetY: number;
  readonly terrain: Terrain | null;
  readonly camDistSq: number;
  /** False while the body sits outside the camera frustum. */
  readonly onScreen: boolean;
  readonly scene: THREE.Scene;
  readonly model: PlayerModel;
  readonly loaded: boolean;
  wireSki: boolean | undefined;
  tickGhost(dt: number): void;
  tickAuras(dt: number): void;
}

export class RemoteAnim {
  // Damage flinch / shot recoil timers — fire()/flinch() on the host set
  // them; the shoot oneshot outranks the flinch so a trigger pull snaps
  // to aim instead of flailing through the hit with the weapon down.
  hitT = 0;
  shootT = 0;
  private _lastShootT = 0;
  private _airborne = false;
  private _fallV = 0;
  private _speed = 0;
  // Faint air trail — the ballistic arc read a bouncing ball gets for
  // free. Innate to every flyer; the jetpack flame stacks on top.
  private airTrail: BallTrailDots | null = null;
  private _lastTrailPos = new THREE.Vector3();
  private animAcc = 0;

  constructor(private h: AnimHost) {}

  dispose(): void {
    this.airTrail?.dispose();
    this.airTrail = null;
  }

  tickModel(dt: number): void {
    const h = this.h;
    if (!h.loaded) return;
    h.model.setPosition(h.position.x, h.feetY, h.position.z);
    h.model.setRotation(h.rotation.yaw, h.rotation.pitch, h.rotation.roll);
    // dt=0 (paused/first frame) would blow speed to Infinity → 'ski' flicker
    const speed = this._speed = dt > 0 ? h.position.distanceTo(h.previousPosition) / dt : 0;
    // Airborne overrides locomotion — the speed check alone reads jetting
    // as "run", i.e. the robot sprinting on air. Feet clearly above
    // terrain → Jump pose; grounded/skiing keeps the walk/run cycle.
    const airborne = h.terrain
      ? h.feetY - h.terrain.getHeight(h.position.x, h.position.z) > 0.6
      : false;
    // Landing compress — peak fall speed at touchdown drives the pulse,
    // same cue the local model gets from onLand.
    if (airborne) this._fallV = Math.min(this._fallV, h.velocity.y);
    else if (this._airborne) { h.model.landPulse(-this._fallV); this._fallV = 0; }
    this._airborne = airborne;
    this.tickAirTrail(dt, airborne, speed);
    // A fired shot outranks the flinch — the shoot oneshot is itself an
    // aimed pose, so a bot shooting mid-hit snaps its gun back to aim
    // instead of flailing through the flinch with the weapon down.
    if (this.shootT > 0) {
      // Re-arm while already 'shoot' (auto fire) means a new shot —
      // force replays the clip from its aimed frame; otherwise the
      // oneshot plays once and every following pull shows nothing.
      if (this.shootT > this._lastShootT) h.model.forceAnimationState('shoot');
      this.shootT -= dt;
      if (this.shootT > 0) h.model.setAnimationState('shoot');
    } else if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT > 0) h.model.setAnimationState('hit');
    } else {
      this.tickAnimState(dt, speed, airborne);
    }
    this._lastShootT = this.shootT;
    h.tickGhost(dt);
    h.tickAuras(dt);
    h.previousPosition.copy(h.position);
    this.stepMixer(dt);
    this.tickRenderLod();
  }

  /** Anim LOD — the mixer step is the dominant per-remote cost, so far
   *  bodies animate in coarser bursts (accumulated dt keeps playback
   *  speed correct) instead of a full mixer update every frame. Offscreen
   *  bodies get an Infinity cadence — the renderer already culls the skin,
   *  only CPU bone evaluation was still burning. */
  private stepMixer(dt: number): void {
    const h = this.h;
    const moving = this._speed > 0.5 || this._airborne || this.shootT > 0 || this.hitT > 0;
    const animDt = pickAnimCadence(h.onScreen, h.camDistSq, moving);
    // Frozen bones skip updateMatrixWorld entirely — valid only while the
    // mixer never runs (animDt Infinity), otherwise the pose stalls.
    const frozen = animDt === Infinity;
    if (frozen !== this._bonesFrozen) {
      this._bonesFrozen = frozen;
      h.model.setBonesFrozen(frozen);
      // Full freeze/unfreeze rewrites every bone's flag — the distal LOD
      // state below must be re-applied after it.
      h.model.setDistalFrozen(this._distalFrozen);
    }
    // Progressive bone LOD: past the 30Hz tier, freeze every bone no key
    // bone (aim/grip/feet/steady) hangs under — fingers, toes, end-markers
    // stop composing matrices while the core pose still animates.
    const distal = !frozen && animDt >= 1 / 30;
    if (distal !== this._distalFrozen) {
      this._distalFrozen = distal;
      h.model.setDistalFrozen(distal);
    }
    if (animDt > 0) {
      this.animAcc += dt;
      if (this.animAcc >= animDt) {
        h.model.update(this.animAcc);
        this.animAcc = 0;
      }
    } else {
      this.animAcc = 0;
      h.model.update(dt);
    }
  }

  /** Distance-tiered render budget — cast shadows, skinned geo LOD. */
  private tickRenderLod(): void {
    const h = this.h;
    // Shadow pass re-runs skinning on every caster — past ~80m a figure's
    // cast shadow is unreadable anyway, so far remotes drop out of it.
    const cast = h.camDistSq < 80 * 80;
    if (cast !== this._castShadow) { this._castShadow = cast; h.model.setCastShadow(cast); }
    // Past ~70m swap to the ~1.2k-tri decimated rig — vertex/skinning
    // cost per remote drops ~80% where the silhouette delta is unreadable.
    // Hysteresis keeps hovering players from flapping the swap each frame.
    if (this._lodLevel === 0 && h.camDistSq > 70 * 70) { this._lodLevel = 1; h.model.setLod(1); }
    else if (this._lodLevel === 1 && h.camDistSq < 55 * 55) { this._lodLevel = 0; h.model.setLod(0); }
  }
  private _castShadow = true;
  private _lodLevel: 0 | 1 = 0;
  private _bonesFrozen = false;
  private _distalFrozen = false;

  private tickAirTrail(dt: number, airborne: boolean, speed: number): void {
    const h = this.h;
    if (airborne && speed > 6 && this._lastTrailPos.distanceToSquared(h.position) < 225) {
      if (!this.airTrail) this.airTrail = new BallTrailDots(h.scene, { opacity: 0.32, sizeMul: 0.45, interval: 0.05, maxDots: 18 });
      _trailP.copy(h.position); _trailP.y -= 0.7;
      this.airTrail.emit(dt, _trailP, h.velocity, 0.4, _trailTint);
    }
    this.airTrail?.fade(dt);
    this._lastTrailPos.copy(h.position);
  }

  // Powered climb reads as jetting (same inference the jet audio makes) —
  // a plain airborne fall keeps the jump loop. Directional jetting tilts
  // the whole body toward horizontal velocity in the facing frame: pitch
  // into forward thrust, roll into lateral strafe.
  private tickAnimState(dt: number, speed: number, airborne: boolean): void {
    const h = this.h;
    const jetting = airborne && h.velocity.y > 3;
    const state = airborne
      ? (jetting ? 'jet' : 'jump')
      : pickLocomotionAnim(h.model.animationState, speed, h.wireSki);
    h.model.setAnimationState(state);
    const sin = Math.sin(h.rotation.yaw), cos = Math.cos(h.rotation.yaw);
    const fwd = h.velocity.x * sin + h.velocity.z * cos;
    const side = h.velocity.x * cos - h.velocity.z * sin;
    // Dedicated 8-dir clips when the KevDev bake landed; otherwise the
    // reverse-playback backpedal + strafe roll lean keep covering it.
    const dedicated = h.model.setLocomotionVector(fwd, side);
    if (!dedicated) h.model.setLocomotionReversed(
      (state === 'walk' || state === 'run') && speed > 1 && fwd < -0.6 * speed && -fwd > Math.abs(side));
    if (!jetting) {
      const strafing = !dedicated && Math.abs(side) > 0.6 * speed && Math.abs(side) > Math.abs(fwd) * 0.8;
      h.model.setBodyLean(0, strafing ? Math.max(-0.3, Math.min(0.3, -side * 0.02)) : 0);
      return;
    }
    h.model.setBodyLean(
      Math.max(-0.45, Math.min(0.45, fwd * 0.022)),
      Math.max(-0.4, Math.min(0.4, -side * 0.02)));
  }
}

/** Anim LOD table — Infinity = freeze everything (renderer already
 *  culls the skin, so only CPU bone evaluation was burning). Floor is
 *  15Hz — slower idle tiers read as steppy even at distance. */
export function pickAnimCadence(onScreen: boolean, camDistSq: number, _moving: boolean): number {
  if (onScreen === false) return Infinity;
  if (camDistSq > 120 * 120) return 1 / 15;
  if (camDistSq > 60 * 60) return 1 / 30;
  return 0;
}
