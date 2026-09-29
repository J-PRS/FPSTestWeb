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
    for (let i = 0; i < 6; i++) {
      room.messages.handleMessage(p.id, { type: 'chat', text: `msg ${i}` });
    }
    // Cap is 4/window — the 5th and 6th never reach the room.
    expect(sent.filter((m) => m.type === 'chat').length).toBe(4);
  });

  it('rate-limited messages fall through to no handler work at all', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    // teleport cap is 1/1.1s (blink is the tightest legit cooldown);
    // a flood must not reseat the anchor after the cap trips.
    room.messages.handleMessage(p.id, { type: 'teleport', position: { x: 1, y: 31, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } });
    expect(p.lastValidPosition!.x).toBe(1);
    room.messages.handleMessage(p.id, { type: 'teleport', position: { x: 99, y: 31, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } });
    expect(p.lastValidPosition!.x).toBe(1); // dropped entirely
  });
});
