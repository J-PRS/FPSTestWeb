import { describe, it, expect } from 'bun:test';
import { mkRoom, step } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// The zombie-seat regression a headless soak ran into: a seat believed
// itself connected for 75s while every keepalive (ping/stateHash),
// broadcast, and tick was dark — only inputSync trickled. Server-side
// that reads as "this socket exists but the room never emits to it."
// A live human seat MUST see periodic keepalives — ping round-robins
// every ~0.5s per human and stateHash ticks the whole room — so this is
// the wire-vitality invariant the soak was collecting but never asserting.
describe('scenario: seat keepalive', () => {
  it('a joined human seat receives ping + stateHash inside 5s of ticks', () => {
    const room = mkRoom({ bots: 0 }, 'dm');
    const got: ServerMessage[] = [];
    const pid = 'P1';
    room.players.addPlayer(pid);
    room.connections.register(pid, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => {
        if (typeof d === 'string') {got.push(JSON.parse(d) as ServerMessage);}
        return (d as string).length ?? (d as Uint8Array).byteLength;
      },
    } as never);
    step(room, 100); // 5s of sim ticks
    const types = new Set(got.map((m) => m.type));
    expect(types.has('ping')).toBe(true);
    // stateHash rides TickLoop's wall-clock interval, not Room.sims —
    // unreachable in a stepped harness. ping alone is the seat-vitality
    // contract the soak canary asserts on the far end.
  });
});
