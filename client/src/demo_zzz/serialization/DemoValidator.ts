import { DemoFile } from '../types/DemoFile.js';
import { DemoHeader } from '../types/DemoHeader.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';
import { CRC32 } from './CRC32.js';

/**
 * Validation result for demo files.
 */
export interface ValidationResult {
  /** Whether the demo is valid */
  isValid: boolean;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
}

/**
 * Validates demo files for integrity and correctness.
 */
export class DemoValidator {
  /**
   * Validate a demo file.
   * @param demo - Demo file to validate
   * @returns Validation result
   */
  static validate(demo: DemoFile): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate header
    DemoValidator.validateHeader(demo.header, errors, warnings);

    // Validate frames
    DemoValidator.validateFrames(demo.frames, errors, warnings);

    // Validate projectile events
    DemoValidator.validateProjectileEvents(demo.projectileEvents, errors, warnings);

    // Validate target events
    DemoValidator.validateTargetEvents(demo.targetEvents, errors, warnings);

    // Validate consistency
    DemoValidator.validateConsistency(demo, errors, warnings);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate demo header.
   */
  private static validateHeader(header: DemoHeader, errors: string[], warnings: string[]): void {
    // Check format version
    if (header.formatVersion <= 0) {
      errors.push('Invalid format version');
    }

    // Check duration
    if (header.duration < 0) {
      errors.push('Invalid duration (negative)');
    }

    if (header.duration > 3600) {
      warnings.push('Unusually long duration (> 1 hour)');
    }

    // Check frame count
    if (header.totalFrames < 0) {
      errors.push('Invalid frame count (negative)');
    }

    // Check event counts
    if (header.projectileEvents < 0) {
      errors.push('Invalid projectile event count (negative)');
    }

    if (header.targetEvents < 0) {
      errors.push('Invalid target event count (negative)');
    }

    // Check timestamp
    if (header.timestamp <= 0) {
      warnings.push('Invalid timestamp (zero or negative)');
    }

    // Check game version
    if (!header.gameVersion || header.gameVersion.length === 0) {
      warnings.push('Empty game version string');
    }
  }

  /**
   * Validate demo frames.
   */
  private static validateFrames(frames: DemoFrame[], errors: string[], warnings: string[]): void {
    if (frames.length === 0) {
      warnings.push('No frames in demo');
      return;
    }

    let lastTimestamp = 0;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];

      // Check frame number
      if (frame.frameNumber < 0 || frame.frameNumber > 65535) {
        errors.push(`Frame ${i}: Invalid frame number`);
      }

      // Check timestamp
      if (frame.timestamp < 0) {
        errors.push(`Frame ${i}: Invalid timestamp (negative)`);
      }

      // Check timestamp monotonicity
      if (frame.timestamp < lastTimestamp) {
        errors.push(`Frame ${i}: Timestamp not monotonic (${frame.timestamp} < ${lastTimestamp})`);
      }
      lastTimestamp = frame.timestamp;

      // Check position
      if (!DemoValidator.isValidVector3(frame.position)) {
        errors.push(`Frame ${i}: Invalid position (NaN/Infinity)`);
      }

      // Check velocity
      if (!DemoValidator.isValidVector3(frame.velocity)) {
        errors.push(`Frame ${i}: Invalid velocity (NaN/Infinity)`);
      }

      // Check rotation
      if (!DemoValidator.isValidQuaternion(frame.rotation)) {
        errors.push(`Frame ${i}: Invalid rotation (NaN/Infinity or not normalized)`);
      }

