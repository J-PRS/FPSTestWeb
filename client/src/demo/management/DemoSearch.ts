import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';

/**
 * Search result for demo content.
 */
export interface SearchResult {
  /** Result type */
  type: 'frame' | 'projectile' | 'target';
  /** Timestamp */
  timestamp: number;
  /** Index in array */
  index: number;
  /** Match score (0-1) */
  score: number;
  /** Match details */
  details: string;
}

/**
 * Search criteria for demo content.
 */
export interface SearchCriteria {
  /** Time range */
  startTime?: number;
  endTime?: number;
  /** Position range */
  positionMin?: { x: number; y: number; z: number };
  positionMax?: { x: number; y: number; z: number };
  /** Velocity range */
  velocityMin?: number;
  velocityMax?: number;
  /** Event type */
  eventType?: string;
  /** Text search (in description) */
  textQuery?: string;
}

/**
 * Demo content search.
 * Search for specific moments and events in demo files.
 */
export class DemoSearch {
  /**
   * Search a demo file by criteria.
   * @param demo - Demo file to search
   * @param criteria - Search criteria
   * @returns Array of search results
   */
  static search(demo: DemoFile, criteria: SearchCriteria): SearchResult[] {
    const results: SearchResult[] = [];

    // Search frames
    if (!criteria.eventType || criteria.eventType === 'frame') {
      const frameResults = DemoSearch.searchFrames(demo.frames, criteria);
      results.push(...frameResults);
    }

    // Search projectile events
    if (!criteria.eventType || criteria.eventType === 'projectile') {
      const projectileResults = DemoSearch.searchProjectileEvents(
        demo.projectileEvents,
        criteria
      );
      results.push(...projectileResults);
    }

    // Search target events
    if (!criteria.eventType || criteria.eventType === 'target') {
      const targetResults = DemoSearch.searchTargetEvents(demo.targetEvents, criteria);
      results.push(...targetResults);
    }

    // Sort by score (descending)
    results.sort((a, b) => b.score - a.score);

    return results;
  }

  /**
   * Search frames by criteria.
   */
  private static searchFrames(frames: DemoFrame[], criteria: SearchCriteria): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      let score = 0;
      const details: string[] = [];

      // Time range
      if (criteria.startTime !== undefined && frame.timestamp < criteria.startTime) {
        continue;
      }
      if (criteria.endTime !== undefined && frame.timestamp > criteria.endTime) {
        continue;
      }

      // Position range
      if (criteria.positionMin && criteria.positionMax) {
        const inRange =
          frame.position.x >= criteria.positionMin.x &&
          frame.position.x <= criteria.positionMax.x &&
          frame.position.y >= criteria.positionMin.y &&
          frame.position.y <= criteria.positionMax.y &&
          frame.position.z >= criteria.positionMin.z &&
          frame.position.z <= criteria.positionMax.z;

        if (inRange) {
          score += 0.5;
          details.push('position in range');
        }
      }

      // Velocity range
      if (criteria.velocityMin !== undefined || criteria.velocityMax !== undefined) {
        const velocity = frame.velocity.length();
        if (criteria.velocityMin !== undefined && velocity < criteria.velocityMin) {
          continue;
        }
        if (criteria.velocityMax !== undefined && velocity > criteria.velocityMax) {
          continue;
        }
        score += 0.3;
        details.push(`velocity: ${velocity.toFixed(1)}`);
      }

