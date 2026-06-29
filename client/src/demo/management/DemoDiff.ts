import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';

/**
 * Difference between two demo files.
 */
export interface DemoDiff {
  /** Header differences */
  headerDiff: HeaderDiff;
  /** Frame differences */
  frameDiffs: FrameDiff[];
  /** Projectile event differences */
  projectileEventDiffs: EventDiff[];
  /** Target event differences */
  targetEventDiffs: EventDiff[];
  /** Summary statistics */
  summary: DiffSummary;
}

/**
 * Header differences.
 */
export interface HeaderDiff {
  /** Format version changed */
  formatVersionChanged: boolean;
  /** Game version changed */
  gameVersionChanged: boolean;
  /** Duration difference */
  durationDiff: number;
  /** Frame count difference */
  frameCountDiff: number;
  /** Projectile event count difference */
  projectileEventCountDiff: number;
  /** Target event count difference */
  targetEventCountDiff: number;
}

/**
 * Frame difference.
 */
export interface FrameDiff {
  /** Frame index */
  frameIndex: number;
  /** Timestamp difference */
  timestampDiff: number;
  /** Position difference */
  positionDiff: number;
  /** Velocity difference */
  velocityDiff: number;
  /** Rotation difference */
  rotationDiff: number;
}

/**
 * Event difference.
 */
export interface EventDiff {
  /** Event index */
  eventIndex: number;
  /** Event type */
  eventType: string;
  /** Timestamp difference */
  timestampDiff: number;
  /** Position difference */
  positionDiff: number;
  /** Velocity difference */
  velocityDiff: number;
}

/**
 * Diff summary.
 */
export interface DiffSummary {
  /** Total differences */
  totalDifferences: number;
  /** Percentage different */
  percentDifferent: number;
  /** Significant differences */
  significantDifferences: string[];
}

/**
 * Demo comparison and diff tool.
 * Compares two demo files and highlights differences.
 */
export class DemoDiff {
  /**
   * Compare two demo files.
   * @param demo1 - First demo file
   * @param demo2 - Second demo file
   * @returns Diff result
   */
  static compare(demo1: DemoFile, demo2: DemoFile): DemoDiff {
    const headerDiff = DemoDiff.compareHeaders(demo1.header, demo2.header);
    const frameDiffs = DemoDiff.compareFrames(demo1.frames, demo2.frames);
    const projectileEventDiffs = DemoDiff.compareProjectileEvents(
      demo1.projectileEvents,
      demo2.projectileEvents
    );
    const targetEventDiffs = DemoDiff.compareTargetEvents(demo1.targetEvents, demo2.targetEvents);
    const summary = DemoDiff.generateSummary(
      headerDiff,
      frameDiffs,
      projectileEventDiffs,
      targetEventDiffs
    );

    return {
      headerDiff,
      frameDiffs,
      projectileEventDiffs,
      targetEventDiffs,
      summary,
    };
  }

  /**
   * Compare headers.
   */
  private static compareHeaders(header1: any, header2: any): HeaderDiff {
    return {
      formatVersionChanged: header1.formatVersion !== header2.formatVersion,
      gameVersionChanged: header1.gameVersion !== header2.gameVersion,
      durationDiff: header2.duration - header1.duration,
      frameCountDiff: header2.totalFrames - header1.totalFrames,
      projectileEventCountDiff: header2.projectileEvents - header1.projectileEvents,
      targetEventCountDiff: header2.targetEvents - header1.targetEvents,
    };
  }

