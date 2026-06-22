/**
 * Position Discrepancy Checking (CFWK approach)
 * Validates client-reported positions against server expectations
 * with latency-aware thresholds
 */

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
}

export class PositionValidator {
  private positionHistory: Map<string, PositionHistoryEntry[]> = new Map();
  private readonly HISTORY_SIZE = 1000; // Keep ~1 second of history at 20Hz
  private readonly SOFT_THRESHOLD_BASE = 0.5; // Base soft threshold in meters
  private readonly HARD_THRESHOLD_BASE = 2.0; // Base hard threshold in meters
  private readonly MAX_PING_MS = 500; // Max ping for threshold scaling

  /**
   * Add a position snapshot to history
   */
  addSnapshot(
    playerId: string,
    timestamp: number,
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number }
  ): void {
    const history = this.positionHistory.get(playerId) || [];
    history.push({ timestamp, position: { ...position }, velocity: { ...velocity } });

    // Trim history
    if (history.length > this.HISTORY_SIZE) {
      history.shift();
    }

    this.positionHistory.set(playerId, history);
  }

  /**
   * Get expected position at a given timestamp by interpolating history
   */
  getExpectedPosition(playerId: string, timestamp: number): { x: number; y: number; z: number } | null {
    const history = this.positionHistory.get(playerId);
    if (!history || history.length === 0) return null;

    // Find snapshots before and after the timestamp
    let before = null;
    let after = null;

    for (const entry of history) {
      if (entry.timestamp <= timestamp) {
        before = entry;
      } else {
        after = entry;
        break;
      }
    }

    // If we only have before or after, return that
    if (!before && after) return { ...after.position };
    if (before && !after) return { ...before.position };
    if (!before && !after) return null;

    // Interpolate between before and after
    const totalDuration = after!.timestamp - before!.timestamp;
    if (totalDuration === 0) return { ...before!.position };

    const progress = (timestamp - before!.timestamp) / totalDuration;
    return {
      x: before!.position.x + (after!.position.x - before!.position.x) * progress,
      y: before!.position.y + (after!.position.y - before!.position.y) * progress,
      z: before!.position.z + (after!.position.z - before!.position.z) * progress
    };
  }

  /**
   * Validate client position with latency-aware thresholds
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

    // Calculate discrepancy (Euclidean distance)
    const dx = clientPosition.x - expectedPosition.x;
    const dy = clientPosition.y - expectedPosition.y;
    const dz = clientPosition.z - expectedPosition.z;
    const discrepancy = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Latency-aware thresholds
    // Higher ping = more tolerance (up to MAX_PING_MS)
    const pingFactor = Math.min(playerPing / this.MAX_PING_MS, 1.0);
    const softThreshold = this.SOFT_THRESHOLD_BASE + (pingFactor * 0.5); // 0.5 to 1.0
    const hardThreshold = this.HARD_THRESHOLD_BASE + (pingFactor * 1.0); // 2.0 to 3.0

    // Three-tier validation
    if (discrepancy < softThreshold) {
      return {
        valid: true,
        action: 'accept',
        discrepancy,
        expectedPosition
      };
    } else if (discrepancy < hardThreshold) {
      return {
        valid: true,
        action: 'nudge',
        discrepancy,
        expectedPosition
      };
    } else {
      return {
        valid: false,
        action: 'snap',
        discrepancy,
        expectedPosition
      };
    }
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
