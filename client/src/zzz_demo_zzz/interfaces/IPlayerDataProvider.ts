import * as THREE from 'three';

/**
 * Interface for providing player state data to the demo recorder.
 * Game systems implement this to feed data without direct coupling.
 */
export interface IPlayerDataProvider {
  /**
   * Current player position.
   */
  readonly position: THREE.Vector3;

  /**
   * Current player velocity.
   */
  readonly velocity: THREE.Vector3;

  /**
   * Current player rotation.
   */
  readonly rotation: THREE.Quaternion;
}
