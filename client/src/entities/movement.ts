import * as THREE from 'three';

import { GRAVITY } from '../core/config.js';

import { Terrain } from '../world/terrain.js';

// ---- Movement Parameters (Unity RB_Controller equivalent) ----
export const MOVEMENT_CONFIG = {
  // Ground movement
  maxVelocityGround: 7.0,
  groundAccelerate: 800.0,
  groundFriction: 50.0,
  stopThreshold: 1.0,

  // Air movement
  maxPassiveAirvel: 10.0,
  airControl: 0.2,
  terminalVelocity: 100.0,

  // Jump
  jumpSpeed: 7.0,
  autoHop: true,

  // Skiing: friction toggle only — the old accel/boost/lift experiment is gone,
  // but a skier still counts as grounded a little higher off the surface
  skiTargetDistance: 0.5,
} as const;

export interface MovementState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export interface MovementInput {
  forward: number; // -1 to 1
  right: number; // -1 to 1
  jumpPressed: boolean;
  jumpHeld: boolean;
  skiHeld: boolean;
}

// Scratch vectors — reused every frame to avoid allocation churn
const _jump = new THREE.Vector3();
const _jumpHoriz = new THREE.Vector3();
const _inputDir = new THREE.Vector3();
const _slopeDir = new THREE.Vector3();
const _fric = new THREE.Vector3();
const _shift = new THREE.Vector3();

export class MovementController {
  private terrain: Terrain;
  private state: MovementState;
  private input: MovementInput;

  // Internal state
  private groundedBufferedByDistance: boolean = false;
  private wishJump: boolean = false;
  private lastJumpableNormal: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
  private allowNextJump: boolean = true;

  constructor(terrain: Terrain, initialState: MovementState) {
    this.terrain = terrain;
    this.state = initialState;
    this.input = {
      forward: 0,
      right: 0,
      jumpPressed: false,
      jumpHeld: false,
      skiHeld: false,
    };
  }

  setInput(input: Partial<MovementInput>): void {
    if (input.forward !== undefined) this.input.forward = input.forward;
    if (input.right !== undefined) this.input.right = input.right;
    if (input.jumpPressed !== undefined) this.input.jumpPressed = input.jumpPressed;
    if (input.jumpHeld !== undefined) this.input.jumpHeld = input.jumpHeld;
    if (input.skiHeld !== undefined) this.input.skiHeld = input.skiHeld;
  }

  getState(): MovementState {
    return this.state;
  }

  setState(newState: MovementState): void {
    this.state.pos.copy(newState.pos);
    this.state.vel.copy(newState.vel);
    this.state.yaw = newState.yaw;
    this.state.pitch = newState.pitch;
    this.state.onGround = newState.onGround;
  }

  update(dt: number): void {
    this.updateInputState();
    this.updateGroundedState();
    this.updateJump();
    this.applyMovement(dt);
  }

  private updateInputState(): void {
    // Auto-hop: jump key acts as hold-to-jump
    if (MOVEMENT_CONFIG.autoHop) {
      this.wishJump = this.input.jumpHeld;
    } else {
      // Toggle mode: set on press, reset when not pressed
      if (this.input.jumpPressed) {
        this.wishJump = true;
      } else if (!this.input.jumpHeld) {
        this.wishJump = false;
      }
    }
  }

  private updateGroundedState(): void {
    this.groundedBufferedByDistance = this.checkIfGrounded();
  }

  private checkIfGrounded(threshold: number = 0.2, offset: number = 1.8): boolean {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + offset;
    const distance = this.state.pos.y - groundY;

    if (!this.input.skiHeld) {
      return distance < threshold;
    } else {
      return distance < threshold + MOVEMENT_CONFIG.skiTargetDistance;
    }
  }

  private updateJump(): void {
    const anyGrounded = this.state.onGround || this.groundedBufferedByDistance;

    if (this.allowNextJump && anyGrounded && this.wishJump) {
      this.unground();
      this.jump();
    }
  }

  private unground(): void {
    this.allowNextJump = false;
    this.state.onGround = false;
    this.groundedBufferedByDistance = false;
  }

  private jump(): void {
    const jumpDir = this.getInputDirection();
    const jumpImpulse = this.calculateJumpImpulse(jumpDir);
    
    // Preserve current horizontal velocity, add jump impulse
    // This matches Unity's AddForce(ForceMode.VelocityChange) behavior
    this.state.vel.add(jumpImpulse);
  }

  private calculateJumpImpulse(moveDirection: THREE.Vector3): THREE.Vector3 {
    const impulse = MOVEMENT_CONFIG.jumpSpeed;
    const surfaceDirection = this.lastJumpableNormal.y; // dot with (0,1,0)
    const orientation = this.lastJumpableNormal.dot(moveDirection);

    const jump = _jump.set(0, impulse * surfaceDirection, 0);

    if (moveDirection.lengthSq() === 0) {
      // No movement input - jump along slope horizontal component
      jump.add(_jumpHoriz.set(this.lastJumpableNormal.x, 0, this.lastJumpableNormal.z).multiplyScalar(impulse));
    } else if (orientation > 0) {
      // Jump in movement direction along slope
      jump.add(_jumpHoriz.copy(moveDirection).multiplyScalar(impulse * orientation));
    }

    return jump;
  }

