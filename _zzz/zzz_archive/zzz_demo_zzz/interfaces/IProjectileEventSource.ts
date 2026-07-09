import * as THREE from 'three';

/**
 * Interface for recording projectile events.
 * Game systems call these methods to notify the demo recorder.
 */
export interface IProjectileEventSource {
  /**
   * Record a projectile fired event.
   * @param position - Initial position
   * @param velocity - Initial velocity
   * @param weaponType - Type of weapon
   */
  recordProjectileFired(position: THREE.Vector3, velocity: THREE.Vector3, weaponType: number): void;

  /**
   * Record a projectile bounce event.
   * @param projectileId - Projectile ID
   * @param position - Bounce position
   * @param velocity - Velocity after bounce
   * @param surfaceNormal - Surface normal at bounce point
   */
  recordProjectileBounce(
    projectileId: number,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    surfaceNormal: THREE.Vector3
  ): void;

  /**
   * Record a projectile hit event.
   * @param projectileId - Projectile ID
   * @param position - Hit position
   * @param targetId - Target ID that was hit
   */
  recordProjectileHit(projectileId: number, position: THREE.Vector3, targetId: number): void;

  /**
   * Record a projectile destroyed event.
   * @param projectileId - Projectile ID
   * @param position - Final position
   */
  recordProjectileDestroyed(projectileId: number, position: THREE.Vector3): void;

  /**
   * Record projectile peak position (velocity.y sign change).
   * Optional enhancement for precision.
   * @param projectileId - Projectile ID
   * @param peakPosition - Peak arc position
   */
  recordProjectilePeak(projectileId: number, peakPosition: THREE.Vector3): void;
}
