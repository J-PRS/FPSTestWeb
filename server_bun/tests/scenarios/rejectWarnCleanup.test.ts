import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';

interface ThrottlePeek {
  reject(playerId: string, kind: string, reason: string): void;
  notifyDrop(playerId: string, kind: string, reason: string): void;
  onPlayerDisconnected(playerId: string): void;
  lastRejectWarn: Map<string, unknown>;
  lastDropNotify: Map<string, unknown>;
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
});
