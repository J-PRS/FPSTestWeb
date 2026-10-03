import { wireLimit, wireLimitKey } from './wire.ts';
import { wallNow } from './wallClock.ts';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private limits: Map<string, Map<string, RateLimitEntry>> = new Map();

  /** `at` is ARRIVAL time — the command drain can run a stalled-tick
   *  backlog seconds late, and windowing on drain time counts the whole
   *  backlog in one burst (position/teleport reports eaten wholesale). */
  check(playerId: string, messageType: string, at = wallNow()): boolean {
    const configKey = wireLimitKey(messageType);
    const limit = wireLimit(configKey);

    let playerLimits = this.limits.get(playerId);
    if (!playerLimits) {
      playerLimits = new Map();
      this.limits.set(playerId, playerLimits);
    }

    const now = at;
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
