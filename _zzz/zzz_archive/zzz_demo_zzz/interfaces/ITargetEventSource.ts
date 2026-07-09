import * as THREE from 'three';

/**
 * Interface for recording target events.
 * Game systems call these methods to notify the demo recorder.
 */
export interface ITargetEventSource {
  /**
   * Record a target spawned event.
   * @param targetId - Target ID
   * @param position - Spawn position
   * @param velocity - Initial velocity
   * @param targetType - Type of target
   */
  recordTargetSpawned(
    targetId: number,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    targetType: number
  ): void;

  /**
   * Record a target bounce event.
   * @param targetId - Target ID
   * @param position - Bounce position
   * @param velocity - Velocity after bounce
   */
  recordTargetBounce(targetId: number, position: THREE.Vector3, velocity: THREE.Vector3): void;

  /**
   * Record a target hit event.
   * @param targetId - Target ID
   * @param position - Hit position
   * @param health - Health after hit
   */
  recordTargetHit(targetId: number, position: THREE.Vector3, health: number): void;

  /**
   * Record a target destroyed event.
   * @param targetId - Target ID
   * @param position - Final position
   */
  recordTargetDestroyed(targetId: number, position: THREE.Vector3): void;

  /**
   * Record a target state changed event.
   * @param targetId - Target ID
   * @param newState - New state value
   */
  recordTargetStateChanged(targetId: number, newState: number): void;

  /**
   * Record target peak position (velocity.y sign change).
   * Optional enhancement for precision.
   * @param targetId - Target ID
   * @param peakPosition - Peak arc position
   */
  recordTargetPeak(targetId: number, peakPosition: THREE.Vector3): void;
}
