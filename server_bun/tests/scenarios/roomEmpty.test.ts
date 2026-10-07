// Pins the empty-room guard that drives TickLoop teardown: bots do not
// keep a match alive (a room of only bots is empty), but a spectator or
// a grace-period ghost does — a room torn down under a watcher would
// strand its replica feed.
import { describe, expect, it } from 'bun:test';
import { mkRoom } from './harness.ts';

describe('room.empty guard', () => {
  it('a bots-only room is empty — bots exist to serve humans', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    expect(room.empty).toBe(true);
  });

  it('a spectator keeps the room alive', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    room.spectators.add('replica');
    expect(room.empty).toBe(false);
  });
});
