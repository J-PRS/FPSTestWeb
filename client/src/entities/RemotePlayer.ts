import * as THREE from 'three';

import { GRAVITY, EYE_OFFSET } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';

import { PlayerModel } from './PlayerModel.js';
import { CLASS_MODEL_SCALE } from '../../../shared/botClasses.js';
import { pickLocomotionAnim } from './locomotionAnim.js';
import { SnapshotBuffer } from './remoteSnapshots.js';
import { RemoteGizmo } from './remoteGizmo.js';
import { resetCorpse, launchCorpse, stepCorpse, type CorpseState } from './remoteDeath.js';
import { WeaponType } from '../../../shared/weapons.js';
import { RemoteAuras } from './remoteAuras.js';
import { BallTrailDots } from './ballTrails.js';

const logger = new ChildLogger('RemotePlayer');

/**
 * Remote player representation with animated 3D model
 * Renders other players in the multiplayer game
 */
let _remotePlayerInstanceCounter = 0;

// Networked position.y is EYE height (feet + EYE_OFFSET, see movement.ts
// checkIfGrounded). The robot model's origin is at its feet, so the model
// must render EYE_OFFSET below the networked position.

// Scratch — shared across RemotePlayer instances, never retained past the call
const _extrapolated = new THREE.Vector3();
const _trailP = new THREE.Vector3();
const _trailTint = new THREE.Color(0.75, 0.85, 1.0); // cool air-sheen — jets tint it warmer on top
const _sampledRot = { yaw: 0, pitch: 0 };

export class RemotePlayer {
  // Snapshot buffer + adaptive interp delay — the pure netcode half lives
  // in remoteSnapshots.ts (unit-testable, no scene deps)
  private net = new SnapshotBuffer();

  position: THREE.Vector3;
  /** Feet height — `position.y` is the networked EYE height; convert
   *  explicitly here instead of inline `- 1.8` at call sites (that's how
   *  the hitbox-vs-gizmo drift bug happened). */
  get feetY(): number { return this.position.y - EYE_OFFSET; }
  rotation: { yaw: number; pitch: number; roll: number };
  playerId: string;
  readonly instanceId: number;
  private _model: PlayerModel;
  private previousPosition: THREE.Vector3;
  private _loaded: boolean = false;
  private _isDead: boolean = false;
  private gizmo: RemoteGizmo | null = null;
  scene: THREE.Scene; // public — RemoteAuras builds bubbles in it
  // Shield bubble + status auras (mend/regen/dd/charge) — the lazy-glow
  // plumbing lives in remoteAuras.ts behind the AuraHost surface.
  private auras = new RemoteAuras(this);
  protected velocity: THREE.Vector3 = new THREE.Vector3();
  private angularVelocity: THREE.Vector3 = new THREE.Vector3();
  private isOnGround: boolean = true;
  private terrain: Terrain | null = null;
  private corpse!: CorpseState; // ctor assigns — aliases live position/vel/rotation refs
  private targetPosition: THREE.Vector3;
  private targetRotation: { yaw: number; pitch: number };
  private ping: number = 0; // Connection ping in milliseconds
  private _lastUpdateTime: number = 0; // Timestamp of last position update
  private _isSimulating: boolean = false; // True if we're simulating physics (dead reckoning)
  private simulatedVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity during simulation
  private predictionTimer: number = 0; // Seconds of forced local prediction (bridges server round-trip)
  protected serverVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity reported by server
  private lastServerUpdateMs: number = 0; // Timestamp of last server update (ms)
  private reconcileBlend: number = 0; // Blends from predicted to server position (0 = done)
  private gizmoMismatchLogTimer: number = 0; // Throttle for gizmo mismatch warnings
  private lastServerPosition: THREE.Vector3 = new THREE.Vector3(); // Last raw server position (for velocity estimation)

  // Public getters for main.ts access (removes need for (as any) casts)
  get lastUpdateTime(): number { return this._lastUpdateTime; }
  // Alias for the Forceable interface (Player/Ball use `pos`, we use `position`)
  get pos(): THREE.Vector3 { return this.position; }
  get isDead(): boolean { return this._isDead; }
  get scale(): number { return this.corpse.scale; }
  get isSimulating(): boolean { return this._isSimulating; }
  /** Local authority (GameBot): position is written directly each frame,
   *  so the snapshot interp / dead-reckoning path would fight it — tick
   *  short-circuits to model+gizmo upkeep only. */
  localDriven = false;
  get loaded(): boolean { return this._loaded; }
  get model(): PlayerModel { return this._model; }
  // Server-reported velocity (for dust/trail effects); falls back to position-derived estimate
  get vel(): THREE.Vector3 {
    return this.serverVelocity.lengthSq() > 0.01 ? this.serverVelocity : this.velocity;
  }

