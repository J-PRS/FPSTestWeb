/**
 * Base interface for all game systems
 * Provides a common lifecycle pattern for initialization, updates, and cleanup
 */
export interface ISystem {
  /**
   * Update order for system execution (lower = earlier)
   * Used by SystemManager to determine update sequence
   */
  readonly updateOrder: number;

  /**
   * Initialize the system with any required dependencies
   * Called once during game initialization
   */
  initialize(): void | Promise<void>;

  /**
   * Update the system for the current frame
   * Called every frame with delta time in seconds
   */
  update(dt: number): void;

  /**
   * Clean up system resources
   * Called when the game is shutting down
   */
  dispose(): void;
}
