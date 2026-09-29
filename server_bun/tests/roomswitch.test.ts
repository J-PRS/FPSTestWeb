import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';

/** Minimal ServerWebSocket stand-in — captures every send so the test
 *  can assert the new room's gameState actually reached the wire. */
function fakeWs() {
  const sent: string[] = [];
  return {
    sent,
    data: {} as { playerId?: string },
    remoteAddress: '127.0.0.1',
    readyState: 1,
    send(m: string) { sent.push(m); return m.length; },
    close() { /* test double */ },
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

const gameStates = (ws: ReturnType<typeof fakeWs>) =>
  ws.sent.map((s: string) => JSON.parse(s) as { type: string; room?: string })
    .filter((m: { type: string; room?: string }) => m.type === 'gameState');

describe('switchRoom', () => {
  let gs: GameServer;
  afterEach(() => gs.stop());

  it('moves the session to the target room and answers with a fresh gameState', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'ctf-room' }));
    const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): unknown } }> }).rooms;
    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeTruthy();
    expect(gameStates(ws).at(-1)?.room).toBe('ctf-room');

    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'dm-room' }));

    expect(rooms.get('ctf-room')?.players.getPlayer('p1')).toBeUndefined();
    expect(rooms.get('dm-room')?.players.getPlayer('p1')).toBeTruthy();
    const gs2 = gameStates(ws).at(-1)!;
    expect(gs2.room).toBe('dm-room');
  });

  it('dead players cannot hop — that would dodge the respawn delay', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
    const rooms = (gs as unknown as { rooms: Map<string, { players: { getPlayer(id: string): { isDead: boolean } | undefined } }> }).rooms;
    rooms.get('a')!.players.getPlayer('p1')!.isDead = true;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    expect(rooms.get('a')?.players.getPlayer('p1')).toBeTruthy();
    expect(rooms.get('b')?.players.getPlayer('p1')).toBeUndefined();
    expect(ws.sent.some((s: string) => s.includes('matchNotice'))).toBe(true);
  });

  it('is a no-op for the current room', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1' }));
    const before = gameStates(ws).length;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'default' }));
    expect(gameStates(ws).length).toBe(before);
  });

  it('reconnect tokens survive the hop — reclaim works in the new room', () => {
    gs = new GameServer();
    const ws = fakeWs();
    gs.onMessage(ws, JSON.stringify({ type: 'join', playerId: 'p1', room: 'a' }));
    const tok = (gameStates(ws).at(-1) as unknown as { sessionToken?: string }).sessionToken;
    gs.onMessage(ws, JSON.stringify({ type: 'switchRoom', room: 'b' }));
    // Simulated socket death: the new room must accept a reclaim with the
    // same identity token it re-issued at hop time.
    (gs as unknown as { roomOfPlayer(id: string): { disconnected: Map<string, { timeout: unknown }>; sessionTokens: Map<string, string> } | undefined })
      .roomOfPlayer('p1')?.disconnected.set('p1', { timeout: setTimeout(() => {}, 60000) });
    const ws2 = fakeWs();
    gs.onMessage(ws2, JSON.stringify({ type: 'join', playerId: 'p1', token: tok }));
    expect(ws2.data.playerId).toBe('p1');
    expect(gameStates(ws2).length).toBeGreaterThan(0);
  });
});
