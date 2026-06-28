import * as THREE from 'three';
import { PlayerModel, AnimationState } from './PlayerModel.js';
import { Terrain } from './terrain.js';
import {
  GRAVITY, BOUNCE_Y, FRICTION_XZ,
  REMOTE_PLAYER_BASE_LERP_FACTOR, REMOTE_PLAYER_MAX_LERP_FACTOR,
  REMOTE_PLAYER_DISTANCE_MULTIPLIER, REMOTE_PLAYER_ROTATION_MULTIPLIER,
  REMOTE_PLAYER_PING_MULTIPLIER, REMOTE_PLAYER_MAX_PING_BONUS
} from './config.js';

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
  private model: PlayerModel;
  private previousPosition: THREE.Vector3;
  private loaded: boolean = false;
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
  private lastUpdateTime: number = 0; // Timestamp of last position update
  private isSimulating: boolean = false; // True if we're simulating physics (dead reckoning)
  private simulatedVelocity: THREE.Vector3 = new THREE.Vector3(); // Velocity during simulation

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
    this.lastUpdateTime = Date.now(); // Initialize to current time to prevent immediate dead reckoning

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
    this.gizmo.position.set(startPos.x, startPos.y + 2.0, startPos.z);
    scene.add(this.gizmo);
    console.log(`[RemotePlayer] GIZMO ADDED for playerId=${playerId} instanceId=${this.instanceId}`);

    // Initialize player model
    this.model = new PlayerModel(scene);
    this.model.load().then(() => {
      this.loaded = true;
      this.model.setPosition(this.position.x, this.position.y, this.position.z);
      this.model.setRotation(this.rotation.yaw, this.rotation.pitch);
      // Show collider gizmo for remote players
      this.model.setColliderVisible(true);
      console.log(`[RemotePlayer] MODEL LOADED for playerId=${playerId} instanceId=${this.instanceId}`);
    });
  }

  update(targetPosition: { x: number; y: number; z: number }, targetRotation: { yaw: number; pitch: number }, dt: number, ping: number = 0): void {
    // Update last update timestamp
    this.lastUpdateTime = Date.now();

    // If we were simulating and now got an update, stop simulating and reconcile
    if (this.isSimulating) {
      this.isSimulating = false;
      // Snap to server position (could use interpolation for smoother transition)
      this.position.set(targetPosition.x, targetPosition.y, targetPosition.z);
      console.log(`[RemotePlayer] RESUMED updates for playerId=${this.playerId}, reconciling position`);
    }

    // Update ping for interpolation adjustments
    this.ping = ping;
    // Store target position/rotation for interpolation
    this.targetPosition.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.targetRotation = { yaw: targetRotation.yaw, pitch: targetRotation.pitch };

    // Estimate velocity from position change (for dead reckoning)
    const timeSinceLastUpdate = dt;
    if (timeSinceLastUpdate > 0) {
      this.simulatedVelocity.set(
        (targetPosition.x - this.position.x) / timeSinceLastUpdate,
        (targetPosition.y - this.position.y) / timeSinceLastUpdate,
        (targetPosition.z - this.position.z) / timeSinceLastUpdate
      );
    }

    // Handle death physics (ragdoll-like rigidbody)
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
    }
  }

  // Called every frame for smooth interpolation
  tick(dt: number): void {
    if (!this.isDead) {
      // Skip interpolation if we're simulating physics (dead reckoning)
      if (!this.isSimulating) {
        // Calculate distance to target for adaptive interpolation
        const distanceToTarget = this.position.distanceTo(this.targetPosition);

        // Adaptive lerp factor: faster when far, slower when close
        // Base factor adjusted by distance and ping
        // Higher ping = more aggressive interpolation to compensate for lag
        const pingBonus = Math.min(REMOTE_PLAYER_MAX_PING_BONUS, this.ping * REMOTE_PLAYER_PING_MULTIPLIER);
        const adaptiveFactor = Math.min(
          REMOTE_PLAYER_MAX_LERP_FACTOR,
          REMOTE_PLAYER_BASE_LERP_FACTOR + distanceToTarget * REMOTE_PLAYER_DISTANCE_MULTIPLIER + pingBonus
        );
        const lerpFactor = adaptiveFactor * dt;

        // Interpolate position
        this.position.x += (this.targetPosition.x - this.position.x) * lerpFactor;
        this.position.y += (this.targetPosition.y - this.position.y) * lerpFactor;
        this.position.z += (this.targetPosition.z - this.position.z) * lerpFactor;

        // Log position every 2 seconds
        this.logTimer += dt;
        if (this.logTimer >= 2.0) {
          this.logTimer = 0;
          const groundY = this.terrain ? this.terrain.getHeight(this.position.x, this.position.z) : 0;
          console.log(`[RemotePlayer ${this.playerId}] Position: (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}) | Terrain: ${groundY.toFixed(1)} | Above terrain: ${(this.position.y - groundY).toFixed(1)}`);
        }

        // Interpolate rotation with slightly faster factor for responsiveness
        const rotationFactor = Math.min(REMOTE_PLAYER_MAX_LERP_FACTOR * REMOTE_PLAYER_ROTATION_MULTIPLIER, adaptiveFactor * REMOTE_PLAYER_ROTATION_MULTIPLIER) * dt;
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
      // When simulating, position is updated by simulatePhysics() called from main loop
    }

    // Update model if loaded
    if (this.loaded) {
      this.model.setPosition(this.position.x, this.position.y, this.position.z);
      this.model.setRotation(this.rotation.yaw, this.rotation.pitch, this.rotation.roll);

      // Apply scale (for death shrink effect)
      if (this.isDead && this.scale !== 1.0) {
        this.model.setScale(this.scale);
      }

      if (this.isDead) {
        // No animation, just physics
      } else {
        // Calculate speed for animation with hysteresis
        const speed = this.position.distanceTo(this.previousPosition) / dt;
        let animState: AnimationState = 'idle';
        
        // Hysteresis to prevent flickering (same logic as local player)
        const currentAnim = this.model['currentState'] as AnimationState;
        
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
        
        this.model.setAnimationState(animState);
        this.previousPosition.copy(this.position);
      }
      this.model.update(dt);
    }

    // Update gizmo position (only if alive)
    if (this.gizmo) {
      if (!this.isDead) {
        this.gizmo.position.set(this.position.x, this.position.y + 2.0, this.position.z);
        (this.gizmo.material as THREE.MeshBasicMaterial).color.setHex(0x00ff00);
        this.gizmo.visible = true;

        // Check positional alignment with model and collider
        if (this.loaded && this.model['model']) {
          const modelPos = this.model['model'].position;
          const expectedModelY = this.position.y + 1.2; // Model should be at feet + 1.2
          const modelYMismatch = Math.abs(modelPos.y - expectedModelY);

          if (modelYMismatch > 0.1) {
            console.warn(`[RemotePlayer] POSITION MISMATCH for ${this.playerId}: Model Y=${modelPos.y.toFixed(2)}, expected=${expectedModelY.toFixed(2)} (diff=${modelYMismatch.toFixed(2)})`);
          }

          // Check collider gizmo position (it's a child of the model)
          const colliderGizmo = this.model['colliderGizmo'];
          if (colliderGizmo) {
            const colliderWorldPos = new THREE.Vector3();
            colliderGizmo.getWorldPosition(colliderWorldPos);
            // Collider is at y=-0.2 in model space, model is at feet + 1.2
            // So collider should be at feet + 1.2 - 0.2 = feet + 1.0 (half player height)
            const expectedColliderY = this.position.y + 1.0;
            const colliderYMismatch = Math.abs(colliderWorldPos.y - expectedColliderY);

            if (colliderYMismatch > 0.1) {
              console.warn(`[RemotePlayer] COLLIDER MISMATCH for ${this.playerId}: Collider Y=${colliderWorldPos.y.toFixed(2)}, expected=${expectedColliderY.toFixed(2)} (diff=${colliderYMismatch.toFixed(2)})`);
            }
          }
        }
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
    this.model.addColliderGizmo();
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
    this.simulatedVelocity.y -= GRAVITY * dt;

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
    this.angularVelocity.set(0, 0, 0);
    this.isOnGround = true;
    this.show();
  }

  dispose(): void {
    console.log(`[RemotePlayer] DISPOSE called for playerId=${this.playerId} instanceId=${this.instanceId}`);
    this.model.dispose();
    if (this.gizmo) {
      this.scene.remove(this.gizmo);
      this.gizmo.geometry.dispose();
      (this.gizmo.material as THREE.Material).dispose();
      this.gizmo = null;
      console.log(`[RemotePlayer] GIZMO REMOVED for playerId=${this.playerId} instanceId=${this.instanceId}`);
    }
  }
}