      if (score > 0) {
        results.push({
          type: 'frame',
          timestamp: frame.timestamp,
          index: i,
          score,
          details: details.join(', '),
        });
      }
    }

    return results;
  }

  /**
   * Search projectile events by criteria.
   */
  private static searchProjectileEvents(
    events: ProjectileEvent[],
    criteria: SearchCriteria
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      let score = 0;
      const details: string[] = [];

      // Time range
      if (criteria.startTime !== undefined && event.timestamp < criteria.startTime) {
        continue;
      }
      if (criteria.endTime !== undefined && event.timestamp > criteria.endTime) {
        continue;
      }

      // Position range
      if (criteria.positionMin && criteria.positionMax) {
        const inRange =
          event.position.x >= criteria.positionMin.x &&
          event.position.x <= criteria.positionMax.x &&
          event.position.y >= criteria.positionMin.y &&
          event.position.y <= criteria.positionMax.y &&
          event.position.z >= criteria.positionMin.z &&
          event.position.z <= criteria.positionMax.z;

        if (inRange) {
          score += 0.5;
          details.push('position in range');
        }
      }

      // Velocity range
      if (criteria.velocityMin !== undefined || criteria.velocityMax !== undefined) {
        const velocity = event.velocity.length();
        if (criteria.velocityMin !== undefined && velocity < criteria.velocityMin) {
          continue;
        }
        if (criteria.velocityMax !== undefined && velocity > criteria.velocityMax) {
          continue;
        }
        score += 0.3;
        details.push(`velocity: ${velocity.toFixed(1)}`);
      }

      // Event type
      if (criteria.eventType && criteria.eventType !== 'projectile') {
        if (event.eventType.toString() !== criteria.eventType) {
          continue;
        }
        score += 0.2;
        details.push(`type: ${event.eventType}`);
      }

      if (score > 0) {
        results.push({
          type: 'projectile',
          timestamp: event.timestamp,
          index: i,
          score,
          details: details.join(', '),
        });
      }
    }

    return results;
  }

  /**
   * Search target events by criteria.
   */
  private static searchTargetEvents(events: TargetEvent[], criteria: SearchCriteria): SearchResult[] {
    const results: SearchResult[] = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      let score = 0;
      const details: string[] = [];

      // Time range
      if (criteria.startTime !== undefined && event.timestamp < criteria.startTime) {
        continue;
      }
      if (criteria.endTime !== undefined && event.timestamp > criteria.endTime) {
        continue;
      }

      // Position range
      if (criteria.positionMin && criteria.positionMax) {
        const inRange =
          event.position.x >= criteria.positionMin.x &&
          event.position.x <= criteria.positionMax.x &&
          event.position.y >= criteria.positionMin.y &&
          event.position.y <= criteria.positionMax.y &&
          event.position.z >= criteria.positionMin.z &&
          event.position.z <= criteria.positionMax.z;

        if (inRange) {
          score += 0.5;
          details.push('position in range');
        }
      }

      // Velocity range
      if (criteria.velocityMin !== undefined || criteria.velocityMax !== undefined) {
        const velocity = event.velocity.length();
        if (criteria.velocityMin !== undefined && velocity < criteria.velocityMin) {
          continue;
        }
        if (criteria.velocityMax !== undefined && velocity > criteria.velocityMax) {
          continue;
        }
        score += 0.3;
        details.push(`velocity: ${velocity.toFixed(1)}`);
      }

      // Event type
      if (criteria.eventType && criteria.eventType !== 'target') {
        if (event.eventType.toString() !== criteria.eventType) {
          continue;
        }
        score += 0.2;
        details.push(`type: ${event.eventType}`);
      }

      if (score > 0) {
        results.push({
          type: 'target',
          timestamp: event.timestamp,
          index: i,
          score,
          details: details.join(', '),
        });
      }
    }

    return results;
  }

  /**
   * Find moments with high activity.
   * @param demo - Demo file
   * @param windowSize - Time window in seconds
   * @param threshold - Minimum event count to be considered high activity
   * @returns Array of timestamps with high activity
   */
  static findHighActivityMoments(
    demo: DemoFile,
    windowSize: number = 1.0,
    threshold: number = 5
  ): number[] {
    const moments: number[] = [];
    const allEvents = [
      ...demo.projectileEvents.map((e) => ({ timestamp: e.timestamp, type: 'projectile' })),
      ...demo.targetEvents.map((e) => ({ timestamp: e.timestamp, type: 'target' })),
    ];

    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < allEvents.length; i++) {
      const start = allEvents[i].timestamp;
      const end = start + windowSize;

      const count = allEvents.filter((e) => e.timestamp >= start && e.timestamp <= end).length;

      if (count >= threshold) {
        moments.push(start);
      }
    }

    return [...new Set(moments)].sort((a, b) => a - b);
  }

  /**
   * Find moments with high velocity.
   * @param demo - Demo file
   * @param threshold - Velocity threshold
   * @returns Array of timestamps with high velocity
   */
  static findHighVelocityMoments(demo: DemoFile, threshold: number = 50): number[] {
    const moments: number[] = [];

    for (const frame of demo.frames) {
      const velocity = frame.velocity.length();
      if (velocity >= threshold) {
        moments.push(frame.timestamp);
      }
    }

    return [...new Set(moments)].sort((a, b) => a - b);
  }
}