  // Hard-sync position + all interpolation/simulation state to `pos`
  // (used by the ?dummy debug hook — suppresses dead reckoning drift)
  /** Armor-tier silhouette — heavy reads bulkier, light slimmer. Applied
   *  post-load because the GLB path sets its own fit scale. */
  private _classScale = 1;
  setClass(cls?: string): void {
    this._classScale = cls === 'heavy' ? CLASS_MODEL_SCALE.heavy : cls === 'light' ? CLASS_MODEL_SCALE.light : 1;
    if (this._loaded) this.applyClassScale();
  }
  private applyClassScale(): void {
    this._model.setScale(this._classScale);
  }

  teleportTo(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.previousPosition.copy(pos);
    this.targetPosition.copy(pos);
    this.net.clear();
    this._lastUpdateTime = Date.now();
    this._isSimulating = false;
  }

  constructor(scene: THREE.Scene, playerId: string, startPos: { x: number; y: number; z: number }, terrain?: Terrain, _armorClass?: string) {
    this.instanceId = ++_remotePlayerInstanceCounter;
    this.scene = scene;
    this.playerId = playerId;
    this.position = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    this.previousPosition = this.position.clone();
    this.rotation = { yaw: 0, pitch: 0, roll: 0 };
    this._isDead = false; // Reset death state on construction
    this.terrain = terrain || null;
    this.corpse = {
      position: this.position, velocity: this.velocity,
      angularVelocity: this.angularVelocity, rotation: this.rotation,
      landed: false, landedAt: 0, scale: 1,
    };
    this.targetPosition = this.position.clone();
    this.targetRotation = { yaw: 0, pitch: 0 };
    this._lastUpdateTime = Date.now(); // Initialize to current time to prevent immediate dead reckoning
    this.lastServerUpdateMs = this.lastUpdateTime;
    this.lastServerPosition.copy(this.position);

    this.gizmo = new RemoteGizmo(scene, startPos);
    logger.debug(`GIZMO ADDED`, { playerId, instanceId: this.instanceId });

    // Everyone wears the UAL mannequin — the class reads through the
    // 1.15/0.92 silhouette scale (a chibi knight read as a different game).
    // Fixed at spawn (a mid-match class swap lands next join).
    this._model = new PlayerModel(scene, 'mannequin');
    this.model.load().then(() => {
      this._loaded = true;
      this.applyClassScale();
      this.model.setPosition(this.position.x, this.position.y - EYE_OFFSET, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch);
      // Shield may have gone up before the GLB landed (sphere fallback)
      // — upgrade it to the contoured shell once the bones exist.
      this.auras.upgradeContoured();
      // Show collider gizmo for remote players (unless already dead or stale-hidden)
      if (!this._isDead && !this.staleHidden) {
        this._model.setColliderVisible(true);
      }
      // Model may have been hidden while the GLB was still loading — reapply
      if (this.staleHidden) {
        this._model.setVisible(false);
      }
      logger.debug(`MODEL LOADED`, { playerId, instanceId: this.instanceId, isDead: this._isDead });
    });
  }

