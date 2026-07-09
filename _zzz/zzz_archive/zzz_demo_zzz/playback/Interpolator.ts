import * as THREE from 'three';

/**
 * Interpolation modes for keyframe replay.
 */
export enum InterpolationMode {
  /**
   * Linear interpolation between keyframes.
   * Fastest, but may look jerky for curved paths.
   */
  Linear,

  /**
   * Parabolic interpolation for gravity-affected objects.
   * Accounts for constant acceleration (gravity).
   */
  Parabolic,

  /**
   * Spline interpolation for smooth curves.
   * Slowest, but produces smoothest motion.
   */
  Spline,
}

/**
 * Interpolation result with position and rotation.
 */
export interface InterpolationResult {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  velocity: THREE.Vector3;
}

/**
 * Keyframe for interpolation.
 */
export interface Keyframe {
  timestamp: number;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  velocity: THREE.Vector3;
}

/**
 * Interpolator for smooth keyframe replay.
 * Supports linear, parabolic, and spline interpolation.
 */
export class Interpolator {
  /**
   * Interpolate between two keyframes at a given time.
   * @param keyframes - Array of keyframes
   * @param time - Target time to interpolate to
   * @param mode - Interpolation mode
   * @param gravity - Gravity constant for parabolic interpolation
   * @returns Interpolated result
   */
  static interpolate(
    keyframes: Keyframe[],
    time: number,
    mode: InterpolationMode = InterpolationMode.Linear,
    gravity: number = -20.0
  ): InterpolationResult | null {
    if (keyframes.length === 0) {
      return null;
    }

    if (keyframes.length === 1) {
      return {
        position: keyframes[0].position.clone(),
        rotation: keyframes[0].rotation.clone(),
        velocity: keyframes[0].velocity.clone(),
      };
    }

    // Find surrounding keyframes
    let prevIndex = 0;
    let nextIndex = keyframes.length - 1;

    for (let i = 0; i < keyframes.length - 1; i++) {
      if (time >= keyframes[i].timestamp && time <= keyframes[i + 1].timestamp) {
        prevIndex = i;
        nextIndex = i + 1;
        break;
      }
    }

    const prev = keyframes[prevIndex];
    const next = keyframes[nextIndex];

    // Calculate interpolation factor (0-1)
    const duration = next.timestamp - prev.timestamp;
    const t = duration > 0 ? (time - prev.timestamp) / duration : 0;

    switch (mode) {
      case InterpolationMode.Linear:
        return Interpolator.linearInterpolate(prev, next, t);
      case InterpolationMode.Parabolic:
        return Interpolator.parabolicInterpolate(prev, next, t, duration, gravity);
      case InterpolationMode.Spline:
        return Interpolator.splineInterpolate(keyframes, prevIndex, nextIndex, t);
      default:
        return Interpolator.linearInterpolate(prev, next, t);
    }
  }

  /**
   * Linear interpolation between two keyframes.
   */
  private static linearInterpolate(
    prev: Keyframe,
    next: Keyframe,
    t: number
  ): InterpolationResult {
    const position = new THREE.Vector3().lerpVectors(prev.position, next.position, t);
    const rotation = new THREE.Quaternion().slerpQuaternions(prev.rotation, next.rotation, t);
    const velocity = new THREE.Vector3().lerpVectors(prev.velocity, next.velocity, t);

    return { position, rotation, velocity };
  }

  /**
   * Parabolic interpolation for gravity-affected objects.
   * Accounts for constant acceleration (gravity).
   */
  private static parabolicInterpolate(
    prev: Keyframe,
    next: Keyframe,
    t: number,
    duration: number,
    gravity: number
  ): InterpolationResult {
    // Linear interpolation for position
    const position = new THREE.Vector3().lerpVectors(prev.position, next.position, t);

    // Add parabolic arc for Y component (gravity)
    const arcHeight = (gravity * duration * duration) / 4;
    const arc = 4 * t * (1 - t);
    position.y += arcHeight * arc;

    // Linear interpolation for rotation
    const rotation = new THREE.Quaternion().slerpQuaternions(prev.rotation, next.rotation, t);

    // Linear interpolation for velocity
    const velocity = new THREE.Vector3().lerpVectors(prev.velocity, next.velocity, t);

    // Add gravity to velocity
    velocity.y += gravity * duration * t;

    return { position, rotation, velocity };
  }

