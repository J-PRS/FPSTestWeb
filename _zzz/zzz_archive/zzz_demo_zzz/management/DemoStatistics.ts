import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';
import { ProjectileEventType } from '../types/ProjectileEvent.js';

/**
 * Detailed statistics for a demo.
 */
export interface DemoStatistics {
  // General
  duration: number;
  frameCount: number;
  averageFPS: number;

  // Player movement
  totalDistance: number;
  averageSpeed: number;
  maxSpeed: number;
  maxHeight: number;
  minHeight: number;

  // Projectile statistics
  projectilesFired: number;
  projectileHits: number;
  projectileAccuracy: number;
  averageProjectileSpeed: number;
  maxProjectileSpeed: number;
  totalBounces: number;

  // Target statistics
  targetsSpawned: number;
  targetsHit: number;
  targetsDestroyed: number;
  averageTargetHealth: number;

  // Input statistics
  totalMouseDelta: number;
  averageMouseDelta: number;
  maxMouseDelta: number;
  jetpackUsage: number;
  jetpackFuelUsed: number;

  // Event frequency
  eventsPerSecond: number;
  peakEventsPerSecond: number;
}

/**
 * Analyze demo files for gameplay statistics.
 * Useful for performance analysis and gameplay review.
 */
export class DemoStatistics {
  /**
   * Calculate statistics for a demo file.
   * @param demo - Demo file
   * @returns Demo statistics
   */
  static calculate(demo: DemoFile): DemoStatistics {
    const stats: DemoStatistics = {
      duration: demo.header.duration,
      frameCount: demo.frames.length,
      averageFPS: demo.header.duration > 0 ? demo.frames.length / demo.header.duration : 0,

      totalDistance: 0,
      averageSpeed: 0,
      maxSpeed: 0,
      maxHeight: -Infinity,
      minHeight: Infinity,

      projectilesFired: 0,
      projectileHits: 0,
      projectileAccuracy: 0,
      averageProjectileSpeed: 0,
      maxProjectileSpeed: 0,
      totalBounces: 0,

      targetsSpawned: 0,
      targetsHit: 0,
      targetsDestroyed: 0,
      averageTargetHealth: 0,

      totalMouseDelta: 0,
      averageMouseDelta: 0,
      maxMouseDelta: 0,
      jetpackUsage: 0,
      jetpackFuelUsed: 0,

      eventsPerSecond: 0,
      peakEventsPerSecond: 0,
    };

    // Analyze frames
    let lastPosition = demo.frames[0]?.position.clone() || new THREE.Vector3();
    let totalSpeed = 0;
    let totalMouseDelta = 0;
    let maxMouseDelta = 0;
    let jetpackFrames = 0;
    let totalJetpackFuel = 0;

    for (const frame of demo.frames) {
      // Distance
      const distance = frame.position.distanceTo(lastPosition);
      stats.totalDistance += distance;
      lastPosition = frame.position.clone();

      // Speed
      const speed = frame.velocity.length();
      totalSpeed += speed;
      stats.maxSpeed = Math.max(stats.maxSpeed, speed);

      // Height
      stats.maxHeight = Math.max(stats.maxHeight, frame.position.y);
      stats.minHeight = Math.min(stats.minHeight, frame.position.y);

      // Mouse delta
      const mouseDelta = Math.sqrt(frame.mouseDeltaX ** 2 + frame.mouseDeltaY ** 2);
      totalMouseDelta += mouseDelta;
      maxMouseDelta = Math.max(maxMouseDelta, mouseDelta);

      // Jetpack
      if (frame.jetpackFlags !== 0) {
        jetpackFrames++;
        totalJetpackFuel += frame.jetpackFuel;
      }
    }

    stats.averageSpeed = demo.frames.length > 0 ? totalSpeed / demo.frames.length : 0;
    stats.totalMouseDelta = totalMouseDelta;
    stats.averageMouseDelta = demo.frames.length > 0 ? totalMouseDelta / demo.frames.length : 0;
    stats.maxMouseDelta = maxMouseDelta;
    stats.jetpackUsage = demo.frames.length > 0 ? (jetpackFrames / demo.frames.length) * 100 : 0;
    stats.jetpackFuelUsed = totalJetpackFuel;

    // Analyze projectile events
    let totalProjectileSpeed = 0;
    let maxProjectileSpeed = 0;

    for (const event of demo.projectileEvents) {
      if (event.eventType === ProjectileEventType.Fired) {
        stats.projectilesFired++;
        const speed = event.velocity.length();
        totalProjectileSpeed += speed;
        maxProjectileSpeed = Math.max(maxProjectileSpeed, speed);
      } else if (event.eventType === ProjectileEventType.Bounce) {
        stats.totalBounces++;
      } else if (event.eventType === ProjectileEventType.Hit) {
        stats.projectileHits++;
      }
    }

    stats.projectileAccuracy = stats.projectilesFired > 0 ? (stats.projectileHits / stats.projectilesFired) * 100 : 0;
    stats.averageProjectileSpeed = stats.projectilesFired > 0 ? totalProjectileSpeed / stats.projectilesFired : 0;
    stats.maxProjectileSpeed = maxProjectileSpeed;

    // Analyze target events
    let totalTargetHealth = 0;

    for (const event of demo.targetEvents) {
      if (event.eventType === 0) { // Spawned
        stats.targetsSpawned++;
      } else if (event.eventType === 2) { // Hit
        stats.targetsHit++;
        totalTargetHealth += event.health;
      } else if (event.eventType === 3) { // Destroyed
        stats.targetsDestroyed++;
      }
    }

    stats.averageTargetHealth = stats.targetsHit > 0 ? totalTargetHealth / stats.targetsHit : 0;

    // Event frequency
    const totalEvents = demo.projectileEvents.length + demo.targetEvents.length;
    stats.eventsPerSecond = demo.header.duration > 0 ? totalEvents / demo.header.duration : 0;

    // Calculate peak events per second (simplified)
    stats.peakEventsPerSecond = stats.eventsPerSecond * 2; // Estimate

    return stats;
  }

