import * as THREE from 'three';

import type { Terrain } from '../world/terrain.js';
import type { PlayerModel } from './PlayerModel.js';
import { BallTrailDots } from '../effects/ballTrails.js';
import { TrailDriver } from '../effects/vfxRuntime.js';
import { pickLocomotionAnim } from './locomotionAnim.js';
import type { AnimationState } from './playerClips.js';
import { bodyGroundLift, easeGroundLift } from './bodyGround.js';
import { classCapsule } from '../../../shared/botClasses.js';
import { glitch } from '../core/fxDiag.js';

// Model-anim drive — turns RemotePlayer's movement/state into PlayerModel
// animation: locomotion/jet/jump picks, landing pulse, air trail, shoot/hit
// oneshots and the distance-tiered mixer LOD. Split out of RemotePlayer so
// that file stays netcode; this family owns all its internal timers.

const _trailTint = new THREE.Color(0.75, 0.85, 1); // cool air-sheen — jets tint it warmer on top

/** Auto-quality override: gpu ladder ≥3 pins every remote to the
 *  decimated rig regardless of distance — skinned verts are the saving
 *  that scales with remote count, and resScale can't reach it. */
let _forcedRemoteLod: 0 | 1 | null = null;
export function setForcedRemoteLod(level: 0 | 1 | null): void { _forcedRemoteLod = level; }

export interface AnimHost {
  readonly playerId: string;
  readonly armorClass?: string;
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
  /** True while dead-reckoning/converge owns the body — those paths skip
   *  the terrain floor deliberately, so a buried sample during them is
   *  expected-transient, not an unbury-class anomaly. */
  readonly isSimulating: boolean;
  /** Last raw wire position — the buried alarm measures THIS, not the
   *  blended `position` (converge/DR artifacts aren't server truth). */
  readonly wirePosition: THREE.Vector3;
  /** Records stopped — the body is a frozen last-seen replica, and a
   *  buried sample on it measures wire staleness, not server ground. */
  readonly staleHidden: boolean;
  /** Render-only ground lift the body currently rides (written back so
   *  HUD markers anchor to the DRAWN body, not the logical feet). */
  renderLift: number;
  /** Client wall ms of the last wire update — a stale replica can read
   *  buried without the server being at fault; the alarm emits this so
   *  the next fire answers fresh-vs-stale instead of asking. */
  readonly lastUpdateTime: number;
  tickGhost(dt: number): void;
  tickAuras(dt: number): void;
}

/** Anim LOD table — Infinity = freeze everything (renderer already
 *  culls the skin, so only CPU bone evaluation was burning). Floor is
 *  15Hz — slower idle tiers read as steppy even at distance. */
export function pickAnimCadence(onScreen: boolean, camDistSq: number, _moving: boolean): number {
  if (onScreen === false) {return Infinity;}
  if (camDistSq > 120 * 120) {return 1 / 15;}
  if (camDistSq > 60 * 60) {return 1 / 30;}
  return 0;
}



export class RemoteAnim {
  // Damage flinch / shot recoil timers — fire()/flinch() on the host set
  // them; the shoot oneshot outranks the flinch so a trigger pull snaps
  // to aim instead of flailing through the hit with the weapon down.
  hitT = 0;
  shootT = 0;
  throwT = 0;
  private _lastShootT = 0;
  private _airborne = false;
  private _fallV = 0;
  private _speed = 0;
  // Faint air trail — the ballistic arc read a bouncing ball gets for
  // free. Innate to every flyer; the jetpack flame stacks on top.
  private airTrail: BallTrailDots | null = null;
  private trailDriver: TrailDriver | null = null;
  // Driver host state — tickAirTrail refreshes these; the driver's own
  // jump detection replaces the hand-rolled _lastTrailPos correction cut.
  private _trailAnchor = new THREE.Vector3();
  private _trailOn = false;
  private _trailDt = 0;
  private animAcc = 0;

  constructor(private h: AnimHost) {}

  dispose(): void {
    this.trailDriver?.release();
    this.trailDriver = null;
    this.airTrail?.dispose();
    this.airTrail = null;
  }

  private _groundLift = 0;
  private _buriedAcc = 0;
  private _buriedStreak = 0;