  private applyMovement(dt: number): void {
    const inputDir = this.getInputDirection();

    // Ground movement
    if (this.state.onGround && !this.wishJump) {
      if (!this.input.skiHeld) {
        this.applyGroundMovement(dt, inputDir);
      }
      // Skiing: just a friction toggle, no artificial acceleration/boost/lift
      // Friction is handled in handleTerrainCollision
    }

    // Air movement
    if (!this.state.onGround) {
      this.applyAirMovement(dt, inputDir);
    }

    // Gravity (only in air)
    if (!this.state.onGround) {
      this.state.vel.y += GRAVITY * dt;
      // Terminal velocity
      if (this.state.vel.y < -MOVEMENT_CONFIG.terminalVelocity) {
        this.state.vel.y = -MOVEMENT_CONFIG.terminalVelocity;
      }
    }

    // Integrate position
    this.state.pos.addScaledVector(this.state.vel, dt);

    // Terrain collision
    this.handleTerrainCollision();
  }

  private applyGroundMovement(dt: number, inputDir: THREE.Vector3): void {
    // Only apply ground movement when actually grounded
    if (!this.state.onGround) {
      return;
    }

    const normal = this.terrain.getNormal(this.state.pos.x, this.state.pos.z);

    // Project input direction onto terrain slope
    const slopeInputDir = _slopeDir.copy(inputDir);
    if (inputDir.lengthSq() > 0) {
      // Project input onto slope surface (remove component along normal)
      slopeInputDir.addScaledVector(normal, -inputDir.dot(normal));
      if (slopeInputDir.lengthSq() > 0.0001) {
        slopeInputDir.normalize();
      }
    }

    if (slopeInputDir.lengthSq() > 0) {
      this.state.vel.addScaledVector(slopeInputDir, MOVEMENT_CONFIG.groundAccelerate * dt);
    } else {
      // Friction when no input
      const speed = this.state.vel.length();
      if (speed > MOVEMENT_CONFIG.stopThreshold) {
        this.state.vel.addScaledVector(_fric.copy(this.state.vel).normalize(), -MOVEMENT_CONFIG.groundFriction * dt);
      } else {
        this.state.vel.set(0, 0, 0);
      }
    }

    // Redirect velocity along terrain slope
    const velDotNormal = this.state.vel.dot(normal);
    if (velDotNormal < 0) {
      this.state.vel.addScaledVector(normal, -velDotNormal);
    }

    // Hard speed cap
    if (this.state.vel.length() > MOVEMENT_CONFIG.maxVelocityGround) {
      this.state.vel.normalize().multiplyScalar(MOVEMENT_CONFIG.maxVelocityGround);
    }
  }

  private applyAirMovement(dt: number, inputDir: THREE.Vector3): void {
    // Magnitude-preserving air control
    this.vectorShiftLateral(
      this.state.vel,
      _shift.copy(inputDir).multiplyScalar(MOVEMENT_CONFIG.airControl),
      true
    );
  }

  // Mutates initialVector in place — callers' state.vel aliases must not be reseated
  private vectorShiftLateral(initialVector: THREE.Vector3, shiftVector: THREE.Vector3, _preserveY: boolean): void {
    const startingY = initialVector.y;
    initialVector.y = 0;

    const startingMagnitude = Math.max(initialVector.length(), MOVEMENT_CONFIG.maxPassiveAirvel);
    initialVector.add(shiftVector);

    if (initialVector.length() > startingMagnitude) {
      initialVector.normalize().multiplyScalar(startingMagnitude);
    }

    initialVector.y = startingY;
  }

  private handleTerrainCollision(): void {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + 1.8; // PLAYER_HEIGHT
    const distanceToGround = this.state.pos.y - groundY;

    // Only snap if actually penetrating ground (below surface)
    if (distanceToGround < 0) {
      const anyGrounded = this.state.onGround || this.groundedBufferedByDistance;
      // getNormal returns a shared scratch vector — copy before it is reused
      const normal = this.terrain.getNormal(this.state.pos.x, this.state.pos.z);

      // Always update lastJumpableNormal while grounded (like Unity's OnCollisionStay)
      this.lastJumpableNormal.copy(normal);

      // Skiing: preserve speed, redirect along slope (simple friction toggle)
      if (this.input.skiHeld && anyGrounded) {
        const dot = this.state.vel.dot(normal);
        this.state.vel.addScaledVector(normal, -dot * 0.98);
      } else {
        // Normal ground collision - redirect velocity along surface, preserve horizontal momentum
        const velDotNormal = this.state.vel.dot(normal);
        if (velDotNormal < 0) {
          this.state.vel.addScaledVector(normal, -velDotNormal);
        }
      }

      this.state.pos.y = groundY;
      // Only count as grounded when not ascending — a rising explosion
      // impulse that's still clipping the surface shouldn't re-ground us.
      const rising = this.state.vel.y > 0.1;
      this.state.onGround = !rising;
      this.allowNextJump = !rising;
    } else if (distanceToGround < 0.2 && this.state.vel.y <= 0.1) {
      // Very close to ground - considered grounded but don't snap position.
      // Not counted while ascending: explosion/jump liftoff must not spend
      // its first frames under ground friction.
      this.state.onGround = true;
      this.allowNextJump = true;
    } else {
      // In air - not grounded
      this.state.onGround = false;
    }
  }

  private getInputDirection(): THREE.Vector3 {
    const fwdX = Math.sin(this.state.yaw), fwdZ = Math.cos(this.state.yaw);
    const rgtX = -fwdZ, rgtZ = fwdX;

    const mx = fwdX * this.input.forward + rgtX * this.input.right;
    const mz = fwdZ * this.input.forward + rgtZ * this.input.right;

    // Returned scratch — valid until the next getInputDirection() call
    const dir = _inputDir.set(mx, 0, mz);
    if (dir.lengthSq() > 0) {
      dir.normalize();
    }
    return dir;
  }
}
