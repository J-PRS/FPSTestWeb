import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { GRAVITY } from './config.js';

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
  jumpSpeed: 10.0,
  groundedTimeBuffer: 0.25,
  autoHop: true,

  // Skiing
  skiControl: 0.5,
  skiStickyThreshold: 1.0,
  skiStickyLift: 0.51,
  skiTargetDistance: 0.5,
  skiUplift: 50.0,
  skiDownlift: 50.0,
  skiLiftCutoff: 5.0,
  skiBoost: 0.0, // Disabled for now (was 35.0)
  skiBoostThreshold: 20.0, // Increased to allow boost at higher speeds
  skiAccel: 0.5, // Increased from 0.2 for more active acceleration
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

export class MovementController {
  private terrain: Terrain;
  private state: MovementState;
  private input: MovementInput;

  // Internal state
  private groundedTimer: number = 0;
  private groundedBufferedByTime: boolean = false;
  private groundedBufferedByDistance: boolean = false;
  private wishJump: boolean = false;
  private skiBoostDone: boolean = false;
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
    this.groundedTimer = MOVEMENT_CONFIG.groundedTimeBuffer + 1.0;
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
    this.updateGroundedState(dt);
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

    // Reset ski boost when ski key released
    if (!this.input.skiHeld) {
      this.skiBoostDone = false;
    }
  }

  private updateGroundedState(dt: number): void {
    if (!this.state.onGround) {
      this.groundedTimer += dt;
    }

    this.groundedBufferedByDistance = this.checkIfGrounded();
    this.groundedBufferedByTime = this.groundedTimer <= MOVEMENT_CONFIG.groundedTimeBuffer;
  }

  private checkIfGrounded(threshold: number = 0.5, offset: number = 1.8): boolean {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + offset;
    const distance = this.state.pos.y - groundY;
    
    if (!this.input.skiHeld) {
      return distance < threshold;
    } else {
      return distance < threshold + MOVEMENT_CONFIG.skiTargetDistance;
    }
  }

  private updateJump(): void {
    const anyGrounded = this.state.onGround || this.groundedBufferedByTime || this.groundedBufferedByDistance;

    if (this.allowNextJump && anyGrounded && this.wishJump) {
      this.unground();
      this.jump();
    }
  }

  private unground(): void {
    this.allowNextJump = false;
    this.state.onGround = false;
    this.groundedBufferedByTime = false;
    this.groundedBufferedByDistance = false;
    this.groundedTimer += MOVEMENT_CONFIG.groundedTimeBuffer;
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
    const surfaceDirection = this.lastJumpableNormal.dot(new THREE.Vector3(0, 1, 0));
    const orientation = this.lastJumpableNormal.dot(moveDirection);
    
    let jump = new THREE.Vector3(0, impulse * surfaceDirection, 0);

    if (moveDirection.length() === 0) {
      // No movement input - jump along slope horizontal component
      jump.add(new THREE.Vector3(this.lastJumpableNormal.x, 0, this.lastJumpableNormal.z).multiplyScalar(impulse));
    } else if (orientation > 0) {
      // Jump in movement direction along slope
      jump.add(moveDirection.clone().multiplyScalar(impulse * orientation));
    }

    return jump;
  }

  private applyMovement(dt: number): void {
    // Gravity
    this.state.vel.y += GRAVITY * dt;

    // Terminal velocity
    if (this.state.vel.y < -MOVEMENT_CONFIG.terminalVelocity) {
      this.state.vel.y = -MOVEMENT_CONFIG.terminalVelocity;
    }

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
    if (!this.state.onGround && !this.groundedBufferedByTime) {
      this.applyAirMovement(dt, inputDir);
    }

    // Integrate position
    this.state.pos.add(this.state.vel.clone().multiplyScalar(dt));

    // Terrain collision
    this.handleTerrainCollision();
  }

  private applyGroundMovement(dt: number, inputDir: THREE.Vector3): void {
    if (inputDir.length() > 0) {
      this.state.vel.add(inputDir.multiplyScalar(MOVEMENT_CONFIG.groundAccelerate * dt));
    } else {
      // Friction when no input
      const speed = this.state.vel.length();
      if (speed > MOVEMENT_CONFIG.stopThreshold) {
        const friction = this.state.vel.clone().normalize().multiplyScalar(-MOVEMENT_CONFIG.groundFriction * dt);
        this.state.vel.add(friction);
      } else {
        this.state.vel.set(0, 0, 0);
      }
    }

    // Hard speed cap
    if (this.state.vel.length() > MOVEMENT_CONFIG.maxVelocityGround) {
      this.state.vel.normalize().multiplyScalar(MOVEMENT_CONFIG.maxVelocityGround);
    }
  }

  private applySkiAccel(dt: number, inputDir: THREE.Vector3): void {
    // Only apply ski acceleration when actively skiing (skiHeld AND on ground)
    if (this.input.skiHeld && this.state.onGround && inputDir.length() > 0) {
      if (this.state.vel.length() <= MOVEMENT_CONFIG.maxVelocityGround * 3) {
        this.state.vel.add(inputDir.clone().multiplyScalar(MOVEMENT_CONFIG.skiAccel * MOVEMENT_CONFIG.groundAccelerate * dt));
      }
    }
  }

  private applySkiMovement(dt: number, inputDir: THREE.Vector3): void {
    // Lateral steering with magnitude preservation
    this.state.vel = this.vectorShiftLateral(
      this.state.vel,
      inputDir.clone().multiplyScalar(MOVEMENT_CONFIG.skiControl),
      true
    );

    // Ski boost
    this.applySkiBoost(inputDir);

    // Legions-style lift forces
    this.applySkiLift(dt);
  }

  private applySkiBoost(inputDir: THREE.Vector3): void {
    if (!this.skiBoostDone && this.input.skiHeld && this.state.vel.length() <= MOVEMENT_CONFIG.skiBoostThreshold) {
      if (inputDir.length() > 0) {
        this.state.vel = inputDir.clone().multiplyScalar(MOVEMENT_CONFIG.skiBoost);
      } else {
        // Use camera forward if no input
        const cameraForward = new THREE.Vector3(Math.sin(this.state.yaw), 0, Math.cos(this.state.yaw)).normalize();
        this.state.vel = cameraForward.multiplyScalar(MOVEMENT_CONFIG.skiBoost);
      }
      this.skiBoostDone = true;
    }
  }

  private applySkiLift(dt: number): void {
    const distanceToGround = this.distanceToGround();
    const distanceDifference = MOVEMENT_CONFIG.skiTargetDistance - distanceToGround;
    let skiLift = 1.0;

    if (Math.abs(this.state.vel.y) < MOVEMENT_CONFIG.skiLiftCutoff) {
      if (distanceDifference > 0) {
        skiLift = distanceDifference * MOVEMENT_CONFIG.skiUplift;
      } else {
        skiLift = distanceDifference * MOVEMENT_CONFIG.skiDownlift;
      }
    }

    const force = new THREE.Vector3(0, skiLift * dt, 0);
    this.state.vel.add(force);

    // Preserve magnitude after lift
    const currentMagnitude = this.state.vel.length();
    if (currentMagnitude > 0) {
      this.state.vel.normalize().multiplyScalar(currentMagnitude);
    }
  }

  private applyAirMovement(dt: number, inputDir: THREE.Vector3): void {
    // Magnitude-preserving air control
    this.state.vel = this.vectorShiftLateral(
      this.state.vel,
      inputDir.clone().multiplyScalar(MOVEMENT_CONFIG.airControl),
      true
    );
  }

  private vectorShiftLateral(initialVector: THREE.Vector3, shiftVector: THREE.Vector3, _preserveY: boolean): THREE.Vector3 {
    const startingY = initialVector.y;
    initialVector.y = 0;
    
    const startingMagnitude = Math.max(initialVector.length(), MOVEMENT_CONFIG.maxPassiveAirvel);
    const combinedVector = initialVector.clone().add(shiftVector);
    
    let finalVector: THREE.Vector3;
    if (combinedVector.length() > startingMagnitude) {
      finalVector = combinedVector.normalize().multiplyScalar(startingMagnitude);
    } else {
      finalVector = combinedVector;
    }

    finalVector.y = startingY;
    return finalVector;
  }

  private distanceToGround(offset: number = 1.8): number {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z);
    return this.state.pos.y - groundY - offset;
  }

  private handleTerrainCollision(): void {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + 1.8; // PLAYER_HEIGHT

    if (this.state.pos.y <= groundY) {
      const anyGrounded = this.state.onGround || this.groundedBufferedByTime || this.groundedBufferedByDistance;
      const normal = this.terrain.getNormal(this.state.pos.x, this.state.pos.z);

      // Always update lastJumpableNormal while grounded (like Unity's OnCollisionStay)
      this.lastJumpableNormal = normal;

      // Skiing: preserve speed, redirect along slope (simple friction toggle)
      if (this.input.skiHeld && anyGrounded) {
        const dot = this.state.vel.dot(normal);
        this.state.vel.add(normal.clone().multiplyScalar(-dot * 0.98));
      } else {
        // Normal ground collision - redirect velocity along surface, preserve horizontal momentum
        if (this.state.vel.y < 0) {
          // Project velocity onto the surface plane
          const velDotNormal = this.state.vel.dot(normal);
          if (velDotNormal < 0) {
            this.state.vel.add(normal.clone().multiplyScalar(-velDotNormal));
          }
        }
      }

      this.state.pos.y = groundY;
      this.state.onGround = true;
      this.allowNextJump = true;
      this.groundedTimer = 0;
    } else {
      // Use buffered state for onGround to prevent flickering
      const anyGrounded = this.groundedBufferedByTime || this.groundedBufferedByDistance;
      this.state.onGround = anyGrounded;
    }
  }

  private getInputDirection(): THREE.Vector3 {
    const fwd = new THREE.Vector2(Math.sin(this.state.yaw), Math.cos(this.state.yaw));
    const rgt = new THREE.Vector2(-Math.cos(this.state.yaw), Math.sin(this.state.yaw));

    let mx = 0, mz = 0;
    mx += fwd.x * this.input.forward;
    mz += fwd.y * this.input.forward;
    mx += rgt.x * this.input.right;
    mz += rgt.y * this.input.right;

    const dir = new THREE.Vector3(mx, 0, mz);
    if (dir.length() > 0) {
      dir.normalize();
    }
    return dir;
  }
}
