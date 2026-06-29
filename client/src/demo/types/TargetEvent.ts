import * as THREE from 'three';

/**
 * Event types for target/ball recording.
 */
export enum TargetEventType {
  Spawned = 0,
  Bounce = 1,
  Hit = 2,
  Destroyed = 3,
  StateChanged = 4,
}

/**
 * Keyframe event for targets/balls.
 * Records position/velocity on critical events only.
 * Supports keyframe interpolation for perceptually perfect replay.
 */
export interface TargetEvent {
  /** Event type (uint8) */
  eventType: TargetEventType;
  /** Timestamp in seconds (float32) */
  timestamp: number;
  /** Target position (3 * float32) */
  position: THREE.Vector3;
  /** Target velocity (3 * float32) */
  velocity: THREE.Vector3;
  /** Target ID (uint16) */
  targetId: number;
  /** Target type (uint8) */
  targetType: number;
  /** Target health (float32) */
  health: number;
  /** Whether peak position is recorded (uint8) */
  hasPeakPosition: boolean;
  /** Peak arc position (3 * float32, optional) */
  peakPosition: THREE.Vector3;
}

/**
 * Calculate the size of a TargetEvent in bytes.
 */
export function getTargetEventSize(): number {
  return (
    1 + // eventType (uint8)
    4 + // timestamp (float32)
    12 + // position (3 * float32)
    12 + // velocity (3 * float32)
    2 + // targetId (uint16)
    1 + // targetType (uint8)
    4 + // health (float32)
    1 + // hasPeakPosition (uint8)
    12 // peakPosition (3 * float32, always allocated)
  );
}

/**
 * Create a default TargetEvent with zero values.
 */
export function createDefaultTargetEvent(): TargetEvent {
  return {
    eventType: TargetEventType.Spawned,
    timestamp: 0,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    targetId: 0,
    targetType: 0,
    health: 1.0,
    hasPeakPosition: false,
    peakPosition: new THREE.Vector3(),
  };
}
