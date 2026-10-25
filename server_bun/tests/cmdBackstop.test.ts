import { wallMs } from '../src/wallClock.ts';
import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { Room } from '../src/Room.ts';

function fakeWs() {
  return {
    data: {} as { playerId?: string },
    sent: [] as string[],
    send(d: string | ArrayBuffer) { this.sent.push(typeof d === 'string' ? d : new TextDecoder().decode(d)); },
    close() { /* no-op */ },
    readyState: 1,
  };
}

interface Peek {
  playerRoom: Map<string, Room>;
  rooms: Map<string, { terrainReady?: Promise<unknown> }>;
  ops: { msgsRejected: number };
}

// The command buffer's 2000-entry backstop is the last-resort bound on
// a validated-message flood: legit traffic is ~500/player/tick, but a
// flooding client filling the queue between drains would stall the cmd
// phase for the whole room if the array grew unboundedly.
describe('command buffer backstop', () => {
  let gs: GameServer;
  afterEach(() => gs.stop());

  it('drops validated messages once the queue is full', async () => {
    gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const peek = gs as unknown as Peek;

    const ws = fakeWs();
    gs.onOpen(ws as never);
    gs.onMessage(ws as never, JSON.stringify({ type: 'join', playerId: 'p1', room: 'default', mode: 'dm' }));
    // The seat defers on terrainReady — playerRoom fills only after it.
    await (peek.rooms.get('default') as { terrainReady?: Promise<unknown> } | undefined)?.terrainReady;
    const room = peek.playerRoom.get('p1')!;

    // Park the buffer at the cap — a stalled tick's worst case.
    for (let i = 0; i < 2000; i++) room.commands.push({ playerId: 'p1', msg: {} as never, at: wallMs(0) });
    const rejectedBefore = peek.ops.msgsRejected;

    gs.onMessage(ws as never, JSON.stringify({ type: 'chat', text: 'flood' }));

    expect(room.commands.length).toBe(2000);
    expect(peek.ops.msgsRejected).toBe(rejectedBefore + 1);
  });

  it('still accepts messages while under the cap', async () => {
    gs = new GameServer();
    (gs as unknown as { tickLoop: { stop(): void } }).tickLoop.stop();
    const peek = gs as unknown as Peek;

    const ws = fakeWs();
    gs.onOpen(ws as never);
    gs.onMessage(ws as never, JSON.stringify({ type: 'join', playerId: 'p1', room: 'default', mode: 'dm' }));
    await (peek.rooms.get('default') as { terrainReady?: Promise<unknown> } | undefined)?.terrainReady;
    const room = peek.playerRoom.get('p1')!;
    const before = room.commands.length;

    gs.onMessage(ws as never, JSON.stringify({ type: 'chat', text: 'hello' }));
    expect(room.commands.length).toBe(before + 1);
  });
});
