/**
 * Scope Manager - Relevance filtering for GhostManager
 * Based on Tribes 2 networking model
 * 
 * Manages scoping system for relevance filtering
 * Prioritizes objects based on distance/interest
 * Optimizes bandwidth by sending only relevant updates
 */

export class ScopeManager {
  private viewDistance: number = 1000; // Default view distance in meters
  private priorityThresholds: Map<string, number> = new Map();

  constructor(viewDistance: number = 1000) {
    this.viewDistance = viewDistance;
  }

  /**
   * Check if a ghost is in scope for a connection
   */
  isInScope(connectionId: string, ghostId: number, position: { x: number; y: number; z: number }, viewerPosition: { x: number; y: number; z: number }): boolean {
    const distance = this.calculateDistance(position, viewerPosition);
    return distance <= this.viewDistance;
  }

  /**
   * Calculate priority for a ghost update
   * Higher priority = should be sent sooner
   */
  calculatePriority(ghostId: number, position: { x: number; y: number; z: number }, viewerPosition: { x: number; y: number; z: number }): number {
    const distance = this.calculateDistance(position, viewerPosition);
    
    // Closer objects have higher priority
    // Priority = 1.0 (highest) at distance 0
    // Priority = 0.0 (lowest) at viewDistance
    const priority = Math.max(0, 1 - (distance / this.viewDistance));
    
    return priority;
  }

  /**
   * Set view distance for scoping
   */
  setViewDistance(distance: number): void {
    this.viewDistance = distance;
  }

  /**
   * Get current view distance
   */
  getViewDistance(): number {
    return this.viewDistance;
  }

  /**
   * Calculate distance between two positions
   */
  private calculateDistance(pos1: { x: number; y: number; z: number }, pos2: { x: number; y: number; z: number }): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Filter ghosts by priority threshold
   */
  filterByPriority(ghosts: Array<{ id: number; position: { x: number; y: number; z: number } }>, viewerPosition: { x: number; y: number; z: number }, minPriority: number = 0.5): Array<{ id: number; position: { x: number; y: number; z: number } }> {
    return ghosts.filter(ghost => {
      const priority = this.calculatePriority(ghost.id, ghost.position, viewerPosition);
      return priority >= minPriority;
    });
  }

  /**
   * Sort ghosts by priority (highest first)
   */
  sortByPriority(ghosts: Array<{ id: number; position: { x: number; y: number; z: number } }>, viewerPosition: { x: number; y: number; z: number }): Array<{ id: number; position: { x: number; y: number; z: number } }> {
    return [...ghosts].sort((a, b) => {
      const priorityA = this.calculatePriority(a.id, a.position, viewerPosition);
      const priorityB = this.calculatePriority(b.id, b.position, viewerPosition);
      return priorityB - priorityA; // Descending order
    });
  }
}
