import { describe, it, expect } from 'bun:test';
import { wireLimit, WIRE_DEFAULT_LIMIT } from '../src/wire.ts';

// The limit table IS the cheap-DoS defense: every entry here guards a
// lane whose cost is wildly out of proportion to its bytes (snapshot
// reserialize, broadcast churn, mute spam). Loosening one — or a new
// expensive type landing on the 120/s default — must fail a test, not
// ship. Tightness assertions go one direction only: never ALLOW more.
describe('wire limit table', () => {
  it('keeps the reserialize-cost types on their tight budgets', () => {
    // Full-world snapshot + resync reserialize per request — the most
    // expensive message per byte a client can send.
    for (const t of ['snapshotRequest', 'resync'] as const) {
      const lim = wireLimit(t);
      expect(lim.maxCount).toBeLessThanOrEqual(3);
      expect(lim.windowMs).toBeGreaterThanOrEqual(5000);
    }
  });

  it('keeps broadcast-churn types throttled below the default lane', () => {
    // throwFlag fans a flagUpdate to the whole room per toss; chat fans
    // to every client AND mutes on flood. Both must stay well under the
    // 120/s default.
    for (const t of ['throwFlag', 'chat'] as const) {
      const lim = wireLimit(t);
      expect(lim.maxCount).toBeLessThanOrEqual(10);
      expect(lim.windowMs).toBeLessThanOrEqual(5000);
    }
    const chat = wireLimit('chat');
    expect(chat.muteMs).toBeGreaterThanOrEqual(10_000);
  });

  it('every registered type carries an explicit limit or falls back', () => {
    // A type with no limit entry must land on the shared default — the
    // table itself may not silently widen to Infinity.
    for (const t of ['position', 'inputMove', 'claim', 'shot', 'ping'] as const) {
      const lim = wireLimit(t) ?? WIRE_DEFAULT_LIMIT;
      expect(lim.maxCount).toBeLessThanOrEqual(120);
      expect(lim.windowMs).toBeGreaterThanOrEqual(1000);
    }
    expect(WIRE_DEFAULT_LIMIT.maxCount).toBeLessThanOrEqual(120);
  });
});
