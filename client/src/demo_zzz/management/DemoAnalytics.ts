import { DemoFile } from '../types/DemoFile.js';
import { DemoStatistics } from './DemoStatistics.js';

/**
 * Aggregate analytics across multiple demos.
 */
export interface DemoAnalytics {
  /** Total demos analyzed */
  totalDemos: number;
  /** Total recording time */
  totalDuration: number;
  /** Average duration */
  averageDuration: number;
  /** Total projectiles fired */
  totalProjectilesFired: number;
  /** Average accuracy */
  averageAccuracy: number;
  /** Total distance traveled */
  totalDistance: number;
  /** Average speed */
  averageSpeed: number;
  /** Peak speed */
  peakSpeed: number;
  /** Total events */
  totalEvents: number;
  /** Events per second */
  averageEventsPerSecond: number;
  /** Best accuracy */
  bestAccuracy: number;
  /** Worst accuracy */
  worstAccuracy: number;
  /** Most active demo */
  mostActiveDemo: string;
  /** Longest demo */
  longestDemo: string;
}

/**
 * Demo analytics dashboard.
 * Aggregate statistics across multiple demo files.
 */
export class DemoAnalytics {
  /**
   * Analyze multiple demo files.
   * @param demos - Array of demo files with names
   * @returns Analytics data
   */
  static analyze(demos: Array<{ name: string; demo: DemoFile }>): DemoAnalytics {
    if (demos.length === 0) {
      return DemoAnalytics.createEmpty();
    }

    const stats = demos.map((d) => ({
      name: d.name,
      stats: DemoStatistics.calculate(d.demo),
    }));

    const totalDuration = stats.reduce((sum, s) => sum + s.stats.duration, 0);
    const averageDuration = totalDuration / demos.length;

    const totalProjectilesFired = stats.reduce((sum, s) => sum + s.stats.projectilesFired, 0);
    const averageAccuracy = stats.reduce((sum, s) => sum + s.stats.projectileAccuracy, 0) / demos.length;

    const totalDistance = stats.reduce((sum, s) => sum + s.stats.totalDistance, 0);
    const averageSpeed = stats.reduce((sum, s) => sum + s.stats.averageSpeed, 0) / demos.length;
    const peakSpeed = Math.max(...stats.map((s) => s.stats.maxSpeed));

    const totalEvents = stats.reduce((sum, s) => sum + s.stats.projectilesFired + s.stats.targetsSpawned, 0);
    const averageEventsPerSecond = totalEvents / totalDuration;

    const bestAccuracy = Math.max(...stats.map((s) => s.stats.projectileAccuracy));
    const worstAccuracy = Math.min(...stats.map((s) => s.stats.projectileAccuracy));

    const mostActiveDemo = stats.reduce((max, s) => (s.stats.eventsPerSecond > max.stats.eventsPerSecond ? s : max)).name;
    const longestDemo = stats.reduce((max, s) => (s.stats.duration > max.stats.duration ? s : max)).name;

    return {
      totalDemos: demos.length,
      totalDuration,
      averageDuration,
      totalProjectilesFired,
      averageAccuracy,
      totalDistance,
      averageSpeed,
      peakSpeed,
      totalEvents,
      averageEventsPerSecond,
      bestAccuracy,
      worstAccuracy,
      mostActiveDemo,
      longestDemo,
    };
  }

  /**
   * Create empty analytics.
   */
  private static createEmpty(): DemoAnalytics {
    return {
      totalDemos: 0,
      totalDuration: 0,
      averageDuration: 0,
      totalProjectilesFired: 0,
      averageAccuracy: 0,
      totalDistance: 0,
      averageSpeed: 0,
      peakSpeed: 0,
      totalEvents: 0,
      averageEventsPerSecond: 0,
      bestAccuracy: 0,
      worstAccuracy: 0,
      mostActiveDemo: '',
      longestDemo: '',
    };
  }

  /**
   * Format analytics for display.
   * @param analytics - Analytics data
   * @returns Formatted string
   */
  static format(analytics: DemoAnalytics): string {
    return [
      '=== Demo Analytics ===',
      '',
      'Overview:',
      `  Total demos: ${analytics.totalDemos}`,
      `  Total duration: ${analytics.totalDuration.toFixed(1)}s`,
      `  Average duration: ${analytics.averageDuration.toFixed(1)}s`,
      '',
      'Performance:',
      `  Total projectiles: ${analytics.totalProjectilesFired}`,
      `  Average accuracy: ${analytics.averageAccuracy.toFixed(1)}%`,
      `  Best accuracy: ${analytics.bestAccuracy.toFixed(1)}%`,
      `  Worst accuracy: ${analytics.worstAccuracy.toFixed(1)}%`,
      '',
      'Movement:',
      `  Total distance: ${analytics.totalDistance.toFixed(1)}m`,
      `  Average speed: ${analytics.averageSpeed.toFixed(1)}m/s`,
      `  Peak speed: ${analytics.peakSpeed.toFixed(1)}m/s`,
      '',
      'Activity:',
      `  Total events: ${analytics.totalEvents}`,
      `  Events per second: ${analytics.averageEventsPerSecond.toFixed(1)}`,
      `  Most active demo: ${analytics.mostActiveDemo}`,
      `  Longest demo: ${analytics.longestDemo}`,
    ].join('\n');
  }

  /**
   * Generate a performance trend over time.
   * @param demos - Array of demo files with timestamps
   * @returns Array of {timestamp, accuracy} points
   */
  static generateAccuracyTrend(demos: Array<{ name: string; demo: DemoFile; timestamp: number }>): Array<{ timestamp: number; accuracy: number }> {
    return demos
      .map((d) => ({
        timestamp: d.timestamp,
        accuracy: DemoStatistics.calculate(d.demo).projectileAccuracy,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Compare two analytics periods.
   * @param analytics1 - First period analytics
   * @param analytics2 - Second period analytics
   * @returns Comparison string
   */
  static compare(analytics1: DemoAnalytics, analytics2: DemoAnalytics): string {
    const diff = (name: string, val1: number, val2: number) => {
      const delta = val2 - val1;
      const percent = val1 !== 0 ? (delta / val1) * 100 : 0;
      const sign = delta >= 0 ? '+' : '';
      return `  ${name}: ${val1.toFixed(1)} → ${val2.toFixed(1)} (${sign}${delta.toFixed(1)}, ${sign}${percent.toFixed(1)}%)`;
    };

    return [
      'Analytics Comparison:',
      diff('Average accuracy', analytics1.averageAccuracy, analytics2.averageAccuracy),
      diff('Average speed', analytics1.averageSpeed, analytics2.averageSpeed),
      diff('Events per second', analytics1.averageEventsPerSecond, analytics2.averageEventsPerSecond),
      diff('Total distance', analytics1.totalDistance, analytics2.totalDistance),
    ].join('\n');
  }
}
