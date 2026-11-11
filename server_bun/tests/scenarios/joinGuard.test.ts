import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { SessionManager } from '../../src/SessionManager.ts';
import { SessionRegistry } from '../../src/sessionRegistry.ts';
import { CONFIG } from '../../src/config.ts';
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
  const reg = new SessionRegistry();
  return {
    mgr: new SessionManager({
      rooms: new Map([[room.name, room]]), playerRoom, specRooms: new Map(),
      roomFor: () => room,
      quickRoom: () => room,
      roomOfPlayer: (id) => room.players.getPlayer(id) ? room : undefined,
      totalPlayers: () => playerRoom.size,
      ops: { joins: 0, tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0, joinWaitMsSum: 0, joinWaitMsMax: 0, joinWorkMsSum: 0, joinWorkMsMax: 0, joinN: 0 },
      registry: reg,
      departSpectator: () => false,
      removePlayerCompletely: () => undefined,
    }),
    playerRoom,
    reg,
  };
}

const join = (mgr: SessionManager, ws: FakeWs, playerId: string, token?: string) =>
  mgr.handle(ws as never, { type: 'join', playerId, room: 't', token });

// Identity rejects send sessionRejected THEN close on a flush delay —
// asserting closed[] must wait out that deferral.
const flush = () => new Promise((r) => setTimeout(r, 40));

