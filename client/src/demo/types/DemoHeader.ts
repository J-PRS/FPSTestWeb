import * as THREE from 'three';

/**
 * Demo file header with metadata.
 */
export interface DemoHeader {
  /** Demo format version (for compatibility) */
  formatVersion: number;
  /** Game version string */
  gameVersion: string;
  /** Total duration in seconds */
  duration: number;
  /** Total number of frames */
  totalFrames: number;
  /** Number of projectile events */
  projectileEvents: number;
  /** Number of target events */
  targetEvents: number;
  /** Player start position */
  playerStartPosition: THREE.Vector3;
  /** Player start rotation */
  playerStartRotation: THREE.Quaternion;
  /** Player start velocity */
  playerStartVelocity: THREE.Vector3;
  /** Optional description */
  description: string;
  /** CRC32 checksum for integrity */
  checksum: number;
  /** Unix timestamp when recorded */
  timestamp: number;
}

/**
 * Create a default DemoHeader with zero values.
 */
export function createDefaultDemoHeader(): DemoHeader {
  return {
    formatVersion: 1,
    gameVersion: '1.0.0',
    duration: 0,
    totalFrames: 0,
    projectileEvents: 0,
    targetEvents: 0,
    playerStartPosition: new THREE.Vector3(),
    playerStartRotation: new THREE.Quaternion(),
    playerStartVelocity: new THREE.Vector3(),
    description: '',
    checksum: 0,
    timestamp: Date.now(),
  };
}
