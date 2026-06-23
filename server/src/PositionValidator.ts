/**
 * Position Discrepancy Checking (CFWK approach)
 * Validates client-reported positions against server expectations
 * with latency-aware thresholds
 */

import { ServerConfig } from './config.js';

export interface ValidationResult {
  valid: boolean;
  action: 'accept' | 'nudge' | 'snap';
  discrepancy: number;
  expectedPosition: { x: number; y: number; z: number };
}

export interface PositionHistoryEntry {
  timestamp: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  acceleration: { x: number; y: number; z: number };
}

export class PositionValidator {
  private positionHistory: Map<string, PositionHistoryEntry[]> = new Map();
  private readonly HISTORY_SIZE = ServerConfig.POSITION_HISTORY_SIZE;
  private readonly SOFT_THRESHOLD_BASE = ServerConfig.SOFT_THRESHOLD_BASE;
  private readonly HARD_THRESHOLD_BASE = ServerConfig.HARD_THRESHOLD_BASE;
  private readonly SOFT_THRESHOLD_VERTICAL = ServerConfig.SOFT_THRESHOLD_VERTICAL;
  private readonly HARD_THRESHOLD_VERTICAL = ServerConfig.HARD_THRESHOLD_VERTICAL;
  private readonly MAX_PING_MS = ServerConfig.MAX_PING_MS;

  /**
   * Add a position snapshot to history
   */
  addSnapshot(
    playerId: string,
    timestamp: number,
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
    acceleration: { x: number; y: number; z: number } = { x: 0, y: ServerConfig.GRAVITY, z: 0 }
  ): void {
    const history = this.positionHistory.get(playerId) || [];
    history.push({ timestamp, position: { ...position }, velocity: { ...velocity }, acceleration: { ...acceleration } });

    // Trim history
    if (history.length > this.HISTORY_SIZE) {
      history.shift();
    }

    this.positionHistory.set(playerId, history);
  }

  /**
   * Get expected position at a given timestamp using physics-aware extrapolation
   * Uses physics equation: pos = pos0 + vel*t + 0.5*acc*t^2
   * Accounts for gravity, jetpack, and skiing acceleration
   */
  getExpectedPosition(playerId: string, timestamp: number): { x: number; y: number; z: number } | null {
    const history = this.positionHistory.get(playerId);
    if (!history || history.length === 0) return null;

    // Find the most recent snapshot before the timestamp
    let closestBefore = null;
    for (const entry of history) {
      if (entry.timestamp <= timestamp) {
        closestBefore = entry;
      } else {
        break;
      }
    }

    if (!closestBefore) {
      // No snapshot before timestamp, use the oldest available
      return { ...history[0].position };
    }

    // Calculate time delta
    const dt = (timestamp - closestBefore.timestamp) / ServerConfig.MILLISECONDS_PER_SECOND; // Convert to seconds

    // If delta is very small, return the position as-is
    if (dt < 0.001) return { ...closestBefore.position };

    // Extrapolate using physics equation: pos = pos0 + vel*t + 0.5*acc*t^2
    // This accounts for gravity, jetpack thrust, and skiing acceleration
    const expectedPosition = {
      x: closestBefore.position.x + closestBefore.velocity.x * dt + 0.5 * closestBefore.acceleration.x * dt * dt,
      y: closestBefore.position.y + closestBefore.velocity.y * dt + 0.5 * closestBefore.acceleration.y * dt * dt,
      z: closestBefore.position.z + closestBefore.velocity.z * dt + 0.5 * closestBefore.acceleration.z * dt * dt
    };

    return expectedPosition;
  }

  /**
   * Validate client position with physics-aware, latency-aware thresholds
   * Separate horizontal and vertical thresholds to account for jetpack/skiing
   */
  validatePosition(
    playerId: string,
    clientPosition: { x: number; y: number; z: number },
    timestamp: number,
    playerPing: number
  ): ValidationResult {
    const expectedPosition = this.getExpectedPosition(playerId, timestamp);

    if (!expectedPosition) {
      // No history, accept position
      return {
        valid: true,
        action: 'accept',
        discrepancy: 0,
        expectedPosition: clientPosition
      };
    }

    // Calculate horizontal and vertical discrepancies separately
    const dx = clientPosition.x - expectedPosition.x;
    const dy = clientPosition.y - expectedPosition.y;
    const dz = clientPosition.z - expectedPosition.z;
    
    const horizontalDiscrepancy = Math.sqrt(dx * dx + dz * dz);
    const verticalDiscrepancy = Math.abs(dy);
    const totalDiscrepancy = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Latency-aware thresholds
    // Higher ping = more tolerance (up to MAX_PING_MS)
    const pingFactor = Math.min(playerPing / this.MAX_PING_MS, 1.0);
    
    // Horizontal thresholds (stricter - ground movement is predictable)
    const horizontalSoftThreshold = this.SOFT_THRESHOLD_BASE + (pingFactor * 0.5); // 0.5 to 1.0
    const horizontalHardThreshold = this.HARD_THRESHOLD_BASE + (pingFactor * 1.0); // 2.0 to 3.0
    
    // Vertical thresholds (more lenient - jetpack/skiing cause rapid vertical changes)
    const verticalSoftThreshold = 2.0 + (pingFactor * 1.0); // 2.0 to 3.0
    const verticalHardThreshold = 5.0 + (pingFactor * 2.0); // 5.0 to 7.0

    // Determine action based on both horizontal and vertical discrepancies
    let action: 'accept' | 'nudge' | 'snap' = 'accept';
    
    // Check horizontal first (stricter)
    if (horizontalDiscrepancy > horizontalHardThreshold) {
      action = 'snap';
    } else if (horizontalDiscrepancy > horizontalSoftThreshold) {
      action = 'nudge';
    }
    
    // Check vertical (more lenient, but can override to snap if extreme)
    if (verticalDiscrepancy > verticalHardThreshold) {
      action = 'snap';
    } else if (verticalDiscrepancy > verticalSoftThreshold && action !== 'snap') {
      action = 'nudge';
    }

    return {
      valid: action !== 'snap',
      action,
      discrepancy: totalDiscrepancy,
      expectedPosition
    };
  }

  /**
   * Clear history for a player
   */
  clearHistory(playerId: string): void {
    this.positionHistory.delete(playerId);
  }

  /**
   * Get history size for debugging
   */
  getHistorySize(playerId: string): number {
    return this.positionHistory.get(playerId)?.length || 0;
  }
}
