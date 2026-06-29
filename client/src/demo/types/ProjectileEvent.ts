import * as THREE from 'three';

/**
 * Event types for projectile keyframe recording.
 */
export enum ProjectileEventType {
  Fired = 0,
  Bounce = 1,
  Hit = 2,
  Destroyed = 3,
}

/**
 * Keyframe event for projectiles (fire, bounce, hit).
 * Only records critical moments for efficient storage.
 * Supports keyframe interpolation for perceptually perfect replay.
 */
export interface ProjectileEvent {
  /** Event type (uint8) */
  eventType: ProjectileEventType;
  /** Timestamp in seconds (float32) */
  timestamp: number;
  /** Projectile position (3 * float32) */
  position: THREE.Vector3;
  /** Projectile velocity (3 * float32) */
  velocity: THREE.Vector3;
  /** Projectile ID (uint16) */
  projectileId: number;
  /** Weapon type (uint8) */
  weaponType: number;
  /** Surface normal for bounce events (3 * float32) */
  surfaceNormal: THREE.Vector3;
  /** Target ID for hit events (uint16) */
  targetId: number;
  /** Whether peak position is recorded (uint8) */
  hasPeakPosition: boolean;
  /** Peak arc position (3 * float32, optional) */
  peakPosition: THREE.Vector3;
}

/**
 * Calculate the size of a ProjectileEvent in bytes.
 */
export function getProjectileEventSize(): number {
  return (
    1 + // eventType (uint8)
    4 + // timestamp (float32)
    12 + // position (3 * float32)
    12 + // velocity (3 * float32)
    2 + // projectileId (uint16)
    1 + // weaponType (uint8)
    12 + // surfaceNormal (3 * float32)
    2 + // targetId (uint16)
    1 + // hasPeakPosition (uint8)
    12 // peakPosition (3 * float32, always allocated)
  );
}

/**
 * Create a default ProjectileEvent with zero values.
 */
export function createDefaultProjectileEvent(): ProjectileEvent {
  return {
    eventType: ProjectileEventType.Fired,
    timestamp: 0,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    projectileId: 0,
    weaponType: 0,
    surfaceNormal: new THREE.Vector3(),
    targetId: 0,
    hasPeakPosition: false,
    peakPosition: new THREE.Vector3(),
  };
}