  /**
   * Compare frames.
   */
  private static compareFrames(frames1: DemoFrame[], frames2: DemoFrame[]): FrameDiff[] {
    const diffs: FrameDiff[] = [];
    const maxFrames = Math.max(frames1.length, frames2.length);

    for (let i = 0; i < maxFrames; i++) {
      const frame1 = frames1[i];
      const frame2 = frames2[i];

      if (!frame1 || !frame2) {
        // One demo has more frames than the other
        diffs.push({
          frameIndex: i,
          timestampDiff: frame2 ? frame2.timestamp : -frame1!.timestamp,
          positionDiff: frame2 ? frame2.position.length() : -frame1!.position.length(),
          velocityDiff: frame2 ? frame2.velocity.length() : -frame1!.velocity.length(),
          rotationDiff: frame2 ? frame2.rotation.length() : -frame1!.rotation.length(),
        });
        continue;
      }

      const timestampDiff = frame2.timestamp - frame1.timestamp;
      const positionDiff = frame2.position.distanceTo(frame1.position);
      const velocityDiff = frame2.velocity.distanceTo(frame1.velocity);
      const rotationDiff = frame2.rotation.angleTo(frame1.rotation);

      // Only add if there's a significant difference
      if (
        Math.abs(timestampDiff) > 0.001 ||
        positionDiff > 0.01 ||
        velocityDiff > 0.01 ||
        rotationDiff > 0.01
      ) {
        diffs.push({
          frameIndex: i,
          timestampDiff,
          positionDiff,
          velocityDiff,
          rotationDiff,
        });
      }
    }

    return diffs;
  }

  /**
   * Compare projectile events.
   */
  private static compareProjectileEvents(
    events1: ProjectileEvent[],
    events2: ProjectileEvent[]
  ): EventDiff[] {
    const diffs: EventDiff[] = [];
    const maxEvents = Math.max(events1.length, events2.length);

    for (let i = 0; i < maxEvents; i++) {
      const event1 = events1[i];
      const event2 = events2[i];

      if (!event1 || !event2) {
        // One demo has more events than the other
        diffs.push({
          eventIndex: i,
          eventType: event2 ? event2.eventType.toString() : event1!.eventType.toString(),
          timestampDiff: event2 ? event2.timestamp : -event1!.timestamp,
          positionDiff: event2 ? event2.position.length() : -event1!.position.length(),
          velocityDiff: event2 ? event2.velocity.length() : -event1!.velocity.length(),
        });
        continue;
      }

      const timestampDiff = event2.timestamp - event1.timestamp;
      const positionDiff = event2.position.distanceTo(event1.position);
      const velocityDiff = event2.velocity.distanceTo(event1.velocity);

      if (
        Math.abs(timestampDiff) > 0.001 ||
        positionDiff > 0.01 ||
        velocityDiff > 0.01
      ) {
        diffs.push({
          eventIndex: i,
          eventType: event1.eventType.toString(),
          timestampDiff,
          positionDiff,
          velocityDiff,
        });
      }
    }

    return diffs;
  }

  /**
   * Compare target events.
   */
  private static compareTargetEvents(events1: TargetEvent[], events2: TargetEvent[]): EventDiff[] {
    const diffs: EventDiff[] = [];
    const maxEvents = Math.max(events1.length, events2.length);

    for (let i = 0; i < maxEvents; i++) {
      const event1 = events1[i];
      const event2 = events2[i];

      if (!event1 || !event2) {
        // One demo has more events than the other
        diffs.push({
          eventIndex: i,
          eventType: event2 ? event2.eventType.toString() : event1!.eventType.toString(),
          timestampDiff: event2 ? event2.timestamp : -event1!.timestamp,
          positionDiff: event2 ? event2.position.length() : -event1!.position.length(),
          velocityDiff: event2 ? event2.velocity.length() : -event1!.velocity.length(),
        });
        continue;
      }

      const timestampDiff = event2.timestamp - event1.timestamp;
      const positionDiff = event2.position.distanceTo(event1.position);
      const velocityDiff = event2.velocity.distanceTo(event1.velocity);

      if (
        Math.abs(timestampDiff) > 0.001 ||
        positionDiff > 0.01 ||
        velocityDiff > 0.01
      ) {
        diffs.push({
          eventIndex: i,
          eventType: event1.eventType.toString(),
          timestampDiff,
          positionDiff,
          velocityDiff,
        });
      }
    }

    return diffs;
  }

