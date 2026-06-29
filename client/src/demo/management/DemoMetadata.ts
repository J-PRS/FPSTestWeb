import { DemoFile } from '../types/DemoFile.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';
import { ProjectileEventType } from '../types/ProjectileEvent.js';

/**
 * Extended metadata for demo files.
 */
export interface DemoMetadata {
  /** Demo ID */
  id: string;
  /** Demo name */
  name: string;
  /** Recording timestamp */
  timestamp: number;
  /** Duration in seconds */
  duration: number;
  /** Format version */
  formatVersion: number;
  /** Game version */
  gameVersion: string;
  /** Description */
  description: string;
  /** File size in bytes */
  fileSize: number;

  // Gameplay metadata
  /** Number of players */
  playerCount: number;
  /** Map name (if available) */
  mapName: string;
  /** Game mode */
  gameMode: string;
  /** Server name (if available) */
  serverName: string;

  // Event statistics
  /** Total projectiles fired */
  projectilesFired: number;
  /** Total projectile hits */
  projectileHits: number;
  /** Total target spawns */
  targetSpawns: number;
  /** Total target hits */
  targetHits: number;
  /** Total target destroys */
  targetDestroys: number;

  // Calculated metrics
  /** Hit accuracy percentage */
  accuracy: number;
  /** Projectiles per second */
  projectilesPerSecond: number;
  /** Average time between shots */
  avgTimeBetweenShots: number;
}

/**
 * Extract metadata from demo files.
 * Useful for browsing and searching demos.
 */
export class DemoMetadata {
  /**
   * Extract metadata from a demo file.
   * @param demo - Demo file
   * @param id - Demo ID
   * @param name - Demo name
   * @param fileSize - File size in bytes
   * @returns Demo metadata
   */
  static extract(demo: DemoFile, id: string, name: string, fileSize: number): DemoMetadata {
    // Count events
    let projectilesFired = 0;
    let projectileHits = 0;
    let targetSpawns = 0;
    let targetHits = 0;
    let targetDestroys = 0;

    for (const event of demo.projectileEvents) {
      if (event.eventType === ProjectileEventType.Fired) {
        projectilesFired++;
      } else if (event.eventType === ProjectileEventType.Hit) {
        projectileHits++;
      }
    }

    for (const event of demo.targetEvents) {
      if (event.eventType === 0) { // Spawned
        targetSpawns++;
      } else if (event.eventType === 2) { // Hit
        targetHits++;
      } else if (event.eventType === 3) { // Destroyed
        targetDestroys++;
      }
    }

    // Calculate metrics
    const accuracy = projectilesFired > 0 ? (projectileHits / projectilesFired) * 100 : 0;
    const projectilesPerSecond = demo.header.duration > 0 ? projectilesFired / demo.header.duration : 0;
    const avgTimeBetweenShots = projectilesFired > 1 ? demo.header.duration / (projectilesFired - 1) : 0;

    // Extract map name from description if available
    const mapName = DemoMetadata.extractMapName(demo.header.description);

    return {
      id,
      name,
      timestamp: demo.header.timestamp,
      duration: demo.header.duration,
      formatVersion: demo.header.formatVersion,
      gameVersion: demo.header.gameVersion,
      description: demo.header.description,
      fileSize,

      // Gameplay metadata
      playerCount: 1, // TODO: Extract from demo if multiplayer
      mapName,
      gameMode: 'Deathmatch', // TODO: Extract from demo
      serverName: '', // TODO: Extract from demo

      // Event statistics
      projectilesFired,
      projectileHits,
      targetSpawns,
      targetHits,
      targetDestroys,

      // Calculated metrics
      accuracy,
      projectilesPerSecond,
      avgTimeBetweenShots,
    };
  }

  /**
   * Extract map name from description.
   * @param description - Demo description
   * @returns Map name or empty string
   */
  private static extractMapName(description: string): string {
    // Try to extract map name from description
    // Format: "Demo on MapName" or "MapName - Description"
    const mapMatch = description.match(/(?:on|at)\s+([A-Za-z0-9_]+)/i);
    if (mapMatch) {
      return mapMatch[1];
    }

    const dashMatch = description.match(/^([A-Za-z0-9_]+)\s*-/);
    if (dashMatch) {
      return dashMatch[1];
    }

    return '';
  }

  /**
   * Search demos by metadata criteria.
   * @param demos - Array of demo metadata
   * @param criteria - Search criteria
   * @returns Filtered demos
   */
  static search(demos: DemoMetadata[], criteria: Partial<DemoSearchCriteria>): DemoMetadata[] {
    return demos.filter((demo) => {
      if (criteria.mapName && demo.mapName !== criteria.mapName) {
        return false;
      }

      if (criteria.gameMode && demo.gameMode !== criteria.gameMode) {
        return false;
      }

      if (criteria.minDuration !== undefined && demo.duration < criteria.minDuration) {
        return false;
      }

      if (criteria.maxDuration !== undefined && demo.duration > criteria.maxDuration) {
        return false;
      }

      if (criteria.minAccuracy !== undefined && demo.accuracy < criteria.minAccuracy) {
        return false;
      }

      if (criteria.minProjectiles !== undefined && demo.projectilesFired < criteria.minProjectiles) {
        return false;
      }

      if (criteria.searchText) {
        const searchLower = criteria.searchText.toLowerCase();
        const text = `${demo.name} ${demo.description} ${demo.mapName}`.toLowerCase();
        if (!text.includes(searchLower)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Sort demos by metadata field.
   * @param demos - Array of demo metadata
   * @param field - Field to sort by
   * @param ascending - Sort order
   * @returns Sorted demos
   */
  static sort(demos: DemoMetadata[], field: keyof DemoMetadata, ascending: boolean = true): DemoMetadata[] {
    return [...demos].sort((a, b) => {
      const aVal = a[field];
      const bVal = b[field];

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return ascending ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return ascending ? aVal - bVal : bVal - aVal;
      }

      return 0;
    });
  }

  /**
   * Group demos by field.
   * @param demos - Array of demo metadata
   * @param field - Field to group by
   * @returns Grouped demos
   */
  static group(demos: DemoMetadata[], field: keyof DemoMetadata): Map<string, DemoMetadata[]> {
    const groups = new Map<string, DemoMetadata[]>();

    for (const demo of demos) {
      const key = String(demo[field]);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(demo);
    }

    return groups;
  }
}

/**
 * Search criteria for demo metadata.
 */
export interface DemoSearchCriteria {
  mapName?: string;
  gameMode?: string;
  minDuration?: number;
  maxDuration?: number;
  minAccuracy?: number;
  minProjectiles?: number;
  searchText?: string;
}
