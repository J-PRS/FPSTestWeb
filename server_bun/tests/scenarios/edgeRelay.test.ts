import { describe, expect, it } from 'bun:test';
import { mkRoom } from './harness.ts';

// Engagement bookkeeping: noteEngagement tracks who shot whom for the
// cap-scoring boost; self-hits are ignored and stale pairs prune on read.

describe('engagement tracking', () => {
  it('engagement tracks who shot whom and expires stale pairs', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    room.noteEngagement('p1', 'p2');
    room.noteEngagement('p1', 'p1'); // self-hit ignored
    const m = room.engagementOf('p2');
    expect(m?.has('p1')).toBe(true);
    expect(room.engagementOf('p1')).toBeUndefined();
    m!.set('p1', 1); // forge an expired stamp
    expect(room.engagementOf('p2')).toBeUndefined(); // pruned on read
  });
});
