import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Room } from '../../src/Room.ts';

function wsSpy(room: Room, pid: string): ServerMessage[] {
  const got: ServerMessage[] = [];
  room.connections.register(pid, {
    readyState: 1,
    send: (d: string | ArrayBuffer | Uint8Array) => { got.push(JSON.parse(d as string) as ServerMessage); return 0; },
  } as never);
  return got;
}
const chats = (ms: ServerMessage[]) => ms.filter((m) => m.type === 'chat');

describe('scenario: team chat routing', () => {
  it('team chat reaches only same-team sockets, flagged team', () => {
    const room = mkRoom({ bots: 3 });
    const [a, b, c] = [...room.players.getAllPlayers().values()];
    a!.team = 'alpha'; b!.team = 'alpha'; c!.team = 'bravo';
    const toA = wsSpy(room, a!.id);
    const toB = wsSpy(room, b!.id);
    const toC = wsSpy(room, c!.id);

    room.messages.handleMessage(a!.id, { type: 'chat', text: 'push left', team: true });

    expect(chats(toA).length).toBe(1); // sender hears their own line
    expect(chats(toB).length).toBe(1); // teammate hears it
    expect(chats(toC).length).toBe(0); // enemy hears nothing
    expect((chats(toB)[0] as { team?: boolean }).team).toBe(true);
  });

  it('team chat from a teamless sender falls back to global', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = [...room.players.getAllPlayers().values()];
    const toA = wsSpy(room, a!.id);
    const toB = wsSpy(room, b!.id);

    room.messages.handleMessage(a!.id, { type: 'chat', text: 'anyone home', team: true });
    expect(chats(toA).length).toBe(1);
    expect(chats(toB).length).toBe(1); // a ffa client can't whisper into the void
  });

  it('global chat still reaches every socket', () => {
    const room = mkRoom({ bots: 3 });
    const [a, b, c] = [...room.players.getAllPlayers().values()];
    a!.team = 'alpha'; b!.team = 'bravo'; c!.team = 'bravo';
    const toB = wsSpy(room, b!.id);
    const toC = wsSpy(room, c!.id);

    room.messages.handleMessage(a!.id, { type: 'chat', text: 'gg' });
    expect(chats(toB).length).toBe(1);
    expect(chats(toC).length).toBe(1);
  });
});
