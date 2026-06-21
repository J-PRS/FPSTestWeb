import type { ISystem } from './ISystem';
import { EventBus } from './EventBus';

/**
 * SystemManager - Centralized system lifecycle management
 * Handles initialization, updates, disposal, and dependency injection for all game systems
 */
export class SystemManager {
  private systems: Map<string, ISystem> = new Map();
  private updateOrder: string[] = [];
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * Register a system with the manager
   * @param name - Unique identifier for the system
   * @param system - System instance
   * @param updateOrder - Order in which this system should be updated (lower = earlier)
   */
  register(name: string, system: ISystem, updateOrder: number = 100): void {
    if (this.systems.has(name)) {
      throw new Error(`System "${name}" is already registered`);
    }

    this.systems.set(name, system);
    
    // Insert in update order
    let inserted = false;
    for (let i = 0; i < this.updateOrder.length; i++) {
      const existingName = this.updateOrder[i];
      const existingSystem = this.systems.get(existingName)!;
      const existingOrder = this.getUpdateOrder(existingName, existingSystem);
      
      if (updateOrder < existingOrder) {
        this.updateOrder.splice(i, 0, name);
        inserted = true;
        break;
      }
    }
    
    if (!inserted) {
      this.updateOrder.push(name);
    }
  }

  /**
   * Get a registered system by name
   */
  get<T extends ISystem>(name: string): T | undefined {
    return this.systems.get(name) as T;
  }

  /**
   * Check if a system is registered
   */
  has(name: string): boolean {
    return this.systems.has(name);
  }

  /**
   * Initialize all registered systems
   * Systems are initialized in the order they were registered
   */
  async initializeAll(): Promise<void> {
    for (const [name, system] of this.systems) {
      console.log(`Initializing system: ${name}`);
      await system.initialize();
    }
  }

  /**
   * Update all registered systems
   * Systems are updated in their defined update order
   */
  updateAll(dt: number): void {
    for (const name of this.updateOrder) {
      const system = this.systems.get(name);
      if (system) {
        try {
          system.update(dt);
        } catch (error) {
          console.error(`Error updating system "${name}":`, error);
        }
      }
    }
  }

  /**
   * Dispose all registered systems
   * Systems are disposed in reverse update order
   */
  disposeAll(): void {
    for (let i = this.updateOrder.length - 1; i >= 0; i--) {
      const name = this.updateOrder[i];
      const system = this.systems.get(name);
      if (system) {
        console.log(`Disposing system: ${name}`);
        try {
          system.dispose();
        } catch (error) {
          console.error(`Error disposing system "${name}":`, error);
        }
      }
    }
    this.systems.clear();
    this.updateOrder = [];
  }

  /**
   * Remove a specific system
   */
  remove(name: string): void {
    const system = this.systems.get(name);
    if (system) {
      system.dispose();
      this.systems.delete(name);
      this.updateOrder = this.updateOrder.filter(n => n !== name);
    }
  }

  /**
   * Get the number of registered systems
   */
  get count(): number {
    return this.systems.size;
  }

  /**
   * Get all registered system names
   */
  get names(): string[] {
    return Array.from(this.systems.keys());
  }

  /**
   * Helper to get update order from a system
   */
  private getUpdateOrder(name: string, system: ISystem): number {
    return system.updateOrder;
  }
}