  update(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, dt: number, ping: number = 0, serverVelocity?: { x: number; y: number; z: number }): void {
    // Update last update timestamp
    const prevUpdateMs = this.lastServerUpdateMs;
    this._lastUpdateTime = Date.now();
    this.lastServerUpdateMs = this._lastUpdateTime;

    // If we were simulating and now got an update, stop simulating and start blending
    // But keep predicting if we're within the prediction window (server hasn't caught up yet)
    if (this._isSimulating && this.predictionTimer <= 0) {
      this._isSimulating = false;
      // Don't hard-snap — blend to server position over ~100ms to avoid visual jump
      this.reconcileBlend = 0.1;
      logger.debug(`RESUMED updates, blending to server position`, { playerId: this.playerId });
    }

    // Update ping for interpolation adjustments
    this.ping = ping;
    // Store target position/rotation for interpolation
    this.targetPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.targetRotation = { yaw: targetRotation.yaw, pitch: targetRotation.pitch };

    // Push onto the snapshot buffer — it also tracks arrival jitter and
    // adapts the render delay (see remoteSnapshots.ts)
    this.net.push(
      this.lastServerUpdateMs,
      targetPosition,
      targetRotation,
      serverVelocity ?? { x: 0, y: 0, z: 0 },
    );

    // Store server-reported velocity for extrapolation
    if (serverVelocity) {
      this.serverVelocity.set(serverVelocity.x, serverVelocity.y, serverVelocity.z);
    }

    // Estimate velocity from consecutive server positions (not extrapolated position)
    // Skip during prediction window — server hasn't reflected the knockback yet
    if (this.predictionTimer <= 0) {
      if (this.lastServerPosition.lengthSq() > 0) {
        const serverDt = (this.lastUpdateTime - prevUpdateMs) / 1000;
        if (serverDt > 0) {
          this.simulatedVelocity.set(
            (targetPosition.x - this.lastServerPosition.x) / serverDt,
            (targetPosition.y - this.lastServerPosition.y) / serverDt,
            (targetPosition.z - this.lastServerPosition.z) / serverDt
          );
        }
      }
      this.lastServerPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    }
    // NOTE: death physics (gravity, bounce, tumble, shrink) are handled in tick()
    // so they run every frame at the real dt — running them here at 20Hz with a
    // fixed dt made dead bodies fall/tumble at ~32% speed and look choppy.
  }

  // Called every frame for smooth interpolation
  tick(dt: number, camPos?: THREE.Vector3): void {
    if (camPos) {
      const dx = this.position.x - camPos.x, dz = this.position.z - camPos.z;
      this.camDistSq = dx * dx + dz * dz;
    }
    if (this._isDead) {
      this.tickDead(dt);
      return;
    }
    this.tickAlive(dt);
  }

  /** XZ distance² to the camera — gates the remote anim-LOD tiers below. */
  private camDistSq = 0;
  /** Accumulated dt the mixer still owes — far remotes animate in bursts
   *  at a lower cadence instead of paying a full mixer step every frame. */
  private animAcc = 0;

  // Death physics (ragdoll-like rigidbody) run every frame at the real dt so
  // bodies fall/tumble/shrink at full speed and smoothly. Moved here from
  // update() which only fires at ~20Hz with a fixed dt — and now extracted
  // to remoteDeath.ts.
  private tickDead(dt: number): void {
    stepCorpse(this.corpse, dt, this.terrain);

    // Update model if loaded (position/rotation/scale/animation)
    if (this._loaded) {
      this._model.setPosition(this.position.x, this.position.y - EYE_OFFSET, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);
      if (this.corpse.scale !== 1.0) {
        this._model.setScale(this.corpse.scale);
      }
      this._model.update(dt);
    }
  }

  private tickAlive(dt: number): void {
    // Dead reckoning trigger scaled to the measured update cadence: ~2 missed
    // packets at that player's actual send rate. Fixed 300/450ms thresholds
    // flapped DR on/off when heartbeats arrived slower than their nominal
    // 250ms interval (dr threshold straddled the real cadence).
    const drThreshold = Math.min(1500, Math.max(350, this.net.arrivalInterval * 2.5));
    const timeSinceUpdate = Date.now() - this._lastUpdateTime;
    if (timeSinceUpdate > drThreshold && !this._isSimulating && !this.localDriven) {
      this._isSimulating = true;
      logger.debug(`STARTING dead reckoning`, { playerId: this.playerId, silentMs: timeSinceUpdate });
    }

    if (this._isSimulating) {
      if (this.predictionTimer > 0) {
        this.predictionTimer = Math.max(0, this.predictionTimer - dt);
      }
      this.simulatePhysics(dt);
    } else if (!this.localDriven) {
      this.interpolate(dt);
    }
    // localDriven: position/rotation were already written by the owner —
    // interpolating would stomp them with a delayed snapshot sample.

    this.updateAliveModel(dt);

    this.gizmo?.follow(this.position);
  }

