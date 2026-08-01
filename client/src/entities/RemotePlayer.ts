import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ, REMOTE_PLAYER_BASE_LERP_FACTOR, REMOTE_PLAYER_MAX_LERP_FACTOR, REMOTE_PLAYER_DISTANCE_MULTIPLIER, REMOTE_PLAYER_ROTATION_MULTIPLIER, REMOTE_PLAYER_PING_MULTIPLIER, REMOTE_PLAYER_MAX_PING_BONUS, PLAYER_HEIGHT } from '../core/config.js';

import { Terrain } from '../world/terrain.js';

import { PlayerModel, AnimationState } from './PlayerModel.js';

/**
 * Remote player representation with animated 3D model
 * Renders other players in the multiplayer game
 */
let _remotePlayerInstanceCounter = 0;

export class RemotePlayer {
  position: THREE.Vector3;
  rotation: { yaw: number; pitch: number; roll: number };
  playerId: string;
  readonly instanceId: number;
  private _model: PlayerModel;
  private previousPosition: THREE.Vector3;
  private _loaded: boolean = false;
  private isDead: boolean = false;
  private gizmo: THREE.Mesh | null = null;
  private scene: THREE.Scene;
  private velocity: THREE.Vector3 = new THREE.Vector3();
  private logTimer: number = 0;
  private angularVelocity: THREE.Vector3 = new THREE.Vector3();
  private isOnGround: boolean = true;
  private terrain: Terrain | null = null;
  private landed: boolean = false;
  private landedAt: number = 0;
  private shrinkDuration: number = 0.5;
  private scale: number = 1.0;
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

  // Public getters for main.ts access (removes need for (as any) casts)
  get lastUpdateTime(): number { return this._lastUpdateTime; }
  get isSimulating(): boolean { return this._isSimulating; }
  get loaded(): boolean { return this._loaded; }
  get model(): PlayerModel { return this._model; }