describe('join guards', () => {
  it('throttles a join flood from one IP after the burst budget', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    // 20/min — a NAT'd household of players is legit; a script isn't.
    for (let i = 0; i < 20; i++) {join(mgr, fakeWs(), `flood${i}`);}
    const over = fakeWs();
    join(mgr, over, 'floodOver');
    expect(over.closed[0]?.reason).toBe('Join rate limited');
  });

  it('a join carrying the admin token bypasses the throttle (soak fleets)', () => {
    const orig = CONFIG.adminToken;
    (CONFIG as unknown as { adminToken: string }).adminToken = 'ops-secret';
    try {
      const room = mkRoom({}, 'tdm');
      const { mgr } = mkSessions(room);
      for (let i = 0; i < 20; i++) {join(mgr, fakeWs(), `flood${i}`);} // burn the window
      // Wrong/absent key still throttles; the real one walks through.
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'bad', room: 't', adminKey: 'nope' });
      const ok = fakeWs();
      mgr.handle(ok as never, { type: 'join', playerId: 'soaker', room: 't', adminKey: 'ops-secret' });
      expect(ok.closed).toHaveLength(0);
      expect(room.players.getPlayer('soaker')).toBeDefined();
    } finally {
      (CONFIG as unknown as { adminToken: string }).adminToken = orig;
    }
  });

  it('exempts loopback from the throttle (dev fleets)', () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    for (let i = 0; i < 8; i++) {join(mgr, fakeWs('127.0.0.1'), `local${i}`);}
    expect(room.playerCount()).toBe(8);
  });

  it('rejects a second claim of the same playerId without the token', async () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const ws1 = fakeWs('10.1.1.1');
    join(mgr, ws1, 'victim'); // claims the id
    // Original gone (not in grace — fully removed) but claim persists.
    room.players.removePlayer('victim');
    const thief = fakeWs('10.2.2.2');
    join(mgr, thief, 'victim'); // no token → claim denied
    await flush();
    expect(thief.closed[0]?.reason).toBe('Player ID claimed');
  });

  it('a rejected join leaves no registry record behind', async () => {
    const room = mkRoom({}, 'tdm');
    const { mgr, reg } = mkSessions(room);
    // Every reject path must return BEFORE registry.begin — a record
    // without a seat leaks a gen entry that never gets reaped.
    join(mgr, fakeWs(), 'victim'); // claim an id for the thief probe
    const throttled = fakeWs();
    for (let i = 0; i < 20; i++) {join(mgr, fakeWs(), `f${i}`);}
    join(mgr, throttled, 'fOver');
    room.players.removePlayer('victim');
    const thief = fakeWs('10.2.2.2');
    join(mgr, thief, 'victim');
    const bad = fakeWs('10.3.3.3');
    mgr.handle(bad as never, { type: 'notjoin' });
    await flush();
    expect(reg.state('fOver')).toBeUndefined();
    // begin() on a live id would overwrite to 'connecting' + fresh gen —
    // the denied thief must never reach it; victim's seat stays 'active'.
    expect(reg.state('victim')).toBe('active');
    expect(bad.data.playerId).toBeUndefined();
  });

  it('rejects malformed handshakes before any state change', async () => {
    const room = mkRoom({}, 'tdm');
    const { mgr } = mkSessions(room);
    const bad = fakeWs();
    mgr.handle(bad as never, { type: 'notjoin' });
    expect(bad.closed[0]?.reason).toBe('Expected join handshake');
    mgr.handle(bad as never, { type: 'join', playerId: '!!bad id!!' });
    await flush();
    expect(bad.closed[1]?.reason).toBe('Invalid playerId');
    expect(room.playerCount()).toBe(0);
  });

  // Mint denial: public deploys run FPS_CLIENT_ROOMS=0 — untrusted joins
  // may seat an EXISTING room but never conjure one (the room-count
  // side-channel under the join flood). Admin key overrides.
  describe('mint gate (FPS_CLIENT_ROOMS=0)', () => {
    const origEnv = process.env.FPS_CLIENT_ROOMS;
    const origTok = CONFIG.adminToken;
    afterEach(() => {
      if (origEnv === undefined) {delete process.env.FPS_CLIENT_ROOMS;}
      else {process.env.FPS_CLIENT_ROOMS = origEnv;}
      (CONFIG as unknown as { adminToken: string }).adminToken = origTok;
    });
    beforeEach(() => { process.env.FPS_CLIENT_ROOMS = '0'; });

    const mkMintSessions = (room: ReturnType<typeof mkRoom>) => {
      const calls = { roomFor: [] as string[], quickMint: [] as boolean[] };
      const playerRoom = new Map<string, typeof room>();
      const reg = new SessionRegistry();
      const mgr = new SessionManager({
        rooms: new Map([[room.name, room]]), playerRoom, specRooms: new Map(),
        roomFor: (n) => { calls.roomFor.push(n); return room; },
        quickRoom: (_m, _mp, _b, _mods, _ph, mm) => { calls.quickMint.push(mm ?? true); return room; },
        roomOfPlayer: (id) => room.players.getPlayer(id) ? room : undefined,
        totalPlayers: () => playerRoom.size,
        ops: { joins: 0, tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0, joinWaitMsSum: 0, joinWaitMsMax: 0, joinWorkMsSum: 0, joinWorkMsMax: 0, joinN: 0 },
        registry: reg,
        departSpectator: () => false,
        removePlayerCompletely: () => undefined,
      });
      return { mgr, calls };
    };

    it('an untrusted join naming a missing room lands elsewhere — no mint', () => {
      const room = mkRoom({}, 'tdm');
      const { mgr, calls } = mkMintSessions(room);
      // 'create params' (map) + a name the map doesn't hold = would mint.
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'u1', room: 'nope-9', map: 'dunes' });
      expect(calls.roomFor).toHaveLength(0); // never minted
      expect(calls.quickMint).toContain(false); // no-mint fallback used
      expect(room.players.getPlayer('u1')).toBeDefined(); // still seated
    });

    it('an untrusted join naming an EXISTING room reuses it', () => {
      const room = mkRoom({}, 'tdm');
      const { mgr, calls } = mkMintSessions(room);
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'u2', room: room.name, map: 'dunes' });
      expect(calls.roomFor).toEqual([room.name]); // reuse is not a mint
      expect(room.players.getPlayer('u2')).toBeDefined();
    });

    it('the admin key mints even with the gate closed', () => {
      (CONFIG as unknown as { adminToken: string }).adminToken = 'ops-secret';
      const room = mkRoom({}, 'tdm');
      const { mgr, calls } = mkMintSessions(room);
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'op1', room: 'op-9', map: 'dunes', adminKey: 'ops-secret' });
      expect(calls.roomFor).toEqual(['op-9']);
      expect(room.players.getPlayer('op1')).toBeDefined();
    });

    it('untrusted quick-joins pass mayMint=false; trusted pass true', () => {
      (CONFIG as unknown as { adminToken: string }).adminToken = 'ops-secret';
      const room = mkRoom({}, 'tdm');
      const { mgr, calls } = mkMintSessions(room);
      // Bare joins to names the map doesn't hold take the quickRoom path.
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'u3', room: 'missing' });
      mgr.handle(fakeWs() as never, { type: 'join', playerId: 'op2', room: 'missing2', adminKey: 'ops-secret' });
      expect(calls.quickMint).toEqual([false, true]);
      expect(room.players.getPlayer('u3')).toBeDefined();
      expect(room.players.getPlayer('op2')).toBeDefined();
    });
  });

  // The seat caps are the last wall between a join flood and a packed
  // process — rooms share one core, so totalPlayers is the number that
  // matters for latency. A dropped check reopens unbounded seating.
  describe('seat caps', () => {
    const origRoom = CONFIG.maxPlayers;
    const origGlobal = CONFIG.globalMaxPlayers;
    afterEach(() => {
      (CONFIG as unknown as { maxPlayers: number }).maxPlayers = origRoom;
      (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = origGlobal;
    });

    it('refuses a join past the per-room cap with 1013', () => {
      (CONFIG as unknown as { maxPlayers: number }).maxPlayers = 2;
      (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 0;
      const room = mkRoom({}, 'tdm');
      const { mgr } = mkSessions(room);
      join(mgr, fakeWs(), 'p1');
      join(mgr, fakeWs(), 'p2');
      const third = fakeWs();
      join(mgr, third, 'p3');
      expect(third.closed[0]?.reason).toBe('Server full');
      expect(room.playerCount()).toBe(2);
    });

    it('refuses a join past the global budget even with room seats free', () => {
      (CONFIG as unknown as { maxPlayers: number }).maxPlayers = 100;
      (CONFIG as unknown as { globalMaxPlayers: number }).globalMaxPlayers = 1;
      const room = mkRoom({}, 'tdm');
      const { mgr } = mkSessions(room);
      join(mgr, fakeWs(), 'p1'); // fills the global budget
      const second = fakeWs();
      join(mgr, second, 'p2');
      expect(second.closed[0]?.reason).toBe('Server full');
      expect(room.playerCount()).toBe(1);
    });
  });
});