  // Sample the snapshot buffer at renderTime = now - adaptive interp delay
  // (the math lives in remoteSnapshots.ts — Hermite tangents from the
  // server-reported velocities, linear fallback on wild overshoot)
  private sampleSnapshots(outPos: THREE.Vector3, outYawPitch: { yaw: number; pitch: number }): void {
    this.net.sample(outPos, outYawPitch,
      this.targetPosition, this.targetRotation.yaw, this.targetRotation.pitch);
  }

  // Interpolate between buffered server snapshots (skipped during
  // dead-reckoning simulation)
  private interpolate(dt: number): void {
    const sampledPos = _extrapolated;
    const sampledRot = _sampledRot;
    this.sampleSnapshots(sampledPos, sampledRot);

    if (this.reconcileBlend > 0) {
      // Reconciliation blend: recovering from simulation, ease onto the
      // sampled path instead of snapping
      this.reconcileBlend = Math.max(0, this.reconcileBlend - dt);
      const blendStrength = Math.min(1, dt / Math.max(0.001, this.reconcileBlend + dt));
      this.position.lerp(sampledPos, blendStrength);
    } else {
      // Directly place on the interpolated path — smooth by construction
      this.position.copy(sampledPos);
    }

    // Per-remote position spam removed — positions are inspectable via
    // ?debug state wiring (core/stateDebug.ts) instead of a 2s log timer

    // Rotation comes straight from the sampled interpolation (already smoothed)
    this.rotation.yaw = sampledRot.yaw;
    this.rotation.pitch = sampledRot.pitch;
    this.rotation.roll = 0; // Roll is not networked, only used for death physics

    // Update velocity for extrapolation (estimate from recent movement)
    if (dt > 0) {
      this.velocity.x = (this.position.x - this.previousPosition.x) / dt;
      this.velocity.y = (this.position.y - this.previousPosition.y) / dt;
      this.velocity.z = (this.position.z - this.previousPosition.z) / dt;
    }
  }

  /** Faint dots on the flight path — readable arc on a jetting bot,
   *  subtle enough not to pile on the jetpack flame itself. Emits at
   *  chest (eye −0.7); a >15m jump (teleport/respawn edge) drops the
   *  frame rather than streaking a dotted line across the map. */
  private tickAirTrail(dt: number, airborne: boolean, speed: number): void {
    if (airborne && speed > 6 && this._lastTrailPos.distanceToSquared(this.position) < 225) {
      if (!this.airTrail) this.airTrail = new BallTrailDots(this.scene, { opacity: 0.32, sizeMul: 0.45, interval: 0.05, maxDots: 18 });
      _trailP.copy(this.position); _trailP.y -= 0.7;
      this.airTrail.emit(dt, _trailP, this.velocity, 0.4, _trailTint);
    }
    this.airTrail?.fade(dt);
    this._lastTrailPos.copy(this.position);
  }

