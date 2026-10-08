import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

function wsSpy(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const got: ServerMessage[] = [];
  room.connections.register(pid, {
    readyState: 1,
    send: (d: string | ArrayBuffer | Uint8Array) => { got.push(JSON.parse(d as string) as ServerMessage); return 0; },
  } as never);
  return got;
}

describe('scenario: duplicate join on a seated socket', () => {
  it('resends worldstate quietly — a lost gameState reply heals, no warn', () => {
    const room = mkRoom({ bots: 2 });
    const p = firstPlayer(room);
    const sent = wsSpy(room, p.id);
    // A client whose gameState was lost retries join on the same socket —
    // the seated dispatch must resend the world, not reject spam.
    room.messages.handleMessage(p.id, { type: 'join', playerId: p.id });
    expect(sent.some((m) => m.type === 'gameState')).toBe(true);
  });

  it('a join naming a different playerId dies silently — sockets never re-seat', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    const sentA = wsSpy(room, a.id);
    const sentB = wsSpy(room, b.id);
    room.messages.handleMessage(a.id, { type: 'join', playerId: b.id });
    expect(sentA.length + sentB.length).toBe(0);
  });
});
