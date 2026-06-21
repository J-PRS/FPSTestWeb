import * as BABYLON from '@babylonjs/core';
import type { ISystem } from './core/ISystem';
import { GRAVITY } from './constants';

export interface RigidBody {
  position: BABYLON.Vector3;
  velocity: BABYLON.Vector3;
  acceleration: BABYLON.Vector3;
  mass: number;
  radius: number;
  restitution: number; // bounciness
  friction: number;
  gravityScale: number;
  isKinematic: boolean;
  mesh?: BABYLON.Mesh;
  entityId?: string; // Reference to entity
  previousPosition?: BABYLON.Vector3; // For swept collision detection
  onCollision?: (position: BABYLON.Vector3, normal: BABYLON.Vector3) => void; // Collision callback
  scene?: BABYLON.Scene; // Scene reference for mesh-based collision
  groundMesh?: BABYLON.Mesh; // Ground mesh for collision
}

export class CustomPhysics implements ISystem {
  private readonly gravity = GRAVITY;
  private readonly bodies: RigidBody[] = [];
  public readonly updateOrder = 10; // Physics should update first

  public initialize(): void {
    // Physics system doesn't need initialization
  }

  public dispose(): void {
    this.bodies.length = 0;
  }

  createBody(config: Partial<RigidBody>): RigidBody {
    const body: RigidBody = {
      position: new BABYLON.Vector3(),
      velocity: new BABYLON.Vector3(),
      acceleration: new BABYLON.Vector3(),
      mass: 1,
      radius: 0.5,
      restitution: 0.3,
      friction: 0.5,
      gravityScale: 1,
      isKinematic: false,
      previousPosition: new BABYLON.Vector3(),
      ...config
    };

    // Initialize previousPosition to current position
    if (body.position) {
      body.previousPosition = body.position.clone();
    }

    this.bodies.push(body);
    return body;
  }

  removeBody(body: RigidBody): void {
    const index = this.bodies.indexOf(body);
    if (index > -1) {
      this.bodies.splice(index, 1);
    }
  }

  update(deltaTime: number): void {
    const dt = Math.min(deltaTime, 0.016); // Cap at 60fps timestep

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (body.isKinematic) continue;

      // Apply gravity
      if (body.gravityScale > 0) {
        body.acceleration = this.gravity.scale(body.gravityScale);
      }

      // Update velocity and position
      body.velocity.addInPlace(body.acceleration.scale(dt));
      
      // Store previous position for swept collision
      body.previousPosition = body.position.clone();
      
      body.position.addInPlace(body.velocity.scale(dt));

      // Terrain collision - swept raycast along movement for fast-moving bodies
      if (body.groundMesh && body.scene && body.entityId !== 'player') {
        const movement = body.position.subtract(body.previousPosition!);
        const movementLength = movement.length();
        
        if (movementLength > 0) {
          // Sweep ray from previous position along movement direction
          const rayDir = movement.normalizeToNew();
          const ray = new BABYLON.Ray(body.previousPosition!, rayDir, movementLength + body.radius);
          const hit = body.scene.pickWithRay(ray, (mesh) => mesh === body.groundMesh);
          
          if (hit && hit.hit && hit.pickedPoint && hit.distance <= movementLength + body.radius) {
            const collisionPoint = hit.pickedPoint;
            const collisionNormal = hit.getNormal(true) || BABYLON.Vector3.Up();
            
            // Push body back along normal so it sits on the surface
            body.position = collisionPoint.add(collisionNormal.scale(body.radius));
            
            // Reflect velocity across terrain normal
            const velocityDotNormal = BABYLON.Vector3.Dot(body.velocity, collisionNormal);
            if (velocityDotNormal < 0) {
              const reflection = collisionNormal.scale((1 + body.restitution) * velocityDotNormal);
              body.velocity.subtractInPlace(reflection);
              const tangent = body.velocity.subtract(collisionNormal.scale(BABYLON.Vector3.Dot(body.velocity, collisionNormal)));
              body.velocity.subtractInPlace(tangent.scale(body.friction * dt));
            }
            
            // Fire callback after physics response
            if (body.onCollision) {
              body.onCollision(body.position, collisionNormal);
            }
          }
        }
      }

      // Body-to-body collision (avoid self-collision and duplicate checks)
      for (let j = i + 1; j < this.bodies.length; j++) {
        const otherBody = this.bodies[j];
        if (otherBody.isKinematic) continue;

        const distance = BABYLON.Vector3.Distance(body.position, otherBody.position);
        const minDistance = body.radius + otherBody.radius;

        if (distance < minDistance && distance > 0) {
          // Collision detected
          const normal = otherBody.position.subtract(body.position).normalize();
          const overlap = minDistance - distance;

          // Separate bodies
          const separation = normal.scale(overlap * 0.5);
          body.position.subtractInPlace(separation);
          otherBody.position.addInPlace(separation);

          // Calculate relative velocity
          const relativeVelocity = otherBody.velocity.subtract(body.velocity);
          const velocityAlongNormal = BABYLON.Vector3.Dot(relativeVelocity, normal);

          // Don't resolve if velocities are separating
          if (velocityAlongNormal > 0) continue;

          // Calculate restitution
          const e = Math.min(body.restitution, otherBody.restitution);

          // Calculate impulse scalar
          const inverseMassSum = 1/body.mass + 1/otherBody.mass;
          const j = -(1 + e) * velocityAlongNormal / inverseMassSum;

          // Apply impulse
          const impulse = normal.scale(j);
          body.velocity.subtractInPlace(impulse.scale(1/body.mass));
          otherBody.velocity.addInPlace(impulse.scale(1/otherBody.mass));
        }
      }

      // Reset acceleration for next frame
      body.acceleration = BABYLON.Vector3.Zero();
    }
  }

  applyForce(body: RigidBody, force: BABYLON.Vector3): void {
    if (!body.isKinematic) {
      body.acceleration.addInPlace(force.scale(1 / body.mass));
    }
  }

  applyImpulse(body: RigidBody, impulse: BABYLON.Vector3): void {
    if (!body.isKinematic) {
      body.velocity.addInPlace(impulse.scale(1 / body.mass));
    }
  }

  setVelocity(body: RigidBody, velocity: BABYLON.Vector3): void {
    if (!body.isKinematic) {
      body.velocity = velocity.clone();
    }
  }

  getBodies(): RigidBody[] {
    return [...this.bodies];
  }
}
