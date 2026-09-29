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
import { makeShieldBubble, ShieldBubble } from '../effects/shieldBubble.js';

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
  private scene: THREE.Scene;
  // Energy-shield bubble — lazily built on first use so un-shielded remotes
  // cost nothing. Lives at scene level (not inside the model) so cloak's
  // setVisible(false) can't silently take it down with the body.
  private shieldBubble: ShieldBubble | null = null;
  private _shielded = false;
  private mendAura: ShieldBubble | null = null;
  private _mending = false;
  private regenAura: ShieldBubble | null = null;
  private _regenAura = false;
  private ddAura: ShieldBubble | null = null;
  private _ddAura = false;
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
      // Show collider gizmo for remote players (unless already dead or stale-hidden)
      if (!this._isDead && !this._staleHidden) {
        this._model.setColliderVisible(true);
      }
      // Model may have been hidden while the GLB was still loading — reapply
      if (this._staleHidden) {
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
      targetPosition.x, targetPosition.y, targetPosition.z,
      targetRotation.yaw, targetRotation.pitch,
      serverVelocity?.x ?? 0, serverVelocity?.y ?? 0, serverVelocity?.z ?? 0,
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
    // Damage flinch outranks locomotion briefly — 'hit' is a oneshot clip,
    // so once the timer expires the normal pick reclaims the model.
    // A fired shot likewise pops a short 'shoot' pose underneath flinch.
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT > 0) this._model.setAnimationState('hit');
    } else if (this.shootT > 0) {
      this.shootT -= dt;
      if (this.shootT > 0) this._model.setAnimationState('shoot');
    } else {
      // Powered climb reads as jetting (same inference the jet audio makes)
      // — a plain airborne fall keeps the jump loop.
      const jetting = airborne && this.velocity.y > 3;
      this._model.setAnimationState(airborne
        ? (jetting ? 'jet' : 'jump')
        : pickLocomotionAnim(this._model.animationState, speed));
      // Directional jetting: tilt the whole body toward horizontal
      // velocity in the facing frame — pitch into forward thrust, roll
      // into lateral strafe. Airborne-but-falling eases back to level.
      if (jetting) {
        const sin = Math.sin(this.rotation.yaw), cos = Math.cos(this.rotation.yaw);
        const fwd = this.velocity.x * sin + this.velocity.z * cos;
        const side = this.velocity.x * cos - this.velocity.z * sin;
        this._model.setBodyLean(
          Math.max(-0.45, Math.min(0.45, fwd * 0.022)),
          Math.max(-0.4, Math.min(0.4, -side * 0.02)));
      } else {
        this._model.setBodyLean(0, 0);
      }
    }
    if (this.shieldBubble) {
      this.shieldBubble.update(dt);
      if (this._shielded) this.shieldBubble.mesh.position.set(this.position.x, this.position.y - EYE_OFFSET + 1.1, this.position.z);
    }
    if (this.mendAura) {
      this.mendAura.update(dt);
      if (this._mending) this.mendAura.mesh.position.set(this.position.x, this.position.y - EYE_OFFSET + 1.0, this.position.z);
    }
    if (this.regenAura) {
      this.regenAura.update(dt);
      if (this._regenAura) this.regenAura.mesh.position.set(this.position.x, this.position.y - EYE_OFFSET + 1.0, this.position.z);
    }
    if (this.ddAura) {
      this.ddAura.update(dt);
      if (this._ddAura) this.ddAura.mesh.position.set(this.position.x, this.position.y - EYE_OFFSET + 1.0, this.position.z);
    }
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

  // Damage flinch / shot recoil timers — drive the oneshot states in
  // updateAliveModel; hit outranks shoot so a flinch still reads mid-fight
  private hitT = 0;
  private shootT = 0;

  /** Non-lethal hit feedback — the model plays the 'No' flinch briefly. */
  flinch(): void {
    if (!this._isDead) this.hitT = 0.35;
    if (this._loaded) this._model.damageFlash(); // creature-style white pop
    if (this._shielded) this.shieldBubble?.flash(); // soaked — flare the lattice
  }

  playDeath(explosionPos?: THREE.Vector3, explosionForce?: number): void {
    this._isDead = true;
    this.hitT = 0;
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
    if (this.shieldBubble) this.shieldBubble.mesh.visible = false;
    if (this.mendAura) this.mendAura.mesh.visible = false;
    if (this.regenAura) this.regenAura.mesh.visible = false;
    if (this.ddAura) this.ddAura.mesh.visible = false;
  }

  show(): void {
    this.model.setVisible(true);
    // Only add collider if model is loaded (colliderGizmo exists)
    if (this.loaded) {
      this.model.addColliderGizmo();
    }
    this.gizmo?.attach();
    if (this.shieldBubble && this._shielded) this.shieldBubble.mesh.visible = true;
    if (this.mendAura && this._mending) this.mendAura.mesh.visible = true;
    if (this.regenAura && this._regenAura) this.regenAura.mesh.visible = true;
    if (this.ddAura && this._ddAura) this.ddAura.mesh.visible = true;
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
    // re-asserts scale).
    this._model.setScale(1);
    this.position.set(position.x, position.y, position.z);
    this.previousPosition.copy(this.position);
    this.targetPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.simulatedVelocity.set(0, 0, 0);
    this.serverVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.isOnGround = true;
    this._isSimulating = false;
    this.net.clear();
    this.predictionTimer = 0;
    this.reconcileBlend = 0;
    this.lastServerPosition.copy(this.position);
    this.lastServerUpdateMs = Date.now();
    this._lastUpdateTime = Date.now();
    if (!this._cloakHidden) this.show();
  }

  // Staleness gate: hide players whose updates stopped arriving (backgrounded
  // tabs keep their socket open but stop simulating). Auto-reshow on resume.
  private _staleHidden = false;
  setStaleHidden(hidden: boolean): void {
    if (hidden === this._staleHidden) return;
    this._staleHidden = hidden;
    if (hidden) this.hide(); else if (!this._cloakHidden) this.show();
  }

  // Server-authoritative cloak — separate flag from staleHidden because a
  // decloak must restore visibility even while a stale socket stays hidden.
  private _cloakHidden = false;
  setCloakHidden(hidden: boolean): void {
    if (hidden === this._cloakHidden) return;
    this._cloakHidden = hidden;
    if (hidden) this.hide(); else if (!this._staleHidden) this.show();
  }
  get isCloakHidden(): boolean { return this._cloakHidden; }

  setShielded(on: boolean): void {
    if (on === this._shielded) return;
    this._shielded = on;
    if (on && !this.shieldBubble) this.shieldBubble = makeShieldBubble(this.scene);
    if (this.shieldBubble) this.shieldBubble.mesh.visible = on;
  }
  get isShielded(): boolean { return this._shielded; }

  // Medkit channel — a tighter green aura inside where the bubble sits.
  setMending(on: boolean): void {
    if (on === this._mending) return;
    this._mending = on;
    if (on && !this.mendAura) this.mendAura = makeShieldBubble(this.scene, 1.6, 0x3fdd6f);
    if (this.mendAura) this.mendAura.mesh.visible = on && !this._cloakHidden && !this._staleHidden;
  }
  get isMending(): boolean { return this._mending; }

  // Powerup tells — a buffed enemy should be readable at range: regen
  // shimmers teal, double-damage burns red. Server-owned bits.
  setRegenAura(on: boolean): void {
    if (on === this._regenAura) return;
    this._regenAura = on;
    if (on && !this.regenAura) this.regenAura = makeShieldBubble(this.scene, 1.8, 0x66ffee);
    if (this.regenAura) this.regenAura.mesh.visible = on && !this._cloakHidden && !this._staleHidden;
  }
  setDdAura(on: boolean): void {
    if (on === this._ddAura) return;
    this._ddAura = on;
    if (on && !this.ddAura) this.ddAura = makeShieldBubble(this.scene, 1.8, 0xff4422);
    if (this.ddAura) this.ddAura.mesh.visible = on && !this._cloakHidden && !this._staleHidden;
  }

  // Remote fired a weapon — kick the gun's procedural recoil
  fire(weaponType?: number): void {
    // Only re-arm once the previous oneshot expired — spam-restarting the
    // clip under rapid fire pins the model mid-Punch
    if (!this._isDead && this.shootT <= 0) this.shootT = 0.3;
    if (this._loaded) this._model.fire(weaponType);
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
    this._model.dispose();
    if (this.gizmo) {
      this.gizmo.dispose();
      this.gizmo = null;
      logger.debug(`GIZMO REMOVED`, { playerId: this.playerId, instanceId: this.instanceId });
    }
  }
}
