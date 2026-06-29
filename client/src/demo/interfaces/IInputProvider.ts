/**
 * Interface for providing input state data to the demo recorder.
 * Game systems implement this to feed input data without direct coupling.
 */
export interface IInputProvider {
  /**
   * Current input flags as bitmask.
   */
  readonly inputFlags: number;

  /**
   * Current mouse delta X.
   */
  readonly mouseDeltaX: number;

  /**
   * Current mouse delta Y.
   */
  readonly mouseDeltaY: number;

  /**
   * Current jetpack flags as bitmask.
   */
  readonly jetpackFlags: number;

  /**
   * Current jetpack fuel level.
   */
  readonly jetpackFuel: number;
}
