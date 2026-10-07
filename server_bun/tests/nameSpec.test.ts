import { describe, expect, it } from 'bun:test';
import { SessionManager } from '../src/SessionManager.ts';
import { SessionRegistry } from '../src/sessionRegistry.ts';
import { mkRoom } from './scenarios/harness.ts';

// The display name lands verbatim in DOM text on every client (scoreboard,
// kill feed, chat) — the wire sanitize is the only scrub. If it drifts,
// control bytes or 10KB names ride gameState/playerJoined into the render
// path. Pinned at the join seam since nameSpec is private.
function fakeWs() {
  return {
    remoteAddress: '10.9.9.9',
    data: {} as { playerId?: string },
    closed: [] as unknown[],
    sent: [] as unknown[],
    send(d: string | ArrayBuffer) { this.sent.push(d); },
    close(code: number, reason: string) { this.closed.push({ code, reason }); },
  };
}
type FakeWs = ReturnType<typeof fakeWs>;

function mkSessions(room: ReturnType<typeof mkRoom>) {
  const playerRoom = new Map<string, typeof room>();
  return {
    mgr: new SessionManager({
      rooms: new Map([[room.name, room]]), playerRoom, specRooms: new Map(),
      roomFor: () => room,
      roomOfPlayer: (id) => room.players.getPlayer(id) ? room : undefined,
      totalPlayers: () => playerRoom.size,
      ops: { joins: 0, tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0 },
      registry: new SessionRegistry(),
      departSpectator: () => false,
    }),
  };
}

const joinName = (mgr: SessionManager, room: ReturnType<typeof mkRoom>, playerId: string, name: unknown) => {
  mgr.handle(fakeWs() as never, { type: 'join', playerId, room: room.name, name });
  return room.players.getPlayer(playerId)?.name;
};

describe('display-name sanitize', () => {
  it('strips control bytes and collapses whitespace', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    expect(joinName(mgr, room, 'p1', 'a\x00b\x1fc\x7f d\x9f e')).toBe('abc d e');
  });

  it('caps the wire name at 24 chars', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const n = joinName(mgr, room, 'p1', 'x'.repeat(10_000));
    expect(n).toBe('x'.repeat(24));
  });

  it('a name that sanitizes to nothing stays undefined (no empty string)', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    expect(joinName(mgr, room, 'p1', '\x00\x01   ')).toBeUndefined();
    expect(joinName(mgr, room, 'p2', 42)).toBeUndefined();
    expect(joinName(mgr, room, 'p3', undefined)).toBeUndefined();
  });
});