  private updateAliveModel(dt: number): void {
    if (!this._loaded) return;
    this._model.setPosition(this.position.x, this.position.y - EYE_OFFSET, this.position.z);
    this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);
    // dt=0 (paused/first frame) would blow speed to Infinity → 'ski' flicker
    const speed = dt > 0 ? this.position.distanceTo(this.previousPosition) / dt : 0;
    // Airborne overrides locomotion — the speed check alone reads jetting
    // as "run", i.e. the robot sprinting on air. Feet clearly above
    // terrain → Jump pose; grounded/skiing keeps the walk/run cycle.
    const airborne = this.terrain
      ? this.feetY - this.terrain.getHeight(this.position.x, this.position.z) > 0.6
      : false;
    // Landing compress — peak fall speed at touchdown drives the pulse,
    // same cue the local model gets from onLand.
    if (airborne) this._fallV = Math.min(this._fallV, this.velocity.y);
    else if (this._airborne) { this._model.landPulse(-this._fallV); this._fallV = 0; }
    this._airborne = airborne;
    this.tickAirTrail(dt, airborne, speed);
    // A fired shot outranks the flinch — the shoot oneshot is itself an
    // aimed pose, so a bot shooting mid-hit snaps its gun back to aim
    // instead of flailing through the flinch with the weapon down.
    if (this.shootT > 0) {
      // Re-arm while already 'shoot' (auto fire) means a new shot —
      // force replays the clip from its aimed frame; otherwise the
      // oneshot plays once and every following pull shows nothing.
      if (this.shootT > this._lastShootT) this._model.forceAnimationState('shoot');
      this.shootT -= dt;
      if (this.shootT > 0) this._model.setAnimationState('shoot');
    } else if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT > 0) this._model.setAnimationState('hit');
    } else {
      this.tickAnimState(dt, speed, airborne);
    }
    this._lastShootT = this.shootT;
    this.tickGhost(dt);
    this.tickAuras(dt);
    this.previousPosition.copy(this.position);
    // Anim LOD — the mixer step is the dominant per-remote cost, so far
    // bodies animate in coarser bursts (accumulated dt keeps playback
    // speed correct) instead of a full mixer update every frame. State
    // changes and oneshots still apply every frame; only playback ticks.
    const animDt = this.camDistSq > 120 * 120 ? 1 / 15
      : this.camDistSq > 60 * 60 ? 1 / 30
      : 0;
    if (animDt > 0) {
      this.animAcc += dt;
      if (this.animAcc >= animDt) {
        this._model.update(this.animAcc);
        this.animAcc = 0;
      }
    } else {
      this.animAcc = 0;
      this._model.update(dt);
    }
  }

  // Powered climb reads as jetting (same inference the jet audio makes) —
  // a plain airborne fall keeps the jump loop. Directional jetting tilts
  // the whole body toward horizontal velocity in the facing frame: pitch
  // into forward thrust, roll into lateral strafe.
  /** Wire ski flag, set by remotes.ts from playerState.ski — the anim pick
   *  trusts it over the speed heuristic: a grounded non-skiing mover is
   *  running, not sliding, even at ski speeds (momentum outlives the key). */
  wireSki: boolean | undefined;
  // Real jet claim when a driver knows it (bots write their brain's jet
  // button + yeet). Network remotes leave it undefined — the wire has no
  // jet bit, so callers fall back to the vel.y heuristic.
  wireJet: boolean | undefined;

  private tickAnimState(dt: number, speed: number, airborne: boolean): void {
    const jetting = airborne && this.velocity.y > 3;
    const state = airborne
      ? (jetting ? 'jet' : 'jump')
      : pickLocomotionAnim(this._model.animationState, speed, this.wireSki);
    this._model.setAnimationState(state);
    const sin = Math.sin(this.rotation.yaw), cos = Math.cos(this.rotation.yaw);
    const fwd = this.velocity.x * sin + this.velocity.z * cos;
    const side = this.velocity.x * cos - this.velocity.z * sin;
    // Dedicated 8-dir clips when the KevDev bake landed; otherwise the
    // reverse-playback backpedal + strafe roll lean keep covering it.
    const dedicated = this._model.setLocomotionVector(fwd, side);
    if (!dedicated) this._model.setLocomotionReversed(
      (state === 'walk' || state === 'run') && speed > 1 && fwd < -0.6 * speed && -fwd > Math.abs(side));
    if (!jetting) {
      const strafing = !dedicated && Math.abs(side) > 0.6 * speed && Math.abs(side) > Math.abs(fwd) * 0.8;
      this._model.setBodyLean(0, strafing ? Math.max(-0.3, Math.min(0.3, -side * 0.02)) : 0);
      return;
    }
    this._model.setBodyLean(
      Math.max(-0.45, Math.min(0.45, fwd * 0.022)),
      Math.max(-0.4, Math.min(0.4, -side * 0.02)));
  }
  private _lastShootT = 0;
  private _airborne = false;
  private _fallV = 0;
  // Faint air trail — the ballistic arc read a bouncing ball gets for
  // free. Innate to every flyer; the jetpack flame stacks on top.
  private airTrail: BallTrailDots | null = null;
  private _lastTrailPos = new THREE.Vector3();

  private tickAuras(dt: number): void {
    this.auras.tick(dt);
  }

  // Damage flinch / shot recoil timers — drive the oneshot states in
  // updateAliveModel; shoot outranks hit so a trigger pull snaps to aim
  private hitT = 0;
  private shootT = 0;

  /** Non-lethal hit feedback — the model plays the 'No' flinch briefly. */
  flinch(): void {
    if (!this._isDead) this.hitT = 0.35;
    if (this._loaded) this._model.damageFlash(); // creature-style white pop
    this.auras.flashShield(); // soaked — flare the lattice
  }

  playDeath(explosionPos?: THREE.Vector3, explosionForce?: number): void {
    this._isDead = true;
    this.hitT = 0;
    // Alive-path visual state (jet/strafe lean, reversed walk) is dead
    // code under tickDead — leave it set and the corpse keeps the lean.
    this._model.setBodyLean(0, 0);
    this._model.setLocomotionReversed(false);
    resetCorpse(this.corpse);
    launchCorpse(this.corpse, explosionPos, explosionForce);

    // Remove gizmo from scene immediately on death
    if (this.gizmo) {
      this.gizmo.detach();
      logger.debug(`GIZMO REMOVED on death`, { playerId: this.playerId });
    }

    // Remove collider gizmo from scene on death (not just hide it)
    this.model.removeColliderGizmo();
  }

  /** Team tint on the name ring — Nugget Wars bots use it; server players
   *  could too once teamAssign lands on the wire. */
  setGizmoColor(hex: number): void {
    this.gizmo?.setColor(hex);
  }

  hide(): void {
    this.model.setVisible(false);
    this.gizmo?.hide();
    this.auras.hide();
  }

  show(): void {
    this.model.setVisible(true);
    // Only add collider if model is loaded (colliderGizmo exists)
    if (this.loaded) {
      this.model.addColliderGizmo();
    }
    this.gizmo?.attach();
    this.auras.show();
  }

  // Simulate physics when player stops sending updates (dead reckoning)
  simulatePhysics(dt: number): void {
    if (this._isDead) return; // Don't simulate if already dead (death physics handles it)

    // Apply gravity
    this.simulatedVelocity.y += GRAVITY * dt;

    // No air friction — matches game physics (local player has no air drag)

    // Apply velocity
    this.position.x += this.simulatedVelocity.x * dt;
    this.position.y += this.simulatedVelocity.y * dt;
    this.position.z += this.simulatedVelocity.z * dt;

    // Ground collision
    if (this.terrain) {
      const groundY = this.terrain.getHeight(this.position.x, this.position.z);
      if (this.position.y < groundY + EYE_OFFSET) { // keep EYE at eye height above feet
        this.position.y = groundY + EYE_OFFSET;
        this.simulatedVelocity.y = 0;
        this.simulatedVelocity.x *= 0.9; // Friction
        this.simulatedVelocity.z *= 0.9;
      }
    }
  }

  respawn(position: { x: number; y: number; z: number }): void {
    this._isDead = false;
    resetCorpse(this.corpse);
    // Corpse shrink writes the MODEL's scale directly — reset it here or
    // a respawned player keeps the shrunken size forever (tickAlive never
    // re-asserts scale). Class scale, not 1: heavies respawn bulky.
    this._model.setScale(this._classScale);
    this.position.set(position.x, position.y, position.z);
    this.previousPosition.copy(this.position);
    this.targetPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.simulatedVelocity.set(0, 0, 0);
    this.serverVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    // Corpse tumble left pitch/roll on the shared rotation — network
    // remotes clear roll in interpolate() every frame, but localDriven
    // bodies (GameBot) never do, so they respawned lying on their side.
    this.rotation.pitch = 0;
    this.rotation.roll = 0;
    this.isOnGround = true;
    this._isSimulating = false;
    this.net.clear();
    this.predictionTimer = 0;
    this.reconcileBlend = 0;
    this.lastServerPosition.copy(this.position);
    this.lastServerUpdateMs = Date.now();
    this._lastUpdateTime = Date.now();
    if (!this.cloakHidden) this.show();
  }

  // Staleness gate: hide players whose updates stopped arriving (backgrounded
  // tabs keep their socket open but stop simulating). Auto-reshow on resume.
  // Public fields — RemoteAuras reads them to gate aura visibility.
  staleHidden = false;
  cloakHidden = false;
  setStaleHidden(hidden: boolean): void {
    if (hidden === this.staleHidden) return;
    this.staleHidden = hidden;
    if (hidden) this.hide(); else if (!this.cloakHidden) this.show();
  }

  // Server-authoritative cloak — separate flag from staleHidden because a
  // decloak must restore visibility even while a stale socket stays hidden.
  setCloakHidden(hidden: boolean): void {
    if (hidden === this.cloakHidden) return;
    this.cloakHidden = hidden;
    if (hidden) this.hide(); else if (!this.staleHidden) this.show();
  }
  get isCloakHidden(): boolean { return this.cloakHidden; }

  setShielded(on: boolean): void { this.auras.setShielded(on); }
  get isShielded(): boolean { return this.auras.isShielded; }

  setMending(on: boolean): void { this.auras.setMending(on); }
  get isMending(): boolean { return this.auras.isMending; }
  setRegenAura(on: boolean): void { this.auras.setRegenAura(on); }
  setDdAura(on: boolean): void { this.auras.setDdAura(on); }
  setCharged(on: boolean): void { this.auras.setCharged(on); }

  // Belt throws arrive as ordinary projectileCreated spawns — the throw
  // tell lives on the shooter's model, keyed off the spawned weaponType.
  // Sticky(18) is ambiguous (launcher AND belt share it) so it stays a
  // plain shot; a wrong dip is worse than a missing one.
  private static readonly THROW_TYPES = new Set([
    WeaponType.DiscPull, WeaponType.Grenade, WeaponType.ClusterBomb,
    WeaponType.Javelin, WeaponType.ImpactGrenade, WeaponType.RemoteRailgun,
    WeaponType.ArmorGrenade,
  ]);

  // Remote fired a weapon — kick the gun's procedural recoil
  fire(weaponType?: number): void {
    // The mannequin's shot feedback is the recoil kick + muzzle flash —
    // its arm-chain aim layer owns the upper body, so playing the
    // Pistol_Shoot clip only flickers the arms off-aim. Other variants
    // still arm the shoot oneshot.
    if (!this._isDead && this.shootT <= 0 && this._model.variant !== 'mannequin') this.shootT = 0.3;
    if (this._loaded) {
      if (weaponType === WeaponType.Melee) this._model.weaponPunch();
      else if (weaponType !== undefined && RemotePlayer.THROW_TYPES.has(weaponType)) this._model.weaponThrow();
      else this._model.fire(weaponType);
    }
    // Firing decloaks: a cloaked shooter shimmers visible for a beat —
    // the price of shooting from stealth.
    if (this.cloakHidden && this._loaded) {
      this.ghostT = 1;
      this._model.setGhost(true);
      this.model.setVisible(true);
    }
  }

  private ghostT = 0;
  private tickGhost(dt: number): void {
    if (this.ghostT <= 0) return;
    this.ghostT -= dt;
    if (this.ghostT > 0) return;
    this._model.setGhost(false);
    if (this.cloakHidden || this.staleHidden) this.model.setVisible(false);
  }

  // Predicted knockback: run the victim through dead reckoning for ~1 RTT
  // while the real impulse (server → victim client → position updates)
  // travels the network. Seeds with the victim's last server velocity +
  // the exact server impulse math (dir*mag XZ, 0.5*mag up / 0.3 pull).
  // Snapshots are cleared so interpolation can't resample the pre-hit path
  // after the window — that stale-buffer resample was the old snap-back bug.
  applyPredictedKnockback(fromPos: THREE.Vector3, impulseMag: number, pull = false): void {
    const dx = this.position.x - fromPos.x;
    const dy = this.position.y - fromPos.y;
    const dz = this.position.z - fromPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    this.simulatedVelocity.copy(this.serverVelocity);
    const s = pull ? -1 : 1;
    this.simulatedVelocity.x += (dx / dist) * impulseMag * s;
    this.simulatedVelocity.y += (pull ? 0.3 : 0.5) * impulseMag;
    this.simulatedVelocity.z += (dz / dist) * impulseMag * s;
    this.net.clear();
    this._isSimulating = true;
    // Window: ping + one server tick + interp delay, clamped
    this.predictionTimer = Math.min(0.6, Math.max(0.15, (this.ping + 200) / 1000));
  }

  // simulatePhysics() remains for genuine packet-loss dead reckoning.

  dispose(): void {
    logger.debug(`DISPOSE called`, { playerId: this.playerId, instanceId: this.instanceId });
    // Drop the loaded flag too — a dangling tick (debug hooks, orphaned
    // owner loop) must not walk into a cleared animation map.
    this._loaded = false;
    this.auras.dispose();
    this.airTrail?.dispose();
    this._model.dispose();
    if (this.gizmo) {
      this.gizmo.dispose();
      this.gizmo = null;
      logger.debug(`GIZMO REMOVED`, { playerId: this.playerId, instanceId: this.instanceId });
    }
  }
}
