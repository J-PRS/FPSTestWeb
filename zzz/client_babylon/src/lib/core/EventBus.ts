/**
 * EventBus - Decoupled system communication
 * Systems can publish events and subscribe to events without direct dependencies
 */
export type EventCallback<T = any> = (data: T) => void;

export class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  /**
   * Subscribe to an event
   * @param event - Event name to listen for
   * @param callback - Function to call when event is published
   * @returns Unsubscribe function
   */
  on<T = any>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(event);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }

  /**
   * Subscribe to an event (alias for on)
   */
  subscribe<T = any>(event: string, callback: EventCallback<T>): () => void {
    return this.on(event, callback);
  }

  /**
   * Publish an event to all subscribers
   * @param event - Event name to publish
   * @param data - Data to pass to subscribers
   */
  emit<T = any>(event: string, data?: T): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event callback for "${event}":`, error);
        }
      });
    }
  }

  /**
   * Publish an event (alias for emit)
   */
  publish<T = any>(event: string, data?: T): void {
    this.emit(event, data);
  }

  /**
   * Remove all listeners for an event
   */
  off(event: string): void {
    this.listeners.delete(event);
  }

  /**
   * Remove all listeners for all events
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size || 0;
  }
}

// Global event bus instance
export const eventBus = new EventBus();

// Common game events
export const GameEvents = {
  // Player events
  PLAYER_MOVED: 'player:moved',
  PLAYER_JUMPED: 'player:jumped',
  PLAYER_JETPACK: 'player:jetpack',
  PLAYER_DIED: 'player:died',
  PLAYER_INPUT: 'player:input',

  // Weapon events
  WEAPON_FIRED: 'weapon:fired',
  WEAPON_HIT: 'weapon:hit',
  WEAPON_RELOAD: 'weapon:reload',

  // Enemy events
  ENEMY_SPAWNED: 'enemy:spawned',
  ENEMY_DIED: 'enemy:died',
  ENEMY_HIT: 'enemy:hit',

  // VFX events
  VFX_SPAWN: 'vfx:spawn',
  VFX_EXPLOSION: 'vfx:explosion',

  // Game state events
  GAME_STARTED: 'game:started',
  GAME_PAUSED: 'game:paused',
  GAME_RESUMED: 'game:resumed',
  GAME_ENDED: 'game:ended',
} as const;