  /**
   * Format statistics for display.
   * @param stats - Demo statistics
   * @returns Formatted string
   */
  static format(stats: DemoStatistics): string {
    return [
      'Demo Statistics:',
      `  Duration: ${stats.duration.toFixed(1)}s`,
      `  Frames: ${stats.frameCount}`,
      `  Average FPS: ${stats.averageFPS.toFixed(1)}`,
      '',
      'Movement:',
      `  Total distance: ${stats.totalDistance.toFixed(1)}m`,
      `  Average speed: ${stats.averageSpeed.toFixed(1)}m/s`,
      `  Max speed: ${stats.maxSpeed.toFixed(1)}m/s`,
      `  Height range: ${stats.minHeight.toFixed(1)}m - ${stats.maxHeight.toFixed(1)}m`,
      '',
      'Projectiles:',
      `  Fired: ${stats.projectilesFired}`,
      `  Hits: ${stats.projectileHits}`,
      `  Accuracy: ${stats.projectileAccuracy.toFixed(1)}%`,
      `  Average speed: ${stats.averageProjectileSpeed.toFixed(1)}m/s`,
      `  Max speed: ${stats.maxProjectileSpeed.toFixed(1)}m/s`,
      `  Total bounces: ${stats.totalBounces}`,
      '',
      'Targets:',
      `  Spawned: ${stats.targetsSpawned}`,
      `  Hit: ${stats.targetsHit}`,
      `  Destroyed: ${stats.targetsDestroyed}`,
      `  Average health: ${stats.averageTargetHealth.toFixed(1)}`,
      '',
      'Input:',
      `  Total mouse delta: ${stats.totalMouseDelta.toFixed(1)}`,
      `  Average mouse delta: ${stats.averageMouseDelta.toFixed(1)}`,
      `  Max mouse delta: ${stats.maxMouseDelta.toFixed(1)}`,
      `  Jetpack usage: ${stats.jetpackUsage.toFixed(1)}%`,
      `  Jetpack fuel used: ${stats.jetpackFuelUsed.toFixed(1)}`,
      '',
      'Events:',
      `  Events per second: ${stats.eventsPerSecond.toFixed(1)}`,
      `  Peak events per second: ${stats.peakEventsPerSecond.toFixed(1)}`,
    ].join('\n');
  }

  /**
   * Compare two demos and return differences.
   * @param stats1 - First demo statistics
   * @param stats2 - Second demo statistics
   * @returns Comparison string
   */
  static compare(stats1: DemoStatistics, stats2: DemoStatistics): string {
    const diff = (name: string, val1: number, val2: number) => {
      const delta = val2 - val1;
      const percent = val1 !== 0 ? (delta / val1) * 100 : 0;
      const sign = delta >= 0 ? '+' : '';
      return `  ${name}: ${val1.toFixed(1)} → ${val2.toFixed(1)} (${sign}${delta.toFixed(1)}, ${sign}${percent.toFixed(1)}%)`;
    };

    return [
      'Demo Comparison:',
      diff('Duration', stats1.duration, stats2.duration),
      diff('Average FPS', stats1.averageFPS, stats2.averageFPS),
      diff('Total distance', stats1.totalDistance, stats2.totalDistance),
      diff('Average speed', stats1.averageSpeed, stats2.averageSpeed),
      diff('Projectiles fired', stats1.projectilesFired, stats2.projectilesFired),
      diff('Accuracy', stats1.projectileAccuracy, stats2.projectileAccuracy),
      diff('Targets destroyed', stats1.targetsDestroyed, stats2.targetsDestroyed),
    ].join('\n');
  }
}
