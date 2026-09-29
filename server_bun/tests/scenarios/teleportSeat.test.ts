import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: declared teleport', () => {
  it('reseats the plausibility anchor, clears rewind history, relays the snap', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    const toB: ServerMessage[] = [];
    room.connections.register(b.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { toB.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);

    const warp = { x: 120, y: 31, z: 120 };
    room.messages.handleMessage(a.id, { type: 'teleport', position: warp, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 1, pitch: 0 } });

    // lastValid seats at the warp — the NEXT position report deltas from
    // here, not from the corpse-side spot (that's the anti-snapback fix).
    expect(a.lastValidPosition).toEqual(warp);
    expect(a.position).toEqual(warp);
    // Pre-warp rewind samples are a different location — the lag-comp
    // buffer restarts with exactly the post-warp sample.
    expect(a.history.length).toBe(1);
    expect(a.history[0]).toMatchObject({ x: 120, z: 120 });
    expect(a.consecutiveRejects).toBe(0);
    // Observers snap instead of interpolating across the gap; sender excluded.
    const tp = toB.filter((m) => m.type === 'teleport');
    expect(tp.length).toBe(1);
    expect((tp[0] as { playerId: string }).playerId).toBe(a.id);
  });
});
