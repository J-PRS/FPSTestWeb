import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

interface RoomPeek {
  wireIds: Map<string, number>;
  sessionTokens: Map<string, string>;
  lastSentPositions: Map<string, unknown>;
  chatPace: Map<string, unknown>;
  rateLimiter: { limits: Map<string, Map<string, unknown>> };
}

// removePlayerCompletely is THE depart funnel — every player-keyed
// registry must drain through it or a kicked/reaped/hopping player
// leaves per-id state in the room for its life (the stale-key class
// that produced §2.58-§2.90's fixes). A new keyed map without a delete
// here fails this pin instead of leaking silently.
describe('scenario: depart funnel purges all per-player state', () => {
  it('removePlayerCompletely empties the player\'s entries in every room map', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('P1');
    const p = { id: 'P1' };
    const r = room as unknown as RoomPeek;

    // Seed the receipts a live player accumulates.
    r.wireIds.set(p.id, 7);
    r.sessionTokens.set(p.id, 'tok');
    r.lastSentPositions.set(p.id, {});
    r.chatPace.set(p.id, []);
    r.rateLimiter.limits.set(p.id, new Map([['chat', {}]]));
    expect(r.wireIds.get(p.id)).toBe(7);

    room.removePlayerCompletely(p.id, 'test', () => {});

    for (const m of [r.sessionTokens, r.lastSentPositions, r.chatPace]) {
      expect(m.has(p.id)).toBe(false);
    }
    expect(r.wireIds.has(p.id)).toBe(false);
    // The u16 retires into the quiet-window ledger — reissue after
    // WIRE_ID_QUIET_MS, never a live alias — but the live binding dies.
    expect(r.rateLimiter.limits.has(p.id)).toBe(false);
  });
});
