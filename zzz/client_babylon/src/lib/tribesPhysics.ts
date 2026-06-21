import * as BABYLON from '@babylonjs/core';
import {
  GRAVITY,
  TRIBES_TICKS_PER_SECOND,
  TRIBES_TICK_LENGTH,
  ARMOR_WALKSPEED,
  ARMOR_JUMPIMPULSE,
  ARMOR_MASS,
  ARMOR_MAXENERGY,
  ARMOR_JETENERGY_DRAIN,
  ARMOR_JETENERGY_CHARGE,
  JET_FORCE,
  CRAWLTOSTOP,
  MAXJUMPTICKS
} from './constants';
import type { ISystem } from './core/ISystem';
import type { InputState } from './core';

export interface TribesPlayerState {
  position: BABYLON.Vector3;
  velocity: BABYLON.Vector3;
  energy: number;
  lastJumpableNormalTimestamp: number;
  lastJumpableNormal: BABYLON.Vector3;
  collisionLastTick: boolean;
}

export class TribesPhysics implements ISystem {
  private state: TribesPlayerState;
  private scene: BABYLON.Scene;
  private ground: BABYLON.Mesh;
  public readonly updateOrder = 15; // Player physics after general physics

  constructor(scene: BABYLON.Scene, ground: BABYLON.Mesh, startPosition: BABYLON.Vector3) {
    this.scene = scene;
    this.ground = ground;
    this.state = {
      position: startPosition.clone(),
      velocity: BABYLON.Vector3.Zero(),
      energy: ARMOR_MAXENERGY,
      lastJumpableNormalTimestamp: MAXJUMPTICKS,
      lastJumpableNormal: BABYLON.Vector3.Up(),
      collisionLastTick: false
    };
  }

  // Convert Tribes meters to Babylon units (1:1 for simplicity)
  private metersToUnits(meters: number): number {
    return meters;
  }

