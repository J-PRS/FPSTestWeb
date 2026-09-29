import { describe, it, expect } from 'bun:test';
import { mkRoom, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Per-connection delivery spy — broadcast(exclude) only shows up at the
// socket level, so the fake ws captures what each player actually gets.
function wsSpy(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const got: ServerMessage[] = [];
  room.connections.register(pid, {
    readyState: 1,
    send: (d: string | ArrayBuffer | Uint8Array) => { got.push(JSON.parse(d as string) as ServerMessage); return 0; },
  } as never);
  return got;
}

describe('scenario: presence relays', () => {
  it('jump/jetpack echo to everyone but the sender; dead senders are dropped', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    const toA = wsSpy(room, a.id);
    const toB = wsSpy(room, b.id);

    room.messages.handleMessage(a.id, { type: 'jump', position: a.position });
    expect(toA.length).toBe(0); // sender excluded — their own client renders it locally
    expect(toB.filter((m) => m.type === 'jump' && (m as { playerId: string }).playerId === a.id).length).toBe(1);

    room.messages.handleMessage(a.id, { type: 'jetpack', position: a.position });
    expect(toA.length).toBe(0);
    expect(toB.filter((m) => m.type === 'jetpack').length).toBe(1);

    // Dead senders relay nothing.
    a.isDead = true;
    room.messages.handleMessage(a.id, { type: 'jump', position: a.position });
    expect(toB.filter((m) => m.type === 'jump').length).toBe(1); // still just the first
  });

  it('chat echoes to every connection including the sender', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    const toA = wsSpy(room, a.id);
    const toB = wsSpy(room, b.id);
    room.messages.handleMessage(a.id, { type: 'chat', text: 'gl hf' });
    const chat = (ms: ServerMessage[]) => ms.filter((m) => m.type === 'chat');
    expect(chat(toA).length).toBe(1);
    expect(chat(toB).length).toBe(1);
    expect((chat(toB)[0] as { text: string }).text).toBe('gl hf');
  });
});
