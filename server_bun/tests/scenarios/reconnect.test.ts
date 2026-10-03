import { describe, expect, it } from 'bun:test';
import { SessionManager } from '../../src/SessionManager.ts';
import { SessionRegistry } from '../../src/sessionRegistry.ts';
import { mkRoom } from './harness.ts';

// Reconnect (F5) flow: a dropped socket starts a grace period instead of
// killing the session; a rejoin with the right token reclaims the slot —
// same health, same position, respawn re-armed. Wrong token or a claimed
// id is rejected. Covers the gap the soak notes flagged.

function fakeWs() {
  return {
    remoteAddress: '10.0.0.1',
    readyState: 1, // OPEN — ConnectionManager's send guard requires it
    data: {} as { playerId?: string },
    closed: [] as { code: number; reason: string }[],
    sent: [] as unknown[],
    send(d: string | ArrayBuffer) { this.sent.push(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))); },
    close(code: number, reason: string) { this.closed.push({ code, reason }); },
  };
}
type FakeWs = ReturnType<typeof fakeWs>;

function mkSessions(room: ReturnType<typeof mkRoom>) {
  const rooms = new Map([[room.name, room]]);
  const playerRoom = new Map<string, typeof room>();
  const specRooms = new Map<string, typeof room>();
  const ops = { joins: 0, tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0 };
  return {
    mgr: new SessionManager({
      rooms, playerRoom, specRooms,
      roomFor: () => room,
      roomOfPlayer: (id) => rooms.has(room.name) && room.players.getPlayer(id) ? room : undefined,
      totalPlayers: () => playerRoom.size,
      ops,
      registry: new SessionRegistry(),
    }),
    playerRoom, ops,
  };
}

const join = (mgr: SessionManager, ws: FakeWs, playerId: string, token?: string, resumeSeq?: number) =>
  mgr.handle(ws as never, { type: 'join', playerId, room: 't', token, resumeSeq });

describe('grace reconnect', () => {
  it('reclaims the slot with the session token — state preserved', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr, playerRoom } = mkSessions(room);
    const ws1 = fakeWs();
    join(mgr, ws1, 'p1');
    const p = room.players.getPlayer('p1')!;
    p.health = 42;
    p.position.x = 7;
    // Socket drops → grace bookkeeping (mirrors GameServer.onClose).
    room.disconnected.set('p1', { timeout: setTimeout(() => {}, 60_000) });

    const ws2 = fakeWs();
    join(mgr, ws2, 'p1', room.sessionTokens.get('p1'));
    expect(ws2.closed.length).toBe(0);
    expect(room.disconnected.has('p1')).toBe(false); // grace cancelled
    expect(room.players.getPlayer('p1')!.health).toBe(42); // state kept
    expect(room.players.getPlayer('p1')!.position.x).toBe(7);
    // Reclaim re-seats the existing playerRoom mapping rather than
    // re-registering — the entry stays, the room is unchanged.
    expect(playerRoom.get('p1')).toBe(room);
  });

  it('rejects a reclaim with a wrong token', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    join(mgr, fakeWs(), 'p1');
    room.disconnected.set('p1', { timeout: setTimeout(() => {}, 60_000) });
    const ws2 = fakeWs();
    join(mgr, ws2, 'p1', 'forged');
    expect(ws2.closed[0]?.reason).toBe('Invalid session token');
    expect(room.disconnected.has('p1')).toBe(true); // slot still held for owner
  });

  it('rejects a duplicate id while the original is connected', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    join(mgr, fakeWs(), 'p1');
    const ws2 = fakeWs();
    join(mgr, ws2, 'p1'); // no token → fails auth, can't even probe the slot
    expect(ws2.closed[0]?.reason).toBe('Invalid session token');
  });

  it('a valid token evicts a zombie socket still holding the seat', () => {
    // RTC flap path: the old datachannel's close can lag or be lost while
    // the client has already reconnected — rejecting that join as
    // 'already connected' loops the client forever. The session token
    // proves ownership, so the stale socket is closed and re-seated.
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const ws1 = fakeWs();
    join(mgr, ws1, 'p1');
    const ws2 = fakeWs();
    join(mgr, ws2, 'p1', room.sessionTokens.get('p1'));
    expect(ws2.closed.length).toBe(0); // reclaimed, not rejected
    expect(ws1.closed[0]?.reason).toBe('replaced by reconnect'); // zombie evicted
    expect(room.connections.getConnection('p1') as unknown).toBe(ws2); // live seat is the new socket
    expect(room.disconnected.has('p1')).toBe(false); // no phantom grace entry
  });

  it('reclaim replays only the reliable frames missed since resumeSeq', () => {
    // Offset-cursor recovery: the client presents the last `ev` it
    // processed, the journal replays the gap, and gameState stays the
    // final word. Broadcasts qualify; frames aimed at others don't.
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const ws1 = fakeWs();
    join(mgr, ws1, 'p1');
    join(mgr, fakeWs(), 'p2');
    room.disconnected.set('p1', { timeout: setTimeout(() => {}, 60_000) });
    // p1's watermark: the last frame it processed before dying (gameState).
    const ev = (ws1.sent[ws1.sent.length - 1] as { ev?: number }).ev ?? 0;
    // Events that land while p1's socket is dead.
    room.connections.broadcast({ type: 'chat', playerId: 'p2', message: 'missed me?' } as never);
    room.connections.sendToPlayer('p2', { type: 'chat', playerId: 'srv', message: 'not for p1' } as never);
    const ws2 = fakeWs();
    join(mgr, ws2, 'p1', room.sessionTokens.get('p1'), ev);
    const replayed = ws2.sent.filter((m) => (m as { type?: string }).type === 'chat');
    expect(replayed.length).toBe(1);
    expect((replayed[0] as { message?: string }).message).toBe('missed me?');
  });

  it('a stale socket close is a no-op after reclaim (seat generation)', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const ws1 = fakeWs();
    join(mgr, ws1, 'p1');
    const ws2 = fakeWs();
    join(mgr, ws2, 'p1', room.sessionTokens.get('p1')); // re-seat bumps gen
    // The reclaim itself is what closed ws1 — its gen no longer matches.
    expect(ws1.closed[0]?.reason).toBe('replaced by reconnect');
    expect(room.connections.getConnection('p1') as unknown).toBe(ws2);
  });
});
