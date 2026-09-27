import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ, EYE_OFFSET } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { ChildLogger } from '../core/Logger.js';

import { PlayerModel } from './PlayerModel.js';
import { pickLocomotionAnim } from './locomotionAnim.js';

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
  // Base render delay — grows with measured arrival jitter (Mirror-style
  // adaptive buffer): 20Hz packets + jitter margin, clamped [80, 300]ms
  private static readonly BASE_INTERP_DELAY = 100;
  private static readonly MAX_INTERP_DELAY = 300;
  private interpDelay = RemotePlayer.BASE_INTERP_DELAY;
  private arrivalJitter = 0; // EMA of |arrival interval - 50ms|
  private arrivalInterval = 50; // EMA of measured arrival interval (ms)

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
  private gizmo: THREE.Mesh | null = null;
  private scene: THREE.Scene;
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private angularVelocity: THREE.Vector3 = new THREE.Vector3();
  private isOnGround: boolean = true;
  private terrain: Terrain | null = null;
  private landed: boolean = false;
  private landedAt: number = 0;
  private shrinkDuration: number = 0.5;
  private _scale: number = 1.0;
  private targetPosition: THREE.Vector3;
  private targetRotation: { yaw: number; pitch: number };
  private ping: number = 0; // Connection ping in milliseconds
  private _lastUpdateTime: number = 0; // Timestamp of last position update
  private _isSimulating: boolean = false; // True if we're simulating physics (dead reckoning)
  private simulatedVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity during simulation
  private predictionTimer: number = 0; // Seconds of forced local prediction (bridges server round-trip)
  private serverVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity reported by server
  private lastServerUpdateMs: number = 0; // Timestamp of last server update (ms)
  private reconcileBlend: number = 0; // Blends from predicted to server position (0 = done)
  private gizmoMismatchLogTimer: number = 0; // Throttle for gizmo mismatch warnings
  private lastServerPosition: THREE.Vector3 = new THREE.Vector3(); // Last raw server position (for velocity estimation)

  // Snapshot buffer for interpolation: we render remote players ~INTERP_DELAY
  // in the past and interpolate BETWEEN two real server snapshots instead of
  // chasing the newest one. Kills jitter/oscillation — the classic Quake/
  // Krunker approach. Buffer holds ~1s of the 20Hz stream.
  private snapshots: { t: number; x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number }[] = [];

  // Public getters for main.ts access (removes need for (as any) casts)
  get lastUpdateTime(): number { return this._lastUpdateTime; }
  // Alias for the Forceable interface (Player/Ball use `pos`, we use `position`)
  get pos(): THREE.Vector3 { return this.position; }
  get isDead(): boolean { return this._isDead; }
  get scale(): number { return this._scale; }
  get isSimulating(): boolean { return this._isSimulating; }
  get loaded(): boolean { return this._loaded; }
  get model(): PlayerModel { return this._model; }
  // Server-reported velocity (for dust/trail effects); falls back to position-derived estimate
  get vel(): THREE.Vector3 {
    return this.serverVelocity.lengthSq() > 0.01 ? this.serverVelocity : this.velocity;
  }

  // Hard-sync position + all interpolation/simulation state to `pos`
  // (used by the ?dummy debug hook — suppresses dead reckoning drift)
  teleportTo(pos: THREE.Vector3): void {
    this.position.copy(pos);
    this.previousPosition.copy(pos);
    this.targetPosition.copy(pos);
    this.snapshots.length = 0;
    this._lastUpdateTime = Date.now();
    this._isSimulating = false;
  }

  constructor(scene: THREE.Scene, playerId: string, startPos: { x: number; y: number; z: number }, terrain?: Terrain) {
    this.instanceId = ++_remotePlayerInstanceCounter;
    this.scene = scene;
    this.playerId = playerId;
    this.position = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    this.previousPosition = this.position.clone();
    this.rotation = { yaw: 0, pitch: 0, roll: 0 };
    this._isDead = false; // Reset death state on construction
    this.terrain = terrain || null;
    this.targetPosition = this.position.clone();
    this.targetRotation = { yaw: 0, pitch: 0 };
    this._lastUpdateTime = Date.now(); // Initialize to current time to prevent immediate dead reckoning
    this.lastServerUpdateMs = this.lastUpdateTime;
    this.lastServerPosition.copy(this.position);

    // Create visual gizmo (ring above head)
    const ringGeometry = new THREE.RingGeometry(0.3, 0.4, 32);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.7
    });
    this.gizmo = new THREE.Mesh(ringGeometry, ringMaterial);
    this.gizmo.rotation.x = -Math.PI / 2; // Lay flat
    // Position just above the head — head top is ~0.6 above eye height
    this.gizmo.position.set(startPos.x, startPos.y + 0.7, startPos.z);
    scene.add(this.gizmo);
    logger.debug(`GIZMO ADDED`, { playerId, instanceId: this.instanceId });

    // Initialize player model
    this._model = new PlayerModel(scene);
    this.model.load().then(() => {
      this._loaded = true;
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

    // Track arrival jitter — feeds the adaptive render delay. Jitter is
    // measured against the OBSERVED cadence (arrivalInterval EMA), not a
    // fixed 20Hz assumption: server-side send suppression legitimately
    // stretches gaps to ~250ms for idle/extrapolated remotes, and counting
    // that as jitter would pin interpDelay at the 300ms ceiling and leave
    // resumed motion rendering stale.
    const arrivalGap = this.lastServerUpdateMs - prevUpdateMs;
    if (arrivalGap > 10 && arrivalGap < 2000) {
      this.arrivalInterval += (arrivalGap - this.arrivalInterval) * 0.15;
      this.arrivalJitter += (Math.abs(arrivalGap - this.arrivalInterval) - this.arrivalJitter) * 0.1;
      this.interpDelay = Math.min(
        RemotePlayer.MAX_INTERP_DELAY,
        RemotePlayer.BASE_INTERP_DELAY + this.arrivalJitter * 2
      );
    }

    // Push onto the snapshot buffer (interpolation samples between entries)
    this.snapshots.push({
      t: this.lastServerUpdateMs,
      x: targetPosition.x, y: targetPosition.y, z: targetPosition.z,
      yaw: targetRotation.yaw, pitch: targetRotation.pitch,
      vx: serverVelocity?.x ?? 0, vy: serverVelocity?.y ?? 0, vz: serverVelocity?.z ?? 0,
    });
    const cutoff = this.lastServerUpdateMs - 1000;
    while (this.snapshots.length > 2 && this.snapshots[0].t < cutoff) {
      this.snapshots.shift();
    }

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
  tick(dt: number): void {
    if (this._isDead) {
      this.tickDead(dt);
      return;
    }
    this.tickAlive(dt);
  }

  // Death physics (ragdoll-like rigidbody) run every frame at the real dt so
  // bodies fall/tumble/shrink at full speed and smoothly. Moved here from
  // update() which only fires at ~20Hz with a fixed dt.
  private tickDead(dt: number): void {
    this.velocity.y += GRAVITY * dt;
    this.position.addScaledVector(this.velocity, dt);

    // Apply angular velocity (tumbling on all axes)
    this.rotation.yaw += this.angularVelocity.x * dt;
    this.rotation.pitch += this.angularVelocity.y * dt;
    this.rotation.roll += this.angularVelocity.z * dt;

    // Ground collision with bounce (flat 0 fallback without terrain)
    const groundY = this.terrain ? this.terrain.getHeight(this.position.x, this.position.z) : 0;
    if (this.position.y < groundY) {
      this.position.y = groundY;
      this.velocity.y = -this.velocity.y * BOUNCE_Y;
      this.velocity.x *= FRICTION_XZ;
      this.velocity.z *= FRICTION_XZ;
      this.angularVelocity.multiplyScalar(0.3); // Dampen rotation on bounce
      if (!this.landed) {
        this.landed = true;
        this.landedAt = 0;
      }
    }

    // Shrink after landing
    if (this.landed) {
      this.landedAt += dt;
      this._scale = Math.max(0, 1.0 - this.landedAt / this.shrinkDuration);
    }

    // Update model if loaded (position/rotation/scale/animation)
    if (this._loaded) {
      this._model.setPosition(this.position.x, this.position.y - EYE_OFFSET, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);
      if (this._scale !== 1.0) {
        this._model.setScale(this._scale);
      }
      this._model.update(dt);
    }
  }

  private tickAlive(dt: number): void {
    // Dead reckoning trigger scaled to the measured update cadence: ~2 missed
    // packets at that player's actual send rate. Fixed 300/450ms thresholds
    // flapped DR on/off when heartbeats arrived slower than their nominal
    // 250ms interval (dr threshold straddled the real cadence).
    const drThreshold = Math.min(1500, Math.max(350, this.arrivalInterval * 2.5));
    const timeSinceUpdate = Date.now() - this._lastUpdateTime;
    if (timeSinceUpdate > drThreshold && !this._isSimulating) {
      this._isSimulating = true;
      logger.debug(`STARTING dead reckoning`, { playerId: this.playerId, silentMs: timeSinceUpdate });
    }

    if (this._isSimulating) {
      if (this.predictionTimer > 0) {
        this.predictionTimer = Math.max(0, this.predictionTimer - dt);
      }
      this.simulatePhysics(dt);
    } else {
      this.interpolate(dt);
    }

    this.updateAliveModel(dt);

    // Update gizmo position (only if alive)
    if (this.gizmo) {
      this.gizmo.position.set(this.position.x, this.position.y + 0.7, this.position.z);
      (this.gizmo.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
      this.gizmo.visible = true;
    }
  }

  // Sample the snapshot buffer at renderTime = now - INTERP_DELAY.
  // Interpolates between the two bracketing snapshots (position + rotation);
  // extrapolates from the newest snapshot's velocity if we run past the end.
  private sampleSnapshots(outPos: THREE.Vector3, outYawPitch: { yaw: number; pitch: number }): void {
    const renderTime = Date.now() - this.interpDelay;
    const snaps = this.snapshots;

    if (snaps.length === 0) {
      outPos.copy(this.targetPosition);
      outYawPitch.yaw = this.targetRotation.yaw;
      outYawPitch.pitch = this.targetRotation.pitch;
      return;
    }

    const newest = snaps[snaps.length - 1]!;
    if (renderTime >= newest.t) {
      // Past the buffer — extrapolate briefly from the newest snapshot
      const ext = Math.min(0.25, (renderTime - newest.t) / 1000);
      outPos.set(newest.x + newest.vx * ext, newest.y + newest.vy * ext, newest.z + newest.vz * ext);
      outYawPitch.yaw = newest.yaw;
      outYawPitch.pitch = newest.pitch;
      return;
    }

    // Find the pair straddling renderTime
    let i = snaps.length - 2;
    while (i >= 0 && snaps[i]!.t > renderTime) i--;
    if (i < 0) {
      const s = snaps[0]!;
      outPos.set(s.x, s.y, s.z);
      outYawPitch.yaw = s.yaw;
      outYawPitch.pitch = s.pitch;
      return;
    }

    const s0 = snaps[i]!;
    const s1 = snaps[i + 1]!;
    const span = s1.t - s0.t;
    const a = span > 0 ? (renderTime - s0.t) / span : 1;

    // Cubic Hermite: use server-reported velocities as tangents → C1-continuous
    // motion (direction changes curve smoothly instead of zig-zagging between
    // linear segments). Guard: if the curve overshoots wildly vs the straight
    // lerp (stale/bogus velocity), fall back to linear.
    const spanSec = span / 1000;
    const ddx = s1.x - s0.x, ddy = s1.y - s0.y, ddz = s1.z - s0.z;
    const lx = s0.x + ddx * a, ly = s0.y + ddy * a, lz = s0.z + ddz * a;
    let useHermite = false;
    if (spanSec > 0 && spanSec < 0.5) {
      const t2 = a * a, t3 = t2 * a;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + a;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const hx = h00 * s0.x + h10 * s0.vx * spanSec + h01 * s1.x + h11 * s1.vx * spanSec;
      const hy = h00 * s0.y + h10 * s0.vy * spanSec + h01 * s1.y + h11 * s1.vy * spanSec;
      const hz = h00 * s0.z + h10 * s0.vz * spanSec + h01 * s1.z + h11 * s1.vz * spanSec;
      const ox = hx - lx, oy = hy - ly, oz = hz - lz;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      // Overshoot tolerance: fraction of segment length (min 0.5m absolute)
      if (ox * ox + oy * oy + oz * oz < (0.5 * dist + 0.5) * (0.5 * dist + 0.5)) {
        outPos.set(hx, hy, hz);
        useHermite = true;
      }
    }
    if (!useHermite) {
      outPos.set(lx, ly, lz);
    }
    // Yaw: lerp along shortest arc
    let dy = s1.yaw - s0.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    outYawPitch.yaw = s0.yaw + dy * a;
    outYawPitch.pitch = s0.pitch + (s1.pitch - s0.pitch) * a;
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
    const speed = this.position.distanceTo(this.previousPosition) / dt;
    // Airborne overrides locomotion — the speed check alone reads jetting
    // as "run", i.e. the robot sprinting on air. Feet clearly above
    // terrain → Jump pose; grounded/skiing keeps the walk/run cycle.
    const airborne = this.terrain
      ? this.feetY - this.terrain.getHeight(this.position.x, this.position.z) > 0.6
      : false;
    this._model.setAnimationState(airborne
      ? 'jump'
      : pickLocomotionAnim(this._model.animationState, speed));
    this.previousPosition.copy(this.position);
    this._model.update(dt);
  }

  playDeath(explosionPos?: THREE.Vector3, explosionForce?: number): void {
    this._isDead = true;
    this.landed = false;
    this.landedAt = 0;
    this._scale = 1.0;

    // Remove gizmo from scene immediately on death
    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      logger.debug(`GIZMO REMOVED on death`, { playerId: this.playerId });
    }

    // Remove collider gizmo from scene on death (not just hide it)
    this.model.removeColliderGizmo();

    if (explosionPos && explosionForce) {
      // Calculate velocity from explosion
      const toPlayer = new THREE.Vector3().subVectors(this.position, explosionPos);
      const distance = toPlayer.length();
      const direction = toPlayer.normalize();
      
      // Force falloff based on distance
      const falloff = Math.max(0, 1 - distance / (explosionForce * 2.5));
      const speed = explosionForce * falloff * 0.8; // 80% of explosion force
      
      this.velocity.set(
        direction.x * speed,
        direction.y * speed + 3.0, // Add upward kick
        direction.z * speed
      );

      // Tumbling based on explosion force
      const tumble = explosionForce * 0.5;
      this.angularVelocity.set(
        (Math.random() - 0.5) * 2 * tumble,
        (Math.random() - 0.5) * 2 * tumble,
        (Math.random() - 0.5) * 2 * tumble
      );
    } else {
      // Fallback: random velocity (for deaths without explosion)
      const speed = 8.0 + Math.random() * 6.0;
      const angle = Math.random() * Math.PI * 2;
      const elevation = Math.random() * Math.PI * 0.5;
      this.velocity.set(
        Math.cos(elevation) * Math.cos(angle) * speed,
        Math.sin(elevation) * speed + 3.0,
        Math.cos(elevation) * Math.sin(angle) * speed
      );

      const tumble = 5.0 + Math.random() * 10.0;
      this.angularVelocity.set(
        (Math.random() - 0.5) * 2 * tumble,
        (Math.random() - 0.5) * 2 * tumble,
        (Math.random() - 0.5) * 2 * tumble
      );
    }
  }

  /** Team tint on the name ring — Nugget Wars bots use it; server players
   *  could too once teamAssign lands on the wire. */
  setGizmoColor(hex: number): void {
    (this.gizmo?.material as THREE.MeshBasicMaterial | undefined)?.color.setHex(hex);
  }

  hide(): void {
    this.model.setVisible(false);
    if (this.gizmo) {
      this.gizmo.visible = false;
    }
  }

  show(): void {
    this.model.setVisible(true);
    // Only add collider if model is loaded (colliderGizmo exists)
    if (this.loaded) {
      this.model.addColliderGizmo();
    }
    if (this.gizmo) {
      // Re-add gizmo to scene if it was removed
      if (!this.scene.children.includes(this.gizmo)) {
        this.scene.add(this.gizmo);
      }
      this.gizmo.visible = true;
      (this.gizmo.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
    }
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
    this.landed = false;
    this.landedAt = 0;
    this._scale = 1.0;
    this.position.set(position.x, position.y, position.z);
    this.previousPosition.copy(this.position);
    this.targetPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.simulatedVelocity.set(0, 0, 0);
    this.serverVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.isOnGround = true;
    this._isSimulating = false;
    this.snapshots.length = 0;
    this.predictionTimer = 0;
    this.reconcileBlend = 0;
    this.lastServerPosition.copy(this.position);
    this.lastServerUpdateMs = Date.now();
    this._lastUpdateTime = Date.now();
    this.show();
  }

  // Staleness gate: hide players whose updates stopped arriving (backgrounded
  // tabs keep their socket open but stop simulating). Auto-reshow on resume.
  private _staleHidden = false;
  setStaleHidden(hidden: boolean): void {
    if (hidden === this._staleHidden) return;
    this._staleHidden = hidden;
    if (hidden) this.hide(); else this.show();
  }

  // Remote fired a weapon — kick the gun's procedural recoil
  fire(): void {
    if (this._loaded) this._model.fire();
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
    this.snapshots.length = 0;
    this._isSimulating = true;
    // Window: ping + one server tick + interp delay, clamped
    this.predictionTimer = Math.min(0.6, Math.max(0.15, (this.ping + 200) / 1000));
  }

  // simulatePhysics() remains for genuine packet-loss dead reckoning.

  dispose(): void {
    logger.debug(`DISPOSE called`, { playerId: this.playerId, instanceId: this.instanceId });
    this._model.dispose();
    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      this.gizmo.geometry.dispose();
      (this.gizmo.material as THREE.Material).dispose();
      this.gizmo = null;
      logger.debug(`GIZMO REMOVED`, { playerId: this.playerId, instanceId: this.instanceId });
    }
  }
}