  constructor(scene: THREE.Scene, playerId: string, startPos: { x: number; y: number; z: number }, terrain?: Terrain) {
    this.instanceId = ++_remotePlayerInstanceCounter;
    this.scene = scene;
    this.playerId = playerId;
    this.position = new THREE.Vector3(startPos.x, startPos.y, startPos.z);
    this.previousPosition = this.position.clone();
    this.rotation = { yaw: 0, pitch: 0, roll: 0 };
    this.isDead = false; // Reset death state on construction
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
    // Position at head level (PLAYER_HEIGHT = 2.0)
    this.gizmo.position.set(startPos.x, startPos.y + PLAYER_HEIGHT, startPos.z);
    scene.add(this.gizmo);
    console.log(`[RemotePlayer] GIZMO ADDED for playerId=${playerId} instanceId=${this.instanceId}`);

    // Initialize player model
    this._model = new PlayerModel(scene);
    this.model.load().then(() => {
      this._loaded = true;
      this.model.setPosition(this.position.x, this.position.y, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch);
      // Show collider gizmo for remote players (unless already dead)
      if (!this.isDead) {
        this._model.setColliderVisible(true);
      }
      console.log(`[RemotePlayer] MODEL LOADED for playerId=${playerId} instanceId=${this.instanceId} isDead=${this.isDead}`);
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
      console.log(`[RemotePlayer] RESUMED updates for playerId=${this.playerId}, blending to server position`);
    }

    // Update ping for interpolation adjustments
    this.ping = ping;
    // Store target position/rotation for interpolation
    this.targetPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.targetRotation = { yaw: targetRotation.yaw, pitch: targetRotation.pitch };

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
    // Death physics (ragdoll-like rigidbody) run every frame at the real dt so
    // bodies fall/tumble/shrink at full speed and smoothly. Moved here from
    // update() which only fires at ~20Hz with a fixed dt.
    if (this.isDead) {
      // Apply gravity
      this.velocity.y += GRAVITY * dt;
      this.position.x += this.velocity.x * dt;
      this.position.y += this.velocity.y * dt;
      this.position.z += this.velocity.z * dt;

      // Apply angular velocity (tumbling on all axes)
      this.rotation.yaw += this.angularVelocity.x * dt;
      this.rotation.pitch += this.angularVelocity.y * dt;
      this.rotation.roll += this.angularVelocity.z * dt;

      // Ground collision with bounce
      if (this.terrain) {
        const groundY = this.terrain.getHeight(this.position.x, this.position.z);
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
      } else {
        // Fallback: don't fall below 0
        if (this.position.y < 0) {
          this.position.y = 0;
          this.velocity.y = -this.velocity.y * BOUNCE_Y;
          this.velocity.x *= FRICTION_XZ;
          this.velocity.z *= FRICTION_XZ;
          this.angularVelocity.multiplyScalar(0.3);
          if (!this.landed) {
            this.landed = true;
            this.landedAt = 0;
          }
        }
      }

      // Shrink after landing
      if (this.landed) {
        this.landedAt += dt;
        const shrinkFactor = 1.0 - (this.landedAt / this.shrinkDuration);
        if (shrinkFactor <= 0) {
          this.scale = 0;
        } else {
          this.scale = shrinkFactor;
        }
      }

      // Update model if loaded (position/rotation/scale/animation)
      if (this._loaded) {
        this._model.setPosition(this.position.x, this.position.y, this.position.z);
        this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);
        if (this.scale !== 1.0) {
          this._model.setScale(this.scale);
        }
        this._model.update(dt);
      }
      return; // Dead players skip the alive interpolation/simulation below
    }

    if (!this.isDead) {
      // Dead reckoning trigger: if no updates for 300ms, start simulating
      const timeSinceUpdate = Date.now() - this._lastUpdateTime;
      if (timeSinceUpdate > 300 && !this._isSimulating) {
        this._isSimulating = true;
        console.log(`[RemotePlayer] STARTING dead reckoning for playerId=${this.playerId} (no updates for ${timeSinceUpdate}ms)`);
      }

      // Skip interpolation if we're simulating physics (dead reckoning)
      if (!this._isSimulating) {
        // Extrapolation: predict where the player is now based on server velocity
        // serverPosition + serverVelocity * timeSinceUpdate = current actual position
        // Cap at 200ms to prevent runaway prediction during packet loss
        const timeSinceUpdate = Math.min(0.2, (Date.now() - this.lastServerUpdateMs) / 1000);
        const extrapolatedTarget = new THREE.Vector3(
          this.targetPosition.x + this.serverVelocity.x * timeSinceUpdate,
          this.targetPosition.y + this.serverVelocity.y * timeSinceUpdate,
          this.targetPosition.z + this.serverVelocity.z * timeSinceUpdate
        );

        // Reconciliation blend: when recovering from simulation, blend aggressively
        // toward the server position to correct any drift smoothly
        if (this.reconcileBlend > 0) {
          this.reconcileBlend -= dt;
          if (this.reconcileBlend <= 0) {
            this.reconcileBlend = 0;
          }
          // Blend factor: start at 1.0 (full snap) and decay over the blend window
          const blendStrength = Math.min(1, dt / Math.max(0.001, this.reconcileBlend + dt));
          this.position.lerp(extrapolatedTarget, blendStrength);
        } else {
          // Normal adaptive interpolation
          const distanceToTarget = this.position.distanceTo(extrapolatedTarget);
          const pingBonus = Math.min(REMOTE_PLAYER_MAX_PING_BONUS, this.ping * REMOTE_PLAYER_PING_MULTIPLIER);
          const adaptiveFactor = Math.min(
            REMOTE_PLAYER_MAX_LERP_FACTOR,
            REMOTE_PLAYER_BASE_LERP_FACTOR + distanceToTarget * REMOTE_PLAYER_DISTANCE_MULTIPLIER + pingBonus
          );
          const lerpFactor = Math.min(1, adaptiveFactor * dt);

          // Interpolate toward extrapolated position
          this.position.x += (extrapolatedTarget.x - this.position.x) * lerpFactor;
          this.position.y += (extrapolatedTarget.y - this.position.y) * lerpFactor;
          this.position.z += (extrapolatedTarget.z - this.position.z) * lerpFactor;
        }

        // Log position every 2 seconds
        this.logTimer += dt;
        if (this.logTimer >= 2.0) {
          this.logTimer = 0;
          const groundY = this.terrain ? this.terrain.getHeight(this.position.x, this.position.z) : 0;
          console.log(`[RemotePlayer ${this.playerId}] Position: (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}) | Terrain: ${groundY.toFixed(1)} | Above terrain: ${(this.position.y - groundY).toFixed(1)}`);
        }

        // Interpolate rotation with slightly faster factor for responsiveness
        const rotationFactor = Math.min(1, REMOTE_PLAYER_MAX_LERP_FACTOR * REMOTE_PLAYER_ROTATION_MULTIPLIER * dt);
        this.rotation.yaw += (this.targetRotation.yaw - this.rotation.yaw) * rotationFactor;
        this.rotation.pitch += (this.targetRotation.pitch - this.rotation.pitch) * rotationFactor;

        // Roll is not networked, only used for death physics
        this.rotation.roll = 0;

        // Update velocity for extrapolation (estimate from recent movement)
        if (dt > 0) {
          this.velocity.x = (this.position.x - this.previousPosition.x) / dt;
          this.velocity.y = (this.position.y - this.previousPosition.y) / dt;
          this.velocity.z = (this.position.z - this.previousPosition.z) / dt;
        }
      }
      // When simulating, run physics locally for prediction
      if (this._isSimulating) {
        if (this.predictionTimer > 0) {
          this.predictionTimer -= dt;
          if (this.predictionTimer <= 0) {
            this.predictionTimer = 0;
          }
        }
        this.simulatePhysics(dt);
      }
    }

    // Update model if loaded (alive path — dead players return early above)
    if (this._loaded) {
      this._model.setPosition(this.position.x, this.position.y, this.position.z);
      this._model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);

      // Calculate speed for animation with hysteresis
      const speed = this.position.distanceTo(this.previousPosition) / dt;
      let animState: AnimationState = 'idle';

      // Hysteresis to prevent flickering (same logic as local player)
      const currentAnim = this._model['currentState'] as AnimationState;

      if (currentAnim === 'run') {
        if (speed < 6.0) {
          animState = speed > 1.5 ? 'walk' : 'idle';
        } else {
          animState = 'run';
        }
      } else if (currentAnim === 'walk') {
        if (speed < 0.8) {
          animState = 'idle';
        } else if (speed > 9.0) {
          animState = 'run';
        } else {
          animState = 'walk';
        }
      } else {
        if (speed > 1.5) {
          animState = speed > 8.0 ? 'run' : 'walk';
        } else {
          animState = 'idle';
        }
      }

      this._model.setAnimationState(animState);
      this.previousPosition.copy(this.position);
      this._model.update(dt);
    }

