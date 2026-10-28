import { describe, expect, test } from 'bun:test';
import { mkRoom } from './scenarios/harness.ts';

/** floodPause: a rate-limit trip pauses the socket's inbound dispatch —
 *  zero parse/validate for the window (Bun 1.4 ws.pause/resume). */
describe('floodPause', () => {
  const seat = (room: ReturnType<typeof mkRoom>, id: string): { ws: { pause: () => void; resume: () => void; readyState: number; data: object }; paused: number; resumed: number } => {
    const spy = { paused: 0, resumed: 0, ws: null as never };
    spy.ws = {
      readyState: 1, data: {},
      send: () => 1,
      pause: () => { spy.paused += 1; },
      resume: () => { spy.resumed += 1; },
    } as never;
    room.connections.register(id, spy.ws);
    return spy as never;
  };

  test('tripped flood control pauses the socket, resume fires after ms', async () => {
    const room = mkRoom({}, 'dm');
    const p = room.players.addPlayer('p1');
    p.hasReceivedPosition = true;
    const spy = seat(room, 'p1');

    for (let i = 0; i < 4; i++) {
      room.messages.handleMessage('p1', { type: 'chat', text: `hi ${i}` } as never);
    }
    expect(spy.paused).toBe(0);
    room.messages.handleMessage('p1', { type: 'chat', text: 'one too many' } as never);
    expect(spy.paused).toBe(1);
    expect(spy.resumed).toBe(0);
    await new Promise((r): void => { setTimeout(r, 1100); });
    expect(spy.resumed).toBe(1);
  });

  test('unregister clears the pending resume', () => {
    const room = mkRoom({}, 'dm');
    const p = room.players.addPlayer('p2');
    p.hasReceivedPosition = true;
    const spy = seat(room, 'p2');
    room.connections.floodPause('p2', 10_000);
    expect(spy.paused).toBe(1);
    room.connections.unregister('p2');
    expect((room.connections as unknown as { floodTimers: Map<string, unknown> }).floodTimers.size).toBe(0);
  });
});
