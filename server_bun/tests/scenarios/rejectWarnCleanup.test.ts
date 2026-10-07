import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

interface ThrottlePeek {
  reject(playerId: string, kind: string, reason: string): void;
  notifyDrop(playerId: string, kind: string, reason: string): void;
  onPlayerDisconnected(playerId: string): void;
  lastRejectWarn: Map<string, unknown>;
  lastDropNotify: Map<string, unknown>;
  fireWindows: Map<string, unknown>;
  healTicks: Map<string, unknown>;
  lastHeal: Map<string, unknown>;
  lastFireNotify: Map<string, unknown>;
  chargeBank: { ramp: Map<string, unknown> };
}

// The warn throttles are per-player churn maps — a leaver's entries must
// not outlive them or the maps grow with cumulative room churn instead
// of the live roster.
describe('scenario: reject/drop warn throttles clear on departure', () => {
  it('disconnect purges both throttle maps for the leaver', () => {
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const combat = room.messages.combat as unknown as ThrottlePeek;

    combat.reject(p.id, 'shot', 'test reject');
    combat.notifyDrop(p.id, 'shot', 'test drop');
    expect(combat.lastRejectWarn.size).toBe(1);
    expect(combat.lastDropNotify.size).toBe(1);

    combat.onPlayerDisconnected(p.id);
    expect(combat.lastRejectWarn.size).toBe(0);
    expect(combat.lastDropNotify.size).toBe(0);
  });

  it('disconnect purges every combat-side keyed map for the leaver', () => {
    // The two warn throttles above are only half the funnel — fire-rate
    // windows, heal ticks, lastHeal, fire-notify and the LG ramp all key
    // on the same id. One map missed here grows one entry per leaver
    // for the room's life.
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const combat = room.messages.combat as unknown as ThrottlePeek;

    combat.fireWindows.set(`${p.id}:0`, {});
    combat.healTicks.set(`${p.id}|other`, {});
    combat.healTicks.set(`other|${p.id}`, {});
    combat.lastHeal.set(p.id, 1);
    combat.lastFireNotify.set(p.id, 1);
    combat.chargeBank.ramp.set(p.id, {});
    combat.lastRejectWarn.set(`${p.id}:x`, {});
    combat.lastDropNotify.set(`${p.id}:x`, {});

    combat.onPlayerDisconnected(p.id);

    expect(combat.fireWindows.has(`${p.id}:0`)).toBe(false);
    expect(combat.healTicks.has(`${p.id}|other`)).toBe(false);
    expect(combat.healTicks.has(`other|${p.id}`)).toBe(false);
    expect(combat.lastHeal.has(p.id)).toBe(false);
    expect(combat.lastFireNotify.has(p.id)).toBe(false);
    expect(combat.chargeBank.ramp.has(p.id)).toBe(false);
    expect(combat.lastRejectWarn.has(`${p.id}:x`)).toBe(false);
    expect(combat.lastDropNotify.has(`${p.id}:x`)).toBe(false);
  });
});