    // Update gizmo position (only if alive)
    if (this.gizmo) {
      if (!this.isDead) {
        this.gizmo.position.set(this.position.x, this.position.y + PLAYER_HEIGHT, this.position.z);
        (this.gizmo.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
        this.gizmo.visible = true;
      } else {
        this.gizmo.visible = false;
      }
    }
  }

  playDeath(explosionPos?: THREE.Vector3, explosionForce?: number): void {
    this.isDead = true;
    this.landed = false;
    this.landedAt = 0;
    this.scale = 1.0;

    // Remove gizmo from scene immediately on death
    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      console.log(`[RemotePlayer] GIZMO REMOVED on death for playerId=${this.playerId}`);
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
    if (this.isDead) return; // Don't simulate if already dead (death physics handles it)

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
      if (this.position.y < groundY + 1.0) { // +1.0 for player height offset
        this.position.y = groundY + 1.0;
        this.simulatedVelocity.y = 0;
        this.simulatedVelocity.x *= 0.9; // Friction
        this.simulatedVelocity.z *= 0.9;
      }
    }
  }

  respawn(position: { x: number; y: number; z: number }): void {
    this.isDead = false;
    this.landed = false;
    this.landedAt = 0;
    this.scale = 1.0;
    this.position.set(position.x, position.y, position.z);
    this.previousPosition.copy(this.position);
    this.targetPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.simulatedVelocity.set(0, 0, 0);
    this.serverVelocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.isOnGround = true;
    this._isSimulating = false;
    this.predictionTimer = 0;
    this.reconcileBlend = 0;
    this.lastServerPosition.copy(this.position);
    this.lastServerUpdateMs = Date.now();
    this._lastUpdateTime = Date.now();
    this.show();
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    if (this.isDead) return;
    const dir = new THREE.Vector3().subVectors(this.position, from).normalize();
    this.simulatedVelocity.addScaledVector(dir, force);
    this.simulatedVelocity.y += force * 0.5;
    // Local prediction — bridge until server position updates reflect the knockback
    this._isSimulating = true;
    this.predictionTimer = 0.3; // 300ms covers typical round-trip
    this._lastUpdateTime = Date.now();
  }

  applyPull(to: THREE.Vector3, force: number): void {
    if (this.isDead) return;
    const dir = new THREE.Vector3().subVectors(to, this.position).normalize();
    this.simulatedVelocity.addScaledVector(dir, force);
    this.simulatedVelocity.y += force * 0.3;
    this._isSimulating = true;
    this.predictionTimer = 0.3;
    this._lastUpdateTime = Date.now();
  }

  startDeadReckoning(): void {
    this._isSimulating = true;
  }

  dispose(): void {
    console.log(`[RemotePlayer] DISPOSE called for playerId=${this.playerId} instanceId=${this.instanceId}`);
    this._model.dispose();
    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      this.gizmo.geometry.dispose();
      (this.gizmo.material as THREE.Material).dispose();
      this.gizmo = null;
      console.log(`[RemotePlayer] GIZMO REMOVED for playerId=${this.playerId} instanceId=${this.instanceId}`);
    }
  }
}
