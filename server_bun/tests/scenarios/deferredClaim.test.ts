import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';
import { wallNow } from '../../src/wallClock.ts';

interface DeferPeek {
  deferClaim(playerId: string, kind: string, d: { at: number; left: number }, run: (d: { at: number; left: number }) => void): void;
  onPlayerDisconnected(playerId: string): void;
  pendingClaims: { playerId: string }[];
}

// A deferred claim whose spawn never lands must not outlive its player —
// the queue entry drops loudly on disconnect, not quietly on teardown.
describe('scenario: deferred claims die with their player', () => {
  it('disconnect drops the queue entry', () => {
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const combat = room.messages.combat as unknown as DeferPeek;

    combat.deferClaim(p.id, 'Shot', { at: wallNow(), left: 3 }, () => {});
    combat.deferClaim('OTHER-STAYS', 'Shot', { at: wallNow(), left: 3 }, () => {});
    expect(combat.pendingClaims.length).toBe(2);

    combat.onPlayerDisconnected(p.id);
    expect(combat.pendingClaims.length).toBe(1);
    expect(combat.pendingClaims[0]!.playerId).toBe('OTHER-STAYS');
  });
});
