/**
 * Server-side movement controller for authoritative physics
 * Mirrors client-side movement.ts logic for server-authoritative movement
 */

import { ServerConfig } from './config.js';

// Movement parameters (must match client MOVEMENT_CONFIG)
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
  skiBoost: 0.0,
  skiBoostThreshold: 20.0,
  skiAccel: 0.5,
} as const;

export const PHYSICS_CONFIG = {
  GRAVITY: ServerConfig.GRAVITY,
  PLAYER_HEIGHT: 1.8,
} as const;

export interface MovementState {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export interface MovementInput {
  forward: number; // -1 to 1
  right: number; // -1 to 1
  jump: boolean;
  ski: boolean;
}

export class MovementController {
  private state: MovementState;
  private input: MovementInput;

  // Internal state
  private groundedTimer: number = 0;
  private groundedBufferedByTime: boolean = false;
  private groundedBufferedByDistance: boolean = false;
  private wishJump: boolean = false;
  private skiBoostDone: boolean = false;
  private lastJumpableNormal: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 };
  private allowNextJump: boolean = true;

  // Terrain interface (abstract to allow different implementations)
  private terrain: {
    getHeight(x: number, z: number): number;
    getNormal(x: number, z: number): { x: number; y: number; z: number };
  };

  constructor(terrain: any, initialState: MovementState) {
    this.terrain = terrain;
    this.state = initialState;
    this.input = {
      forward: 0,
      right: 0,
      jump: false,
      ski: false,
    };
    this.groundedTimer = MOVEMENT_CONFIG.groundedTimeBuffer + 1.0;
  }

  setInput(input: Partial<MovementInput>): void {
    if (input.forward !== undefined) this.input.forward = input.forward;
    if (input.right !== undefined) this.input.right = input.right;
    if (input.jump !== undefined) this.input.jump = input.jump;
    if (input.ski !== undefined) this.input.ski = input.ski;
  }

  getState(): MovementState {
    return this.state;
  }

  setState(newState: MovementState): void {
    this.state.pos = { ...newState.pos };
    this.state.vel = { ...newState.vel };
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
      this.wishJump = this.input.jump;
    } else {
      // Toggle mode: set on press, reset when not pressed
      if (this.input.jump) {
        this.wishJump = true;
      } else if (!this.input.jump) {
        this.wishJump = false;
      }
    }

