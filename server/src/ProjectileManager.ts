/**
 * Projectile state management
 */

import { Projectile } from './types.js';

export class ProjectileManager {
  private projectiles: Map<string, Projectile> = new Map();
  private idCounter: number = 0;

  getProjectiles(): Map<string, Projectile> {
    return this.projectiles;
  }

  createProjectile(ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }): string {
    const id = `proj_${this.idCounter++}`;
    this.projectiles.set(id, {
      id,
      ownerId,
      position: { ...position },
      velocity: { ...velocity },
      createdAt: Date.now()
    });
    return id;
  }

  getProjectile(id: string): Projectile | undefined {
    return this.projectiles.get(id);
  }

  removeProjectile(id: string): void {
    this.projectiles.delete(id);
  }

  updateProjectile(id: string, position: { x: number; y: number; z: number }): void {
    const projectile = this.projectiles.get(id);
    if (projectile) {
      projectile.position = { ...position };
    }
  }

  updateAll(dt: number, gravity: number, lifetime: number): string[] {
    const now = Date.now();
    const destroyed: string[] = [];

    for (const [id, projectile] of this.projectiles) {
      // Remove old projectiles
      if (now - projectile.createdAt > lifetime) {
        destroyed.push(id);
        continue;
      }

      // Apply gravity
      projectile.velocity.y += gravity * dt;

      // Update position
      projectile.position.x += projectile.velocity.x * dt;
      projectile.position.y += projectile.velocity.y * dt;
      projectile.position.z += projectile.velocity.z * dt;

      // Simple ground collision
      if (projectile.position.y < 0) {
        projectile.position.y = 0;
        projectile.velocity.y = 0;
        projectile.velocity.x *= 0.5;
        projectile.velocity.z *= 0.5;
      }
    }

    // Remove destroyed projectiles
    for (const id of destroyed) {
      this.projectiles.delete(id);
    }

    return destroyed;
  }
}
