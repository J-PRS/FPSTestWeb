import * as THREE from 'three';
import { DemoHeader, createDefaultDemoHeader } from './DemoHeader.js';
import { DemoFrame } from './DemoFrame.js';
import { ProjectileEvent } from './ProjectileEvent.js';
import { TargetEvent } from './TargetEvent.js';

/**
 * Complete demo file structure.
 */
export interface DemoFile {
  /** File header with metadata */
  header: DemoHeader;
  /** Array of player frames */
  frames: DemoFrame[];
  /** Array of projectile events */
  projectileEvents: ProjectileEvent[];
  /** Array of target events */
  targetEvents: TargetEvent[];
  /** Initial player position for replay */
  playerStartPosition: THREE.Vector3;
  /** Initial player rotation for replay */
  playerStartRotation: THREE.Quaternion;
  /** Initial player velocity for replay */
  playerStartVelocity: THREE.Vector3;
}

/**
 * Create a default DemoFile with empty arrays.
 */
export function createDefaultDemoFile(): DemoFile {
  return {
    header: createDefaultDemoHeader(),
    frames: [],
    projectileEvents: [],
    targetEvents: [],
    playerStartPosition: new THREE.Vector3(),
    playerStartRotation: new THREE.Quaternion(),
    playerStartVelocity: new THREE.Vector3(),
  };
}

/**
 * Calculate the estimated file size for a DemoFile.
 */
export function estimateDemoFileSize(demo: DemoFile): number {
  let size = 0;

  // Header (estimated)
  size += 64;

  // Initial state
  size += 12 + 16 + 12; // position + rotation + velocity

  // Frames
  size += demo.frames.length * 32; // 32 bytes per frame

  // Projectile events
  size += demo.projectileEvents.length * 48; // 48 bytes per event

  // Target events
  size += demo.targetEvents.length * 40; // 40 bytes per event

  return size;
}
