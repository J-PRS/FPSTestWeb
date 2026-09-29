import { describe, it, expect } from 'bun:test';
import { RoomArena } from '../../src/RoomArena.ts';
import { mkRoom, pin } from './harness.ts';

// The arena's outsideSince map is keyed by playerId but only iterated
// over LIVE players — a leaver's entry used to sit there for the
// room's life. The tick now prunes ids no longer on the roster.
describe('scenario: arena bookkeeping cleanup', () => {
  it('a leaver outside the dome leaves no outsideSince residue', () => {
    const room = mkRoom({ arena: { x: 0, z: 0, radius: 40 } });
    const arena = new RoomArena(room, { x: 0, z: 0, radius: 40 });
    room.players.addPlayer('P1');
    pin(room, 'P1', { x: 80, y: 31, z: 0 });
    arena.tick(0.05); // offender registered
    const outsideSince = (arena as unknown as {
      outsideSince: Map<string, number>;
    }).outsideSince;
    expect(outsideSince.has('P1')).toBe(true);
    room.removePlayerCompletely('P1', 'test', () => {});
    arena.tick(0.05);
    expect(outsideSince.has('P1')).toBe(false);
  });
});
