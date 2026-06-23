/**
 * Ghost Manager - Object state synchronization with state masks
 * Based on Tribes 2 networking model
 * 
 * Manages "ghosts" (remote copies of objects) with partial state updates
 * Uses state mask system to send only changed data
 */

import { BitStream } from './BitStream.js';

// State mask bits - each bit represents a type of state
export enum StateMask {
  POSITION = 1 << 0,
  ROTATION = 1 << 1,
  VELOCITY = 1 << 2,
  ANIMATION = 1 << 3,
  HEALTH = 1 << 4,
  WEAPON = 1 << 5,
  FLAGS = 1 << 6,
}

export interface Ghost {
  id: number;
  stateMask: number;
  position?: { x: number; y: number; z: number };
  rotation?: { yaw: number; pitch: number };
  velocity?: { x: number; y: number; z: number };
  animation?: string;
  health?: number;
  weapon?: number;
  flags?: number;
  
  // Methods for packing/unpacking state
  packPosition(stream: BitStream): void;
  packRotation(stream: BitStream): void;
  packVelocity(stream: BitStream): void;
  packAnimation(stream: BitStream): void;
  packHealth(stream: BitStream): void;
  packWeapon(stream: BitStream): void;
  packFlags(stream: BitStream): void;
  
  unpackPosition(stream: BitStream): void;
  unpackRotation(stream: BitStream): void;
  unpackVelocity(stream: BitStream): void;
  unpackAnimation(stream: BitStream): void;
  unpackHealth(stream: BitStream): void;
  unpackWeapon(stream: BitStream): void;
  unpackFlags(stream: BitStream): void;
}

export class GhostManager {
  private ghosts: Map<number, Ghost> = new Map();
  private scopeManager: ScopeManager;

  constructor(scopeManager: ScopeManager) {
    this.scopeManager = scopeManager;
  }

  /**
   * Pack ghosts into a packet stream
   * Returns the number of ghosts packed
   */
  pack(stream: BitStream, maxBytes: number): number {
    const updateList = this.buildUpdateList();
    let packedCount = 0;

    for (const ghost of updateList) {
      // Check if we have space for at least ghost ID + state mask
      if (!stream.hasSpace(24)) break;

      const initialByteLength = stream.getByteLength();
      
      // Pack ghost ID
      stream.writeInt(ghost.id, 16);
      
      // Pack state mask
      stream.writeInt(ghost.stateMask, 8);
      
      // Pack only the states that changed
      if (ghost.stateMask & StateMask.POSITION) {
        ghost.packPosition(stream);
      }
      if (ghost.stateMask & StateMask.ROTATION) {
        ghost.packRotation(stream);
      }
      if (ghost.stateMask & StateMask.VELOCITY) {
        ghost.packVelocity(stream);
      }
      if (ghost.stateMask & StateMask.ANIMATION) {
        ghost.packAnimation(stream);
      }
      if (ghost.stateMask & StateMask.HEALTH) {
        ghost.packHealth(stream);
      }
      if (ghost.stateMask & StateMask.WEAPON) {
        ghost.packWeapon(stream);
      }
      if (ghost.stateMask & StateMask.FLAGS) {
        ghost.packFlags(stream);
      }
      
      // Check if we exceeded size limit
      if (stream.getByteLength() > maxBytes) {
        // Roll back this ghost
        stream.reset();
        stream.reset(); // Reset twice to clear buffer
        break;
      }
      
      // Clear state mask after packing
      ghost.stateMask = 0;
      packedCount++;
    }

    return packedCount;
  }

  /**
   * Unpack ghosts from a packet stream
   */
  unpack(stream: BitStream): void {
    while (stream.hasData()) {
      const id = stream.readInt(16);
      const stateMask = stream.readInt(8);
      
      let ghost = this.ghosts.get(id);
      
      if (!ghost) {
        // Create new ghost
        ghost = this.createGhost(id);
        this.ghosts.set(id, ghost);
      }
      
      // Unpack only the states that were sent
      if (stateMask & StateMask.POSITION) {
        ghost.unpackPosition(stream);
      }
      if (stateMask & StateMask.ROTATION) {
        ghost.unpackRotation(stream);
      }
      if (stateMask & StateMask.VELOCITY) {
        ghost.unpackVelocity(stream);
      }
      if (stateMask & StateMask.ANIMATION) {
        ghost.unpackAnimation(stream);
      }
      if (stateMask & StateMask.HEALTH) {
        ghost.unpackHealth(stream);
      }
      if (stateMask & StateMask.WEAPON) {
        ghost.unpackWeapon(stream);
      }
      if (stateMask & StateMask.FLAGS) {
        ghost.unpackFlags(stream);
      }
    }
  }