  /**
   * Generate diff summary.
   */
  private static generateSummary(
    headerDiff: HeaderDiff,
    frameDiffs: FrameDiff[],
    projectileEventDiffs: EventDiff[],
    targetEventDiffs: EventDiff[]
  ): DiffSummary {
    const totalDifferences =
      frameDiffs.length + projectileEventDiffs.length + targetEventDiffs.length;
    const significantDifferences: string[] = [];

    if (headerDiff.formatVersionChanged) {
      significantDifferences.push('Format version changed');
    }

    if (headerDiff.gameVersionChanged) {
      significantDifferences.push('Game version changed');
    }

    if (Math.abs(headerDiff.durationDiff) > 1) {
      significantDifferences.push(`Duration changed by ${headerDiff.durationDiff.toFixed(1)}s`);
    }

    if (Math.abs(headerDiff.frameCountDiff) > 10) {
      significantDifferences.push(`Frame count changed by ${headerDiff.frameCountDiff}`);
    }

    if (frameDiffs.length > 10) {
      significantDifferences.push(`${frameDiffs.length} frame differences`);
    }

    const totalElements = frameDiffs.length + projectileEventDiffs.length + targetEventDiffs.length;
    const percentDifferent = totalElements > 0 ? (totalDifferences / totalElements) * 100 : 0;

    return {
      totalDifferences,
      percentDifferent,
      significantDifferences,
    };
  }

  /**
   * Format diff as readable text.
   * @param diff - Diff result
   * @returns Formatted string
   */
  static formatDiff(diff: DemoDiff): string {
    const lines: string[] = [];

    lines.push('=== Demo Comparison ===');
    lines.push('');

    // Header
    lines.push('Header Differences:');
    lines.push(`  Format version: ${diff.headerDiff.formatVersionChanged ? 'CHANGED' : 'Same'}`);
    lines.push(`  Game version: ${diff.headerDiff.gameVersionChanged ? 'CHANGED' : 'Same'}`);
    lines.push(`  Duration: ${diff.headerDiff.durationDiff > 0 ? '+' : ''}${diff.headerDiff.durationDiff.toFixed(2)}s`);
    lines.push(`  Frame count: ${diff.headerDiff.frameCountDiff > 0 ? '+' : ''}${diff.headerDiff.frameCountDiff}`);
    lines.push(`  Projectile events: ${diff.headerDiff.projectileEventCountDiff > 0 ? '+' : ''}${diff.headerDiff.projectileEventCountDiff}`);
    lines.push(`  Target events: ${diff.headerDiff.targetEventCountDiff > 0 ? '+' : ''}${diff.headerDiff.targetEventCountDiff}`);
    lines.push('');

    // Summary
    lines.push('Summary:');
    lines.push(`  Total differences: ${diff.summary.totalDifferences}`);
    lines.push(`  Percent different: ${diff.summary.percentDifferent.toFixed(1)}%`);
    if (diff.summary.significantDifferences.length > 0) {
      lines.push('  Significant changes:');
      for (const change of diff.summary.significantDifferences) {
        lines.push(`    - ${change}`);
      }
    }
    lines.push('');

    // Frame diffs (limited)
    if (diff.frameDiffs.length > 0) {
      lines.push(`Frame Differences (${diff.frameDiffs.length}):`);
      const maxToShow = Math.min(5, diff.frameDiffs.length);
      for (let i = 0; i < maxToShow; i++) {
        const d = diff.frameDiffs[i];
        lines.push(`  Frame ${d.frameIndex}: pos=${d.positionDiff.toFixed(3)}, vel=${d.velocityDiff.toFixed(3)}`);
      }
      if (diff.frameDiffs.length > 5) {
        lines.push(`  ... and ${diff.frameDiffs.length - 5} more`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
