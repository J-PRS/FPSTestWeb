import * as THREE from 'three';

/**
 * Single frame of player data for demo recording.
 * ~32 bytes per frame for efficient recording.
 */
export interface DemoFrame {
  /** Frame number (uint16) */
  frameNumber: number;
  /** Timestamp in seconds (float32) */
  timestamp: number;
  /** Player position (3 * float32) */
  position: THREE.Vector3;
  /** Player velocity (3 * float32) */
  velocity: THREE.Vector3;
  /** Player rotation (4 * float32) */
  rotation: THREE.Quaternion;
  /** Input flags as bitmask (uint8) */
  inputFlags: number;
  /** Mouse delta X (int16) */
  mouseDeltaX: number;
  /** Mouse delta Y (int16) */
  mouseDeltaY: number;
  /** Jetpack flags as bitmask (uint8) */
  jetpackFlags: number;
  /** Jetpack fuel level (float32) */
  jetpackFuel: number;
}

/**
 * Calculate the size of a DemoFrame in bytes.
 */
export function getDemoFrameSize(): number {
  return (
    2 + // frameNumber (uint16)
    4 + // timestamp (float32)
    12 + // position (3 * float32)
    12 + // velocity (3 * float32)
    16 + // rotation (4 * float32)
    1 + // inputFlags (uint8)
    2 + // mouseDeltaX (int16)
    2 + // mouseDeltaY (int16)
    1 + // jetpackFlags (uint8)
    4 // jetpackFuel (float32)
  );
}

/**
 * Create a default DemoFrame with zero values.
 */
export function createDefaultDemoFrame(): DemoFrame {
  return {
    frameNumber: 0,
    timestamp: 0,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    inputFlags: 0,
    mouseDeltaX: 0,
    mouseDeltaY: 0,
    jetpackFlags: 0,
    jetpackFuel: 0,
  };
}