  /** Oneshot timers (throw/shoot/hit) pick the animation state while
   *  live. Returns true when one owns this frame — locomotion only runs
   *  on a free frame. A fired shot outranks the flinch: the shoot
   *  oneshot is itself an aimed pose, so a bot shooting mid-hit snaps
   *  its gun back to aim instead of flailing through the flinch. */
  private pickOneshot(dt: number): boolean {
    const {h} = this;
    if (this.throwT > 0) {
      this.throwT -= dt;
      // A belt/deploy swing outranks the armed pose — the arm is
      // committed to the throw, not the aim.
      if (this.throwT > 0) {h.model.setAnimationState('throw');}
      return true;
    }
    if (this.shootT > 0) {
      // Re-arm while already 'shoot' (auto fire) means a new shot —
      // force replays the clip from its aimed frame; otherwise the
      // oneshot plays once and every following pull shows nothing.
      if (this.shootT > this._lastShootT) {h.model.forceAnimationState('shoot');}
      this.shootT -= dt;
      if (this.shootT > 0) {h.model.setAnimationState('shoot');}
      return true;
    }
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT > 0) {h.model.setAnimationState('hit');}
      return true;
    }
    return false;
  }

  /** 0.3s buried-wire sampler. Measures the last WIRE position (eye →
   *  feet), not the blended render position: interp clamps to the
   *  rendered chord every frame and converge/DR deliberately skip the
   *  floor, so a blended-sample burial only proves the client moved the
   *  body — while a wire sample under the field IS the server's sim
   *  sunk. Skipped while simulating (starved wire isn't server truth). */
  private tickBuried(lift: number): void {
    const {h} = this;
    const w = h.wirePosition;
    const wFeet = w.y - classCapsule(h.armorClass).eye;
    const depth = w.lengthSq() === 0 ? 0
      : h.terrain!.getRenderedHeight(w.x, w.z) - wFeet; // (0,0,0) = no wire yet
    // wireMs > 2s: the sample is measuring a dead lane, not server truth
    // — a buried streak can't build on stale positions. The warn still
    // reports wireMs so a fresh-wire burial stays distinguishable.
    const wireFresh = Date.now() - h.lastUpdateTime < 2000;
    if (depth > 0.4 && !h.isSimulating && wireFresh) {
      this._buriedStreak += 1;
      // Streak 8 (~2.4s): the server unbury rescues every 0.5s, but a
      // tier-skipped remote's wire can still be holding pre-rescue
      // truth for another ~1.5s — 3 samples was inside that lag.
      if (this._buriedStreak >= 8) {
        glitch('remote-buried', { id: h.playerId, depth: Number(depth.toFixed(1)), lift: Number(lift.toFixed(1)), fieldD: Number((h.terrain!.getHeight(w.x, w.z) - wFeet).toFixed(1)), wireMs: Math.round(Date.now() - h.lastUpdateTime) });
      }
    } else {this._buriedStreak = 0;}
  }

  tickModel(dt: number): void {
    const {h} = this;
    if (!h.loaded || h.staleHidden) {return;}
    // Rendered-feet lift vs the drawn terrain chord (wire/sim truth
    // unchanged — aim, hits and the blob shadow stay on position). The
    // lift self-heals the legit under-field wire dips; a remote STILL
    // buried past the lift cap is the anomaly worth counting — the wire
    // is holding it deep enough that no render floor can cover.
    let lift = 0;
    if (h.terrain) {
      lift = easeGroundLift(this._groundLift,
        bodyGroundLift(h.terrain, h.position.x, h.position.z, h.feetY, classCapsule(h.armorClass).radius),
        dt);
      this._groundLift = lift;
      this._buriedAcc += dt;
      if (this._buriedAcc >= 0.3) {
        this._buriedAcc = 0;
        this.tickBuried(lift);
      }
    }
    h.renderLift = lift;
    h.model.setPosition(h.position.x, h.feetY + lift, h.position.z);
    h.model.setRotation(h.rotation.yaw, h.rotation.pitch, h.rotation.roll);
    // dt=0 (paused/first frame) would blow speed to Infinity → 'ski' flicker
    this._speed = dt > 0 ? h.position.distanceTo(h.previousPosition) / dt : 0;
    const speed = this._speed;
    // Airborne overrides locomotion — the speed check alone reads jetting
    // as "run", i.e. the robot sprinting on air. Feet clearly above
    // terrain → Jump pose; grounded/skiing keeps the walk/run cycle.
    const airborne = h.terrain
      ? h.feetY - h.terrain.getHeight(h.position.x, h.position.z) > 0.6
      : false;
    // Landing compress — peak fall speed at touchdown drives the pulse,
    // same cue the local model gets from onLand.
    if (airborne) {this._fallV = Math.min(this._fallV, h.velocity.y);}
    else if (this._airborne) { h.model.landPulse(-this._fallV); this._fallV = 0; }
    this._airborne = airborne;
    this.tickAirTrail(dt, airborne, speed);
    if (!this.pickOneshot(dt)) {this.tickAnimState(dt, speed, airborne);}
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
    const {h} = this;
    const moving = this._speed > 0.5 || this._airborne || this.shootT > 0 || this.hitT > 0 || this.throwT > 0;
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
    // Zero-coverage census — a visible remote whose mixer holds no
    // running action IS a T-pose report the stall guard inside didn't
    // catch (re-entry can re-park on another non-covering clip). Death's
    // clamped tail and paused oneshot clamps are legit stillness.
    this._coverAcc += dt;
    if (this._coverAcc >= 1.5) {
      this._coverAcc = 0;
      if (h.onScreen !== false && h.model.anim.currentState !== 'death') {
        const a = h.model.anim.currentAction;
        if (!a || (!a.isRunning() && !a.paused)) {
          glitch('anim-bind', { id: h.playerId, variant: h.model.variant, state: h.model.anim.currentState, clip: h.model.anim.currentClipName, clips: h.model.anim.animations.size });
        }
      }
    }
  }
  private _coverAcc = 0;

  /** Distance-tiered render budget — cast shadows, skinned geo LOD. */
  private tickRenderLod(): void {
    const {h} = this;
    // Shadow pass re-runs skinning on every caster — past ~80m a figure's
    // cast shadow is unreadable anyway, so far remotes drop out of it.
    const cast = h.camDistSq < 80 * 80;
    if (cast !== this._castShadow) { this._castShadow = cast; h.model.setCastShadow(cast); }
    // Past ~70m swap to the ~1.2k-tri decimated rig — vertex/skinning
    // cost per remote drops ~80% where the silhouette delta is unreadable.
    // Hysteresis keeps hovering players from flapping the swap each frame.
    // Forced LOD (auto-quality ladder) wins over distance — geometry shed
    // is the one saving that scales with remote count, not pixel count.
    let distLod = this._lodLevel;
    if (h.camDistSq > 70 * 70) {distLod = 1;}
    else if (h.camDistSq < 55 * 55) {distLod = 0;}
    const want = Math.max(distLod, _forcedRemoteLod ?? 0) as 0 | 1;
    if (want !== this._lodLevel) { this._lodLevel = want; h.model.setLod(want); }
  }
  private _castShadow = true;
  private _lodLevel: 0 | 1 = 0;
  private _bonesFrozen = false;
  private _distalFrozen = false;

  private tickAirTrail(dt: number, airborne: boolean, speed: number): void {
    const {h} = this;
    this._trailAnchor.copy(h.position); this._trailAnchor.y -= 0.7;
    this._trailOn = airborne && speed > 6;
    this._trailDt = dt;
    if (!this.trailDriver) {
      this.trailDriver = new TrailDriver(
        {
          pos: this._trailAnchor, vel: h.velocity,
          emitting: (): boolean => this._trailOn,
          emitOnJump: false, // a snapshot-correction sweep IS the streak to hide
          maxStep: (d): number => Math.max(6, this._speed * d * 4),
        },
        [{
          emitSegment: (): void => {
            if (!this.airTrail) {this.airTrail = new BallTrailDots(h.scene, { opacity: 0.32, sizeMul: 0.45, interval: 0.05, maxDots: 18 });}
            this.airTrail.emit(this._trailDt, this._trailAnchor, h.velocity, 0.4, _trailTint);
          },
          teleport: (): void => { /* dots fade fast — emit suppression is the cut */ },
        }],
      );
    }
    this.airTrail?.fade(dt);
  }

  // Powered climb reads as jetting (same inference the jet audio makes) —
  // a plain airborne fall keeps the jump loop. Directional jetting tilts
  // the whole body toward horizontal velocity in the facing frame: pitch
  // into forward thrust, roll into lateral strafe.
  private tickAnimState(dt: number, speed: number, airborne: boolean): void {
    const {h} = this;
    const jetting = airborne && h.velocity.y > 3;
    let state: AnimationState;
    if (airborne) {state = jetting ? 'jet' : 'jump';}
    else {state = pickLocomotionAnim(h.model.animationState, speed, h.wireSki);}
    h.model.setAnimationState(state);
    const sin = Math.sin(h.rotation.yaw), cos = Math.cos(h.rotation.yaw);
    const fwd = h.velocity.x * sin + h.velocity.z * cos;
    const side = h.velocity.x * cos - h.velocity.z * sin;
    // Dedicated 8-dir clips when the KevDev bake landed; otherwise the
    // reverse-playback backpedal + strafe roll lean keep covering it.
    const dedicated = h.model.setLocomotionVector(fwd, side);
    if (!dedicated) {h.model.setLocomotionReversed(
      (state === 'walk' || state === 'run') && speed > 1 && fwd < -0.6 * speed && -fwd > Math.abs(side));}
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
