import { wireLimit, wireLimitKey } from './wire.ts';
import { wallNow } from './wallClock.ts';

interface RateLimitEntry {
  count: number;
  windowStart: number;
  /** T2 mute: wall-time until which this type drops for this player. */
  mutedUntil?: number;
}

/** 'ok' = counted and allowed; 'drop' = over count, no mute configured;
 *  'muted' = dropped while already muted; 'tripped' = this message just
 *  crossed the threshold and armed the mute (caller may notify once). */
export type RateVerdict = 'ok' | 'drop' | 'tripped' | 'muted';

export class RateLimiter {
  private limits: Map<string, Map<string, RateLimitEntry>> = new Map();

  /** `at` is ARRIVAL time — the command drain can run a stalled-tick
   *  backlog seconds late, and windowing on drain time counts the whole
   *  backlog in one burst (position/teleport reports eaten wholesale). */
  check(playerId: string, messageType: string, at = wallNow()): RateVerdict {
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

    if (entry.mutedUntil !== undefined) {
      if (now < entry.mutedUntil) {return 'muted';}
      entry.mutedUntil = undefined;
      entry.count = 0;
      entry.windowStart = now;
    }

    if (now - entry.windowStart >= limit.windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;
    if (entry.count > limit.maxCount) {
      if (limit.muteMs) {
        entry.mutedUntil = now + limit.muteMs;
        return 'tripped';
      }
      return 'drop';
    }
    return 'ok';
  }

  removePlayer(playerId: string): void {
    this.limits.delete(playerId);
  }
}
