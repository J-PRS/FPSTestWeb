import { describe, expect, it } from 'bun:test';
import { SessionManager } from '../../src/SessionManager.ts';
import { mkRoom } from './harness.ts';

// Join-guard scenarios: the handshake is the only unauthenticated surface —
// flood throttle per IP and claimed-identity tokens keep a spammer or a
// name-thief out. (Loopback is exempt by design: dev fleets join 24+/min.)

function fakeWs(ip = '10.9.9.9') {
  return {
    remoteAddress: ip,
    data: {} as { playerId?: string },
    closed: [] as { code: number; reason: string }[],
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
    }),
    playerRoom,
  };
}

const join = (mgr: SessionManager, ws: FakeWs, playerId: string, token?: string) =>
  mgr.handle(ws as never, { type: 'join', playerId, room: 't', token });

describe('join guards', () => {
  it('throttles a join flood from one IP after 5/min', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    for (let i = 0; i < 5; i++) join(mgr, fakeWs(), `flood${i}`);
    const sixth = fakeWs();
    join(mgr, sixth, 'flood6');
    expect(sixth.closed[0]?.reason).toBe('Join rate limited');
  });

  it('exempts loopback from the throttle (dev fleets)', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    for (let i = 0; i < 8; i++) join(mgr, fakeWs('127.0.0.1'), `local${i}`);
    expect(room.playerCount()).toBe(8);
  });

  it('rejects a second claim of the same playerId without the token', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const ws1 = fakeWs('10.1.1.1');
    join(mgr, ws1, 'victim'); // claims the id
    // Original gone (not in grace — fully removed) but claim persists.
    room.players.removePlayer('victim');
    const thief = fakeWs('10.2.2.2');
    join(mgr, thief, 'victim'); // no token → claim denied
    expect(thief.closed[0]?.reason).toBe('Player ID claimed');
  });

  it('rejects malformed handshakes before any state change', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const bad = fakeWs();
    mgr.handle(bad as never, { type: 'notjoin' });
    expect(bad.closed[0]?.reason).toBe('Expected join handshake');
    mgr.handle(bad as never, { type: 'join', playerId: '!!bad id!!' });
    expect(bad.closed[1]?.reason).toBe('Invalid playerId');
    expect(room.playerCount()).toBe(0);
  });
});
