import * as THREE from 'three';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { DemoClip } from '../types/DemoClip.js';

/**
 * Criteria for evaluating if a hit is "cool".
 */
export interface CoolHitCriteria {
  /** Distance from shooter to target */
  distance: number;
  /** Projectile velocity at impact */
  velocity: number;
  /** Number of bounces before hit */
  bounceCount: number;
  /** Whether it was a prediction shot (leading target) */
  isPrediction: boolean;
  /** Whether target was moving */
  targetWasMoving: boolean;
}

/**
 * Configuration for cool hit detection.
 */
export interface CoolHitConfig {
  /** Minimum distance for long range shot (meters) */
  longRangeDistance: number;
  /** Minimum velocity for high velocity shot (m/s) */
  highVelocityThreshold: number;
  /** Minimum bounces for bank shot */
  minBouncesForCool: number;
  /** Whether to enable prediction detection */
  enablePredictionDetection: boolean;
  /** Seconds before hit to include in clip */
  clipBeforeHit: number;
  /** Seconds after hit to include in clip */
  clipAfterHit: number;
  /** Maximum clips per session */
  maxClipsPerSession: number;
}

/**
 * Detects "cool hits" for automatic highlight clip extraction.
 * Evaluates shots based on configurable criteria.
 */
export class CoolHitDetector {
  private config: CoolHitConfig;
  private detectedClips: DemoClip[] = [];
  private projectileBounceCount: Map<number, number> = new Map();

  constructor(config?: Partial<CoolHitConfig>) {
    this.config = {
      longRangeDistance: 100,
      highVelocityThreshold: 50,
      minBouncesForCool: 2,
      enablePredictionDetection: true,
      clipBeforeHit: 2,
      clipAfterHit: 2,
      maxClipsPerSession: 10,
      ...config,
    };
  }

  /**
   * Evaluate a hit event to determine if it's a "cool shot".
   * @param hitEvent - The hit event
   * @param fireEvent - The corresponding fire event
   * @returns Whether the hit is cool
   */
  evaluateHit(
    hitEvent: ProjectileEvent,
    fireEvent: ProjectileEvent
  ): boolean {
    const bounceCount = this.projectileBounceCount.get(hitEvent.projectileId) ?? 0;

    const criteria: CoolHitCriteria = {
      distance: fireEvent.position.distanceTo(hitEvent.position),
      velocity: hitEvent.velocity.length(),
      bounceCount,
      isPrediction: this.calculatePredictionScore(fireEvent, hitEvent) > 0.5,
      targetWasMoving: true, // TODO: Get from target system
    };

    const isCool = this.isCoolHit(criteria);

    if (isCool) {
      const description = this.generateHitDescription(criteria);
      this.extractClip(hitEvent.timestamp, description, criteria);
    }

    // Reset bounce count for this projectile
    this.projectileBounceCount.delete(hitEvent.projectileId);

    return isCool;
  }

  /**
   * Track a bounce event for a projectile.
   * @param projectileId - Projectile ID
   */
  trackBounce(projectileId: number): void {
    const current = this.projectileBounceCount.get(projectileId) ?? 0;
    this.projectileBounceCount.set(projectileId, current + 1);
  }

  /**
   * Calculate prediction score (how much the shot led the target).
   * @param fireEvent - Fire event
   * @param hitEvent - Hit event
   * @returns Prediction score (0-1)
   */
  private calculatePredictionScore(fireEvent: ProjectileEvent, hitEvent: ProjectileEvent): number {
    // Simple implementation: distance-based
    // In a real implementation, this would compare shot direction to target movement
    const distance = fireEvent.position.distanceTo(hitEvent.position);
    const maxDistance = 200; // meters
    return Math.min(1, distance / maxDistance);
  }

  /**
   * Check if criteria meets cool hit thresholds.
   * @param criteria - Hit criteria
   * @returns Whether the hit is cool
   */
  private isCoolHit(criteria: CoolHitCriteria): boolean {
    // Long range shot
    if (criteria.distance >= this.config.longRangeDistance) {
      return true;
    }

    // High velocity hit
    if (criteria.velocity >= this.config.highVelocityThreshold) {
      return true;
    }

    // Bank shot (multiple bounces)
    if (criteria.bounceCount >= this.config.minBouncesForCool) {
      return true;
    }

    // Prediction shot
    if (this.config.enablePredictionDetection && criteria.isPrediction) {
      return true;
    }

    return false;
  }

  /**
   * Generate a description for a cool hit.
   * @param criteria - Hit criteria
   * @returns Description string
   */
  private generateHitDescription(criteria: CoolHitCriteria): string {
    const parts: string[] = [];

    if (criteria.distance >= this.config.longRangeDistance) {
      parts.push('Long Range');
    }

    if (criteria.velocity >= this.config.highVelocityThreshold) {
      parts.push('High Velocity');
    }

    if (criteria.bounceCount >= this.config.minBouncesForCool) {
      parts.push('Bank Shot');
    }

    if (this.config.enablePredictionDetection && criteria.isPrediction) {
      parts.push('Prediction');
    }

    if (criteria.targetWasMoving) {
      parts.push('Moving Target');
    }

    return parts.length > 0 ? parts.join(' + ') : 'Cool Shot';
  }

  /**
   * Extract a clip around a hit event.
   * @param hitTimestamp - Hit event timestamp
   * @param description - Clip description
   * @param criteria - Hit criteria
   */
  private extractClip(hitTimestamp: number, description: string, criteria: CoolHitCriteria): void {
    if (this.detectedClips.length >= this.config.maxClipsPerSession) {
      console.warn('[CoolHitDetector] Max clips reached, skipping extraction');
      return;
    }

    const clip: DemoClip = {
      startTime: hitTimestamp - this.config.clipBeforeHit,
      endTime: hitTimestamp + this.config.clipAfterHit,
      startFrameIndex: 0, // TODO: Calculate from frame buffer
      endFrameIndex: 0, // TODO: Calculate from frame buffer
      description,
    };

    this.detectedClips.push(clip);
    console.log(`[CoolHitDetector] Extracted clip: ${description}`);
  }

  /**
   * Get all detected clips.
   */
  getDetectedClips(): DemoClip[] {
    return [...this.detectedClips];
  }

  /**
   * Reset for a new recording session.
   */
  resetSession(): void {
    this.detectedClips = [];
    this.projectileBounceCount.clear();
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<CoolHitConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): CoolHitConfig {
    return { ...this.config };
  }
}
