import { CONFIG } from './config.ts';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

type MessageType = keyof typeof CONFIG.rateLimits | 'default';

export class RateLimiter {
  private limits: Map<string, Map<MessageType, RateLimitEntry>> = new Map();

  check(playerId: string, messageType: string): boolean {
    const configKey = (messageType in CONFIG.rateLimits ? messageType : 'default') as MessageType;
    const limit = CONFIG.rateLimits[configKey] ?? CONFIG.rateLimits.default;

    let playerLimits = this.limits.get(playerId);
    if (!playerLimits) {
      playerLimits = new Map();
      this.limits.set(playerId, playerLimits);
    }

    const now = Date.now();
    let entry = playerLimits.get(configKey);
    if (!entry) {
      entry = { count: 0, windowStart: now };
      playerLimits.set(configKey, entry);
    }

    if (now - entry.windowStart >= limit.windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count++;
    return entry.count <= limit.maxCount;
  }

  removePlayer(playerId: string): void {
    this.limits.delete(playerId);
  }
}