  /**
   * Spline interpolation for smooth curves.
   * Uses Catmull-Rom spline for smooth motion.
   */
  private static splineInterpolate(
    keyframes: Keyframe[],
    prevIndex: number,
    nextIndex: number,
    t: number
  ): InterpolationResult {
    // Get control points for Catmull-Rom spline
    const p0 = keyframes[Math.max(0, prevIndex - 1)];
    const p1 = keyframes[prevIndex];
    const p2 = keyframes[nextIndex];
    const p3 = keyframes[Math.min(keyframes.length - 1, nextIndex + 1)];

    // Catmull-Rom spline interpolation
    const position = Interpolator.catmullRom(p0.position, p1.position, p2.position, p3.position, t);
    const rotation = new THREE.Quaternion().slerpQuaternions(p1.rotation, p2.rotation, t);
    const velocity = Interpolator.catmullRomDerivative(p0.position, p1.position, p2.position, p3.position, t);

    return { position, rotation, velocity };
  }

  /**
   * Catmull-Rom spline interpolation.
   */
  private static catmullRom(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t: number
  ): THREE.Vector3 {
    const t2 = t * t;
    const t3 = t2 * t;

    const result = new THREE.Vector3();

    result.x = 0.5 * (
      (2 * p1.x) +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    );

    result.y = 0.5 * (
      (2 * p1.y) +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    );

    result.z = 0.5 * (
      (2 * p1.z) +
      (-p0.z + p2.z) * t +
      (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
      (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3
    );

    return result;
  }

  /**
   * Catmull-Rom spline derivative (for velocity).
   */
  private static catmullRomDerivative(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    p2: THREE.Vector3,
    p3: THREE.Vector3,
    t: number
  ): THREE.Vector3 {
    const t2 = t * t;

    const result = new THREE.Vector3();

    result.x = 0.5 * (
      (-p0.x + p2.x) +
      (4 * p0.x - 10 * p1.x + 8 * p2.x - 2 * p3.x) * t +
      (-3 * p0.x + 9 * p1.x - 9 * p2.x + 3 * p3.x) * t2
    );

    result.y = 0.5 * (
      (-p0.y + p2.y) +
      (4 * p0.y - 10 * p1.y + 8 * p2.y - 2 * p3.y) * t +
      (-3 * p0.y + 9 * p1.y - 9 * p2.y + 3 * p3.y) * t2
    );

    result.z = 0.5 * (
      (-p0.z + p2.z) +
      (4 * p0.z - 10 * p1.z + 8 * p2.z - 2 * p3.z) * t +
      (-3 * p0.z + 9 * p1.z - 9 * p2.z + 3 * p3.z) * t2
    );

    return result;
  }

  /**
   * Extrapolate beyond the last keyframe.
   * Uses velocity to predict future position.
   * @param lastKeyframe - Last known keyframe
   * @param time - Target time (must be > lastKeyframe.timestamp)
   * @param maxExtrapolationTime - Maximum time to extrapolate (default: 0.5s)
   * @returns Extrapolated result
   */
  static extrapolate(
    lastKeyframe: Keyframe,
    time: number,
    maxExtrapolationTime: number = 0.5
  ): InterpolationResult {
    const deltaTime = Math.min(time - lastKeyframe.timestamp, maxExtrapolationTime);

    const position = lastKeyframe.position.clone().add(
      lastKeyframe.velocity.clone().multiplyScalar(deltaTime)
    );

    // Add gravity to position
    position.y += 0.5 * -20.0 * deltaTime * deltaTime;

    const rotation = lastKeyframe.rotation.clone();
    const velocity = lastKeyframe.velocity.clone();
    velocity.y += -20.0 * deltaTime;

    return { position, rotation, velocity };
  }

  /**
   * Create keyframes from demo frames.
   * @param frames - Demo frames
   * @returns Array of keyframes
   */
  static framesToKeyframes(frames: import('../types/DemoFrame.js').DemoFrame[]): Keyframe[] {
    return frames.map((frame) => ({
      timestamp: frame.timestamp,
      position: frame.position.clone(),
      rotation: frame.rotation.clone(),
      velocity: frame.velocity.clone(),
    }));
  }
}