    // Reset ski boost when ski key released
    if (!this.input.ski) {
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

  private checkIfGrounded(threshold: number = 0.5, offset: number = PHYSICS_CONFIG.PLAYER_HEIGHT): boolean {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + offset;
    const distance = this.state.pos.y - groundY;
    
    if (!this.input.ski) {
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
    this.state.vel.x += jumpImpulse.x;
    this.state.vel.y += jumpImpulse.y;
    this.state.vel.z += jumpImpulse.z;
  }

  private calculateJumpImpulse(moveDirection: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const impulse = MOVEMENT_CONFIG.jumpSpeed;
    const surfaceDirection = this.dot(this.lastJumpableNormal, { x: 0, y: 1, z: 0 });
    const orientation = this.dot(this.lastJumpableNormal, moveDirection);
    
    let jump = { x: 0, y: impulse * surfaceDirection, z: 0 };

    const moveDirLen = Math.sqrt(moveDirection.x * moveDirection.x + moveDirection.z * moveDirection.z);
    if (moveDirLen === 0) {
      // No movement input - jump along slope horizontal component
      jump.x += this.lastJumpableNormal.x * impulse;
      jump.z += this.lastJumpableNormal.z * impulse;
    } else if (orientation > 0) {
      // Jump in movement direction along slope
      jump.x += moveDirection.x * impulse * orientation;
      jump.z += moveDirection.z * impulse * orientation;
    }

    return jump;
  }

  private applyMovement(dt: number): void {
    // Gravity
    this.state.vel.y += PHYSICS_CONFIG.GRAVITY * dt;

    // Terminal velocity
    if (this.state.vel.y < -MOVEMENT_CONFIG.terminalVelocity) {
      this.state.vel.y = -MOVEMENT_CONFIG.terminalVelocity;
    }

    const anyGrounded = this.state.onGround || this.groundedBufferedByTime || this.groundedBufferedByDistance;
    const inputDir = this.getInputDirection();

    // Ground movement
    if (this.state.onGround && !this.wishJump) {
      if (!this.input.ski) {
        this.applyGroundMovement(dt, inputDir);
      }
    }

    // Air movement
    if (!this.state.onGround && !this.groundedBufferedByTime) {
      this.applyAirMovement(dt, inputDir);
    }

    // Integrate position
    this.state.pos.x += this.state.vel.x * dt;
    this.state.pos.y += this.state.vel.y * dt;
    this.state.pos.z += this.state.vel.z * dt;

    // Terrain collision
    this.handleTerrainCollision();
  }

  private applyGroundMovement(dt: number, inputDir: { x: number; y: number; z: number }): void {
    const inputDirLen = Math.sqrt(inputDir.x * inputDir.x + inputDir.z * inputDir.z);
    if (inputDirLen > 0) {
      this.state.vel.x += inputDir.x * MOVEMENT_CONFIG.groundAccelerate * dt;
      this.state.vel.z += inputDir.z * MOVEMENT_CONFIG.groundAccelerate * dt;
    } else {
      // Friction when no input
      const speed = Math.sqrt(this.state.vel.x * this.state.vel.x + this.state.vel.z * this.state.vel.z);
      if (speed > MOVEMENT_CONFIG.stopThreshold) {
        const velLen = Math.sqrt(this.state.vel.x * this.state.vel.x + this.state.vel.z * this.state.vel.z);
        const frictionX = (this.state.vel.x / velLen) * -MOVEMENT_CONFIG.groundFriction * dt;
        const frictionZ = (this.state.vel.z / velLen) * -MOVEMENT_CONFIG.groundFriction * dt;
        this.state.vel.x += frictionX;
        this.state.vel.z += frictionZ;
      } else {
        this.state.vel.x = 0;
        this.state.vel.z = 0;
      }
    }

    // Hard speed cap
    const speed = Math.sqrt(this.state.vel.x * this.state.vel.x + this.state.vel.z * this.state.vel.z);
    if (speed > MOVEMENT_CONFIG.maxVelocityGround) {
      const velLen = Math.sqrt(this.state.vel.x * this.state.vel.x + this.state.vel.z * this.state.vel.z);
      this.state.vel.x = (this.state.vel.x / velLen) * MOVEMENT_CONFIG.maxVelocityGround;
      this.state.vel.z = (this.state.vel.z / velLen) * MOVEMENT_CONFIG.maxVelocityGround;
    }
  }

  private applyAirMovement(dt: number, inputDir: { x: number; y: number; z: number }): void {
    // Magnitude-preserving air control
    this.state.vel = this.vectorShiftLateral(
      this.state.vel,
      { x: inputDir.x * MOVEMENT_CONFIG.airControl, y: 0, z: inputDir.z * MOVEMENT_CONFIG.airControl },
      true
    );
  }

  private vectorShiftLateral(initialVector: { x: number; y: number; z: number }, shiftVector: { x: number; y: number; z: number }, preserveY: boolean): { x: number; y: number; z: number } {
    const startingY = initialVector.y;
    const initialXZ = { x: initialVector.x, y: 0, z: initialVector.z };
    
    const startingMagnitude = Math.max(
      Math.sqrt(initialXZ.x * initialXZ.x + initialXZ.z * initialXZ.z),
      MOVEMENT_CONFIG.maxPassiveAirvel
    );
    const combinedVector = {
      x: initialXZ.x + shiftVector.x,
      y: 0,
      z: initialXZ.z + shiftVector.z
    };
    
    let finalVector: { x: number; y: number; z: number };
    const combinedLen = Math.sqrt(combinedVector.x * combinedVector.x + combinedVector.z * combinedVector.z);
    if (combinedLen > startingMagnitude) {
      finalVector = {
        x: (combinedVector.x / combinedLen) * startingMagnitude,
        y: 0,
        z: (combinedVector.z / combinedLen) * startingMagnitude
      };
    } else {
      finalVector = combinedVector;
    }

    finalVector.y = startingY;
    return finalVector;
  }

  private handleTerrainCollision(): void {
    const groundY = this.terrain.getHeight(this.state.pos.x, this.state.pos.z) + PHYSICS_CONFIG.PLAYER_HEIGHT;

    if (this.state.pos.y <= groundY) {
      const anyGrounded = this.state.onGround || this.groundedBufferedByTime || this.groundedBufferedByDistance;
      const normal = this.terrain.getNormal(this.state.pos.x, this.state.pos.z);

      // Always update lastJumpableNormal while grounded
      this.lastJumpableNormal = normal;

      // Skiing: preserve speed, redirect along slope
      if (this.input.ski && anyGrounded) {
        const dot = this.state.vel.x * normal.x + this.state.vel.y * normal.y + this.state.vel.z * normal.z;
        this.state.vel.x += -normal.x * dot * 0.98;
        this.state.vel.y += -normal.y * dot * 0.98;
        this.state.vel.z += -normal.z * dot * 0.98;
      } else {
        // Normal ground collision - redirect velocity along surface
        if (this.state.vel.y < 0) {
          const velDotNormal = this.state.vel.x * normal.x + this.state.vel.y * normal.y + this.state.vel.z * normal.z;
          if (velDotNormal < 0) {
            this.state.vel.x += -normal.x * velDotNormal;
            this.state.vel.y += -normal.y * velDotNormal;
            this.state.vel.z += -normal.z * velDotNormal;
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

  private getInputDirection(): { x: number; y: number; z: number } {
    const fwd = { x: Math.sin(this.state.yaw), y: 0, z: Math.cos(this.state.yaw) };
    const rgt = { x: -Math.cos(this.state.yaw), y: 0, z: Math.sin(this.state.yaw) };

    let mx = 0, mz = 0;
    mx += fwd.x * this.input.forward;
    mz += fwd.z * this.input.forward;
    mx += rgt.x * this.input.right;
    mz += rgt.z * this.input.right;

    const dir = { x: mx, y: 0, z: mz };
    const dirLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    if (dirLen > 0) {
      dir.x /= dirLen;
      dir.z /= dirLen;
    }
    return dir;
  }

  private dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }
}
