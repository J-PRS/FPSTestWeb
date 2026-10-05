import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: per-type rate limits', () => {
  it('chat over the 4/s cap is dropped, not relayed', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    const sent: ServerMessage[] = [];
    room.connections.register(p.id, {
      readyState: 1,
      send: (d: string | ArrayBuffer | Uint8Array) => { sent.push(JSON.parse(d as string) as ServerMessage); return 0; },
    } as never);
    // Explicit arrival times: handleMessage defaults `at` to wallNow(),
    // so under suite CPU contention a stalled loop could slide the 1s
    // window mid-test and flake the 4-cap assertion.
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      room.messages.handleMessage(p.id, { type: 'chat', text: `msg ${i}` }, t0 + i * 10);
    }
    // Cap is 4/window — the 5th and 6th never reach the room.
    expect(sent.filter((m) => m.type === 'chat').length).toBe(4);
  });

  it('declared teleports are honored, not silently dropped — cadence trips count as violations', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    // The client already applied the warp locally: refusing the reseat
    // converts it into pos-reject ping-pong (the force-accept loop) while
    // observers never get the relay. So inside-cadence warps reseat the
    // anchor like any other — abuse rides the teleportSpam counter.
    room.messages.handleMessage(p.id, { type: 'teleport', position: { x: 1, y: 31, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } });
    expect(p.lastValidPosition!.x).toBe(1);
    room.messages.handleMessage(p.id, { type: 'teleport', position: { x: 99, y: 31, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } });
    expect(p.lastValidPosition!.x).toBe(99); // honored + counted, not dropped
    expect(room.health.get('teleportSpam')).toBe(1);
  });
});