  // Get movement direction from input
  private getMovementDirection(input: InputState): BABYLON.Vector3 {
    const forward = this.scene.activeCamera!.getDirection(BABYLON.Axis.Z);
    forward.y = 0;
    forward.normalize();
    
    const right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), forward);
    
    const moveDir = BABYLON.Vector3.Zero();
    if (input.forward) moveDir.addInPlace(forward);
    if (input.backward) moveDir.addInPlace(forward.scale(-1));
    if (input.left) moveDir.addInPlace(right.scale(-1));
    if (input.right) moveDir.addInPlace(right);
    
    if (moveDir.length() > 0) {
      moveDir.normalize();
    }
    
    return moveDir;
  }

  // Get movement speed vector (for walking)
  private getMovementSpeed(input: InputState): BABYLON.Vector3 {
    const forward = this.scene.activeCamera!.getDirection(BABYLON.Axis.Z);
    forward.y = 0;
    forward.normalize();
    
    const right = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), forward);
    
    const maxSpeed = this.metersToUnits(ARMOR_WALKSPEED);
    const forwardSpeed = this.metersToUnits(ARMOR_WALKSPEED);
    const sideSpeed = this.metersToUnits(ARMOR_WALKSPEED - 1);
    
    const speed = new BABYLON.Vector3(
      (input.right ? 1 : 0) - (input.left ? 1 : 0),
      0,
      (input.forward ? 1 : 0) - (input.backward ? 1 : 0)
    );
    
    speed.x *= sideSpeed;
    speed.z *= forwardSpeed;
    
    if (speed.length() > maxSpeed) {
      speed.scaleInPlace(maxSpeed / speed.length());
    }
    
    // Transform to world space
    const worldSpeed = new BABYLON.Vector3(
      speed.x * right.x + speed.z * forward.x,
      0,
      speed.x * right.z + speed.z * forward.z
    );
    
    return worldSpeed;
  }

  // Tribes 1 Jump function
  private jump(moveDirection: BABYLON.Vector3): BABYLON.Vector3 {
    // Need another ground contact before we can jump again
    this.state.lastJumpableNormalTimestamp = MAXJUMPTICKS;
    
    // Jump up
    const surfaceDirection = BABYLON.Vector3.Dot(this.state.lastJumpableNormal, BABYLON.Vector3.Up());
    const impulse = this.metersToUnits(ARMOR_JUMPIMPULSE / ARMOR_MASS);
    const jump = BABYLON.Vector3.Up().scale(surfaceDirection * impulse);
    
    // If moving away from surface, jump away
    const orientation = BABYLON.Vector3.Dot(this.state.lastJumpableNormal, moveDirection);
    if (orientation > 0) {
      jump.addInPlace(moveDirection.scale(impulse * orientation));
    }
    
    return jump;
  }

  // Tribes 1 Jet function
  private jet(moveDirection: BABYLON.Vector3, tickLen: number): BABYLON.Vector3 {
    const jetForce = this.metersToUnits(JET_FORCE);
    // Jet applies force in movement direction (air control) - if no input, jet straight up
    if (moveDirection.length() > 0) {
      // Blend: upward component always present, horizontal from moveDirection
      const upComponent = BABYLON.Vector3.Up().scale(jetForce * 0.7);
      const dirComponent = moveDirection.scale(jetForce * 0.5);
      return upComponent.add(dirComponent);
    }
    return BABYLON.Vector3.Up().scale(jetForce);
  }

  // Tribes 1 Friction function
  private friction(moveSpeed: BABYLON.Vector3, tickLen: number): BABYLON.Vector3 {
    const velocityLen = this.state.velocity.length();
    const crawlToStop = this.metersToUnits(CRAWLTOSTOP);
    
    // If moving very slowly and no input, stop completely
    if (velocityLen < crawlToStop && moveSpeed.length() === 0) {
      return this.state.velocity.scale(-1); // Stop
    }
    
    // Apply friction to match movement speed
    const friction = moveSpeed.subtract(this.state.velocity);
    const frictionFactor = 0.5; // Increased for better responsiveness
    return friction.scale(frictionFactor);
  }

  // Main physics tick
  tick(input: InputState, dt: number): void {
    const tickLen = dt; // Use actual delta time for now
    
    // Get movement vectors
    const moveSpeed = this.getMovementSpeed(input);
    const moveDirection = this.getMovementDirection(input);
    
    // Check if can jump
    const isJumping = input.jump && (this.state.lastJumpableNormalTimestamp < MAXJUMPTICKS);
    
    // Check if can jet
    const isJetting = input.jetpack && (this.state.energy > 0);
    
    // Jump
    if (isJumping) {
      this.state.velocity.addInPlace(this.jump(moveDirection));
    }
    
    // Jets and acceleration
    let accel = GRAVITY.clone();
    this.state.energy += ARMOR_JETENERGY_CHARGE * tickLen;
    
    if (isJetting) {
      accel.addInPlace(this.jet(moveDirection, tickLen));
      this.state.energy -= ARMOR_JETENERGY_DRAIN * tickLen;
    }
    
    this.state.energy = Math.max(0, Math.min(ARMOR_MAXENERGY, this.state.energy));
    
    // Apply acceleration
    this.state.velocity.addInPlace(accel.scale(tickLen));
    
    // Walking and friction (only if on ground and not skiing)
    // Holding jump while grounded = ski mode: no friction, preserve momentum
    const isSkiing = input.jump && this.state.collisionLastTick;
    if (this.state.collisionLastTick && !isSkiing) {
      this.state.velocity.addInPlace(this.friction(moveSpeed, tickLen));
    } else if (!this.state.collisionLastTick && moveDirection.length() > 0) {
      // Air control: small horizontal nudge while airborne, no vertical component
      const airControlForce = 8; // m/s² - subtle, doesn't override momentum
      const airAccel = new BABYLON.Vector3(moveDirection.x, 0, moveDirection.z).scale(airControlForce * tickLen);
      this.state.velocity.addInPlace(airAccel);
    }
    
    // Update jumpable timestamp
    this.state.lastJumpableNormalTimestamp += tickLen * TRIBES_TICKS_PER_SECOND;
    
    // Update position
    this.state.position.addInPlace(this.state.velocity.scale(tickLen));
    
    // Collision detection (raycast down)
    this.handleCollision();
  }

  // Handle terrain collision
  private handleCollision(): void {
    const ray = new BABYLON.Ray(this.state.position, new BABYLON.Vector3(0, -1, 0), 100);
    const hit = this.scene.pickWithRay(ray, (mesh) => mesh === this.ground);
    
    this.state.collisionLastTick = false;
    
    if (hit && hit.hit) {
      const distance = hit.distance;
      const playerRadius = 0.5;
      const minimumDistance = playerRadius + 0.5;
      
      if (distance < minimumDistance) {
        // Collision with ground
        this.state.position.y = hit.pickedPoint!.y + minimumDistance;
        
        // Update jumpable normal
        this.state.lastJumpableNormal = hit.getNormal(true)!;
        this.state.lastJumpableNormalTimestamp = 0;
        this.state.collisionLastTick = true;
        
        // Stop downward velocity
        if (this.state.velocity.y < 0) {
          this.state.velocity.y = 0;
        }
      }
    } else {
      // Safety recovery: if raycast fails and player is very low, teleport up
      if (this.state.position.y < 5) {
        this.state.position.y = 20;
        this.state.velocity.y = 0;
      }
    }
  }

  // Get current state
  getState(): TribesPlayerState {
    return {
      position: this.state.position.clone(),
      velocity: this.state.velocity.clone(),
      energy: this.state.energy,
      lastJumpableNormalTimestamp: this.state.lastJumpableNormalTimestamp,
      lastJumpableNormal: this.state.lastJumpableNormal.clone(),
      collisionLastTick: this.state.collisionLastTick
    };
  }

  // Set position (for external updates like camera)
  setPosition(position: BABYLON.Vector3): void {
    this.state.position = position.clone();
  }

  public initialize(): void {
    // Tribes physics doesn't need initialization
  }

  public update(dt: number): void {
    // Tribes physics requires input, so this is a no-op
    // The tick() method is called directly by PlayerController with input
  }

  public dispose(): void {
    // Tribes physics doesn't have resources to dispose
  }
}