      // Check velocity magnitude (sanity check)
      const velocityMag = frame.velocity.length();
      if (velocityMag > 500) {
        warnings.push(`Frame ${i}: Unusually high velocity (${velocityMag.toFixed(2)} m/s)`);
      }
    }
  }

  /**
   * Validate projectile events.
   */
  private static validateProjectileEvents(events: ProjectileEvent[], errors: string[], warnings: string[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Check timestamp
      if (event.timestamp < 0) {
        errors.push(`Projectile event ${i}: Invalid timestamp (negative)`);
      }

      // Check position
      if (!DemoValidator.isValidVector3(event.position)) {
        errors.push(`Projectile event ${i}: Invalid position (NaN/Infinity)`);
      }

      // Check velocity
      if (!DemoValidator.isValidVector3(event.velocity)) {
        errors.push(`Projectile event ${i}: Invalid velocity (NaN/Infinity)`);
      }

      // Check surface normal
      if (!DemoValidator.isValidVector3(event.surfaceNormal)) {
        errors.push(`Projectile event ${i}: Invalid surface normal (NaN/Infinity)`);
      }

      // Check surface normal is normalized
      if (event.surfaceNormal.length() > 0 && Math.abs(event.surfaceNormal.length() - 1) > 0.01) {
        warnings.push(`Projectile event ${i}: Surface normal not normalized`);
      }

      // Check projectile ID
      if (event.projectileId < 0 || event.projectileId > 65535) {
        errors.push(`Projectile event ${i}: Invalid projectile ID`);
      }

      // Check velocity magnitude
      const velocityMag = event.velocity.length();
      if (velocityMag > 1000) {
        warnings.push(`Projectile event ${i}: Unusually high velocity (${velocityMag.toFixed(2)} m/s)`);
      }
    }
  }

  /**
   * Validate target events.
   */
  private static validateTargetEvents(events: TargetEvent[], errors: string[], warnings: string[]): void {
    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Check timestamp
      if (event.timestamp < 0) {
        errors.push(`Target event ${i}: Invalid timestamp (negative)`);
      }

      // Check position
      if (!DemoValidator.isValidVector3(event.position)) {
        errors.push(`Target event ${i}: Invalid position (NaN/Infinity)`);
      }

      // Check velocity
      if (!DemoValidator.isValidVector3(event.velocity)) {
        errors.push(`Target event ${i}: Invalid velocity (NaN/Infinity)`);
      }

      // Check target ID
      if (event.targetId < 0 || event.targetId > 65535) {
        errors.push(`Target event ${i}: Invalid target ID`);
      }

      // Check health
      if (event.health < 0 || event.health > 1000) {
        warnings.push(`Target event ${i}: Unusual health value (${event.health})`);
      }

      // Check velocity magnitude
      const velocityMag = event.velocity.length();
      if (velocityMag > 500) {
        warnings.push(`Target event ${i}: Unusually high velocity (${velocityMag.toFixed(2)} m/s)`);
      }
    }
  }

  /**
   * Validate consistency between header and data.
   */
  private static validateConsistency(demo: DemoFile, errors: string[], warnings: string[]): void {
    // Check frame count matches header
    if (demo.frames.length !== demo.header.totalFrames) {
      errors.push(`Frame count mismatch: header says ${demo.header.totalFrames}, actual ${demo.frames.length}`);
    }

    // Check projectile event count matches header
    if (demo.projectileEvents.length !== demo.header.projectileEvents) {
      errors.push(`Projectile event count mismatch: header says ${demo.header.projectileEvents}, actual ${demo.projectileEvents.length}`);
    }

    // Check target event count matches header
    if (demo.targetEvents.length !== demo.header.targetEvents) {
      errors.push(`Target event count mismatch: header says ${demo.header.targetEvents}, actual ${demo.targetEvents.length}`);
    }

    // Check duration matches last frame timestamp
    if (demo.frames.length > 0) {
      const lastFrame = demo.frames[demo.frames.length - 1];
      const durationDiff = Math.abs(lastFrame.timestamp - demo.header.duration);
      if (durationDiff > 1.0) {
        warnings.push(`Duration mismatch: header says ${demo.header.duration.toFixed(2)}s, last frame at ${lastFrame.timestamp.toFixed(2)}s`);
      }
    }
  }

  /**
   * Check if a Vector3 is valid (no NaN/Infinity).
   */
  private static isValidVector3(v: any): boolean {
    return (
      v &&
      typeof v.x === 'number' &&
      typeof v.y === 'number' &&
      typeof v.z === 'number' &&
      !isNaN(v.x) &&
      !isNaN(v.y) &&
      !isNaN(v.z) &&
      isFinite(v.x) &&
      isFinite(v.y) &&
      isFinite(v.z)
    );
  }

  /**
   * Check if a Quaternion is valid (no NaN/Infinity and normalized).
   */
  private static isValidQuaternion(q: any): boolean {
    return (
      q &&
      typeof q.x === 'number' &&
      typeof q.y === 'number' &&
      typeof q.z === 'number' &&
      typeof q.w === 'number' &&
      !isNaN(q.x) &&
      !isNaN(q.y) &&
      !isNaN(q.z) &&
      !isNaN(q.w) &&
      isFinite(q.x) &&
      isFinite(q.y) &&
      isFinite(q.z) &&
      isFinite(q.w) &&
      Math.abs(q.length() - 1) < 0.01
    );
  }

  /**
   * Validate a byte array as a demo file.
   * @param data - Byte array to validate
   * @returns Validation result
   */
  static validateBytes(data: Uint8Array): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check minimum size
    if (data.length < 64) {
      errors.push('File too small (less than header size)');
      return { isValid: false, errors, warnings };
    }

    // Check magic number
    const magic = data[0];
    if (magic !== 0x44) {
      errors.push(`Invalid magic number: ${magic} (expected 0x44)`);
    }

    // Read format version
    const view = new DataView(data.buffer);
    const formatVersion = view.getInt32(1, true);
    if (formatVersion <= 0) {
      errors.push(`Invalid format version: ${formatVersion}`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }
}