  /**
   * Build update list based on scoping and priority
   */
  private buildUpdateList(): Ghost[] {
    const inScope = this.scopeManager.getInScopeGhosts();

    // Sort by priority (status changes first, then by interest)
    return inScope.sort((a, b) => {
      // Priority 1: Ghosts with state changes
      if (a.stateMask !== 0 && b.stateMask === 0) return -1;
      if (a.stateMask === 0 && b.stateMask !== 0) return 1;

      // Priority 2: Health changes (critical for gameplay)
      const aHealthChanged = (a.stateMask & StateMask.HEALTH) !== 0;
      const bHealthChanged = (b.stateMask & StateMask.HEALTH) !== 0;
      if (aHealthChanged && !bHealthChanged) return -1;
      if (!aHealthChanged && bHealthChanged) return 1;

      // Priority 3: Position/velocity changes (movement)
      const aMovementChanged = (a.stateMask & (StateMask.POSITION | StateMask.VELOCITY)) !== 0;
      const bMovementChanged = (b.stateMask & (StateMask.POSITION | StateMask.VELOCITY)) !== 0;
      if (aMovementChanged && !bMovementChanged) return -1;
      if (!aMovementChanged && bMovementChanged) return 1;

      // Priority 4: Lower ID first (stable ordering)
      return a.id - b.id;
    });
  }

  /**
   * Create a new ghost (should be overridden with actual ghost type)
   */
  private createGhost(id: number): Ghost {
    // Default implementation - should be overridden
    return {
      id,
      stateMask: 0,
      packPosition: (stream: BitStream) => {},
      packRotation: (stream: BitStream) => {},
      packVelocity: (stream: BitStream) => {},
      packAnimation: (stream: BitStream) => {},
      packHealth: (stream: BitStream) => {},
      packWeapon: (stream: BitStream) => {},
      packFlags: (stream: BitStream) => {},
      unpackPosition: (stream: BitStream) => {},
      unpackRotation: (stream: BitStream) => {},
      unpackVelocity: (stream: BitStream) => {},
      unpackAnimation: (stream: BitStream) => {},
      unpackHealth: (stream: BitStream) => {},
      unpackWeapon: (stream: BitStream) => {},
      unpackFlags: (stream: BitStream) => {},
    };
  }

  /**
   * Remove a ghost
   */
  removeGhost(id: number): void {
    this.ghosts.delete(id);
  }

  /**
   * Get a ghost by ID
   */
  getGhost(id: number): Ghost | undefined {
    return this.ghosts.get(id);
  }

  /**
   * Get all ghosts
   */
  getAllGhosts(): Ghost[] {
    return Array.from(this.ghosts.values());
  }

  /**
   * Clear all ghosts
   */
  clear(): void {
    this.ghosts.clear();
  }
}

/**
 * Scope Manager - Determines which objects are relevant to a client
 */
export class ScopeManager {
  private playerPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private viewDistance: number = 500;

  /**
   * Update player position for scoping
   */
  updatePlayerPosition(position: { x: number; y: number; z: number }): void {
    this.playerPosition = position;
  }

  /**
   * Get ghosts in scope
   */
  getInScopeGhosts(): Ghost[] {
    // For now, return all ghosts
    // In production, this would query a spatial database
    return [];
  }

  /**
   * Calculate priority for a ghost
   */
  calculatePriority(ghost: Ghost): number {
    let priority = 0;
    
    // Distance factor (closer = higher priority)
    if (ghost.position) {
      const distance = this.calculateDistance(this.playerPosition, ghost.position);
      priority += Math.max(0, 100 - distance);
    }
    
    // Interest modifiers
    if (ghost.stateMask & StateMask.HEALTH) priority += 20;
    if (ghost.stateMask & StateMask.WEAPON) priority += 10;
    
    return priority;
  }

  /**
   * Calculate distance between two positions
   */
  private calculateDistance(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number }
  ): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Set view distance
   */
  setViewDistance(distance: number): void {
    this.viewDistance = distance;
  }
}
