/**
 * Rate limiter for preventing message spam attacks
 * Per-player rate limiting for critical game messages
 */

import { ServerConfig } from './config.js';

export class RateLimiter {
  private lastShotTime: Map<string, number> = new Map();
  private lastJumpTime: Map<string, number> = new Map();
  private lastJetpackTime: Map<string, number> = new Map();
  private messageCount: Map<string, number> = new Map();
  private lastCountReset: Map<string, number> = new Map();
  private lastWarningTime: Map<string, number> = new Map();

  // Rate limits (in milliseconds) - configured via ServerConfig
  private readonly MIN_SHOT_INTERVAL = ServerConfig.MILLISECONDS_PER_SECOND / ServerConfig.MAX_SHOTS_PER_SECOND;
  private readonly MIN_JUMP_INTERVAL = ServerConfig.MILLISECONDS_PER_SECOND / ServerConfig.MAX_JUMPS_PER_SECOND;
  private readonly MIN_JETPACK_INTERVAL = ServerConfig.MILLISECONDS_PER_SECOND / ServerConfig.MAX_JETPACK_UPDATES_PER_SECOND;
  private readonly MAX_MESSAGES_PER_SECOND = ServerConfig.MAX_TOTAL_MESSAGES_PER_SECOND;
  private readonly WARNING_COOLDOWN_MS = ServerConfig.RATE_LIMIT_WARNING_COOLDOWN_MS;

  /**
   * Check if player can shoot (rate limited)
   */
  canShoot(playerId: string): boolean {
    const now = Date.now();
    const last = this.lastShotTime.get(playerId) || 0;
    if (now - last < this.MIN_SHOT_INTERVAL) {
      return false;
    }
    this.lastShotTime.set(playerId, now);
    return true;
  }

  /**
   * Check if player can jump (rate limited)
   */
  canJump(playerId: string): boolean {
    const now = Date.now();
    const last = this.lastJumpTime.get(playerId) || 0;
    if (now - last < this.MIN_JUMP_INTERVAL) {
      return false;
    }
    this.lastJumpTime.set(playerId, now);
    return true;
  }

  /**
   * Check if player can send jetpack update (rate limited)
   */
  canJetpack(playerId: string): boolean {
    const now = Date.now();
    const last = this.lastJetpackTime.get(playerId) || 0;
    if (now - last < this.MIN_JETPACK_INTERVAL) {
      return false;
    }
    this.lastJetpackTime.set(playerId, now);
    return true;
  }

  /**
   * Check if we should log a rate limit warning (cooled down to prevent log spam)
   */
  shouldLogWarning(playerId: string): boolean {
    const now = Date.now();
    const lastWarning = this.lastWarningTime.get(playerId) || 0;
    if (now - lastWarning >= this.WARNING_COOLDOWN_MS) {
      this.lastWarningTime.set(playerId, now);
      return true;
    }
    return false;
  }

  /**
   * Check if player is within total message rate limit
   */
  canSendMessage(playerId: string): boolean {
    const now = Date.now();
    const lastReset = this.lastCountReset.get(playerId) || 0;
    const count = this.messageCount.get(playerId) || 0;

    // Reset counter every second
    if (now - lastReset >= ServerConfig.MILLISECONDS_PER_SECOND) {
      this.messageCount.set(playerId, 0);
      this.lastCountReset.set(playerId, now);
      return true;
    }

    if (count >= this.MAX_MESSAGES_PER_SECOND) {
      return false;
    }

    this.messageCount.set(playerId, count + 1);
    return true;
  }

  /**
   * Clean up rate limiter state for disconnected player
   */
  cleanupPlayer(playerId: string): void {
    this.lastShotTime.delete(playerId);
    this.lastJumpTime.delete(playerId);
    this.lastJetpackTime.delete(playerId);
    this.messageCount.delete(playerId);
    this.lastCountReset.delete(playerId);
    this.lastWarningTime.delete(playerId);
  }

  /**
   * Get current rate limit stats for debugging
   */
  getStats(playerId: string): { shotsPerSec: number; jumpsPerSec: number; messagesPerSec: number } {
    const now = Date.now();
    const lastShot = this.lastShotTime.get(playerId) || 0;
    const lastJump = this.lastJumpTime.get(playerId) || 0;
    const lastReset = this.lastCountReset.get(playerId) || 0;
    const count = this.messageCount.get(playerId) || 0;

    const shotsPerSec = lastShot > 0 && now - lastShot < ServerConfig.MILLISECONDS_PER_SECOND ? ServerConfig.MILLISECONDS_PER_SECOND / (now - lastShot) : 0;
    const jumpsPerSec = lastJump > 0 && now - lastJump < ServerConfig.MILLISECONDS_PER_SECOND ? ServerConfig.MILLISECONDS_PER_SECOND / (now - lastJump) : 0;
    const messagesPerSec = lastReset > 0 && now - lastReset < ServerConfig.MILLISECONDS_PER_SECOND ? count : 0;

    return { shotsPerSec, jumpsPerSec, messagesPerSec };
  }

  /**
   * Get detailed rate limit info for a specific action type
   */
  getRateInfo(playerId: string, action: 'shot' | 'jump' | 'jetpack'): { actualRate: number; limit: number; exceededBy: number } {
    const now = Date.now();
    let lastTime: number;
    let limit: number;

    switch (action) {
      case 'shot':
        lastTime = this.lastShotTime.get(playerId) || 0;
        limit = ServerConfig.MAX_SHOTS_PER_SECOND;
        break;
      case 'jump':
        lastTime = this.lastJumpTime.get(playerId) || 0;
        limit = ServerConfig.MAX_JUMPS_PER_SECOND;
        break;
      case 'jetpack':
        lastTime = this.lastJetpackTime.get(playerId) || 0;
        limit = ServerConfig.MAX_JETPACK_UPDATES_PER_SECOND;
        break;
    }

    const actualRate = lastTime > 0 && now - lastTime < ServerConfig.MILLISECONDS_PER_SECOND ? ServerConfig.MILLISECONDS_PER_SECOND / (now - lastTime) : 0;
    const exceededBy = Math.max(0, actualRate - limit);

    return { actualRate, limit, exceededBy };
  }
}
