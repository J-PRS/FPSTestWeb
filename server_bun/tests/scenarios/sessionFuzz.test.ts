// Session/roster lifecycle conformance fuzz — the state-machine sibling
// of wireFuzz (egress convergence) and claimsFuzz (claim authority).
//
// A seeded op stream drives the REAL GameServer socket surface in-process:
// joins, dup-joins (id theft + zombie evict), spectator seats, id-claim
// evictions, closes (stale + live), grace-period reclaims with right and
// forged tokens, kicks, room switches, and grace expiries. After every
// op the five stores must agree — that's the class of bug where one
// store updates and four don't, resurrecting ghost seats.
//
// Invariants:
//   * one seat per id: a playerId lives in at most ONE room's players
//     OR one room's spectators — never both, never two rooms
//   * playerRoom/specRooms point at the room actually holding the id
//   * connections.getConnection(id) is the LAST socket seated for it
//   * registry.state: active ⇔ connected player, grace ⇔ disconnected
//     player seat, spectating ⇔ spectator, absent ⇔ fully reaped
//   * sessionTokens only cover players still in the room
//   * the session state machine never takes an illegal edge
import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../../src/GameServer.ts';
import type { Room } from '../../src/Room.ts';
import { lcg } from './harness.ts';
import { wallMs } from '../../src/wallClock.ts';

interface FakeSock {
  data: { playerId?: string; gen?: number; posScratch?: unknown };
  remoteAddress: string;
  readyState: number;
  sent: unknown[];
  closed: { code: number; reason: string }[];
  send(d: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}
const mkSock = (): FakeSock => ({
  data: {},
  remoteAddress: '127.0.0.1', // loopback is join-throttle exempt — a fuzz IS a join storm
  readyState: 1,
  sent: [],
  closed: [],
  send(d: string | ArrayBuffer) { this.sent.push(typeof d === 'string' ? JSON.parse(d) : d); },
  close(code = 1000, reason = '') { this.closed.push({ code, reason }); },
});

interface Peek {
  rooms: Map<string, Room>;
  playerRoom: Map<string, Room>;
  specRooms: Map<string, Room>;
  registry: {
    state(id: string): string | undefined;
    gen(id: string): number | undefined;
    metrics(): { anomalies: { illegal: number; rebegin: number; seatWithoutBegin: number; reclaimNonLive: number } };
  };
  roomOfPlayer(id: string): Room | undefined;
  reconnectGraceMs: number;
  tickLoop: { stop(): void };
  removePlayerCompletely(room: Room, id: string, reason: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.FPS_SOAK)('session lifecycle conformance fuzz', () => {
  let gs: GameServer | undefined;
  afterEach(() => gs?.stop());

  it('the five stores stay in agreement under lifecycle chaos', async () => {
    const SEEDS = [7, 19, 43, 59, 97];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      gs = new GameServer();
      const peek = gs as unknown as Peek;
      peek.tickLoop.stop();
      peek.reconnectGraceMs = 15; // real setTimeout — tiny so expiry ops actually fire

      const violations: string[] = [];
      const ctx = () => `seed=${seed}`;

      // Fuzz-side model: id → latest socket we hand it + room we saw it join.
      const sockets = new Map<string, FakeSock>();
      const seatKind = new Map<string, 'player' | 'spec'>();
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => `sf_${seed}_${x}`);
      const rooms = ['r1', 'r2'];

      const checkAll = (opDesc: string): void => {
        // Seat uniqueness across rooms.
        const where = new Map<string, { room: string; kind: 'player' | 'spec' }>();
        for (const [, room] of peek.rooms) {
          for (const [id, p] of room.players.getAllPlayers()) {
            // Server bots are roster players with no session - botFill
            // tops up once a human seats, and they hold no socket,
            // registry entry, or token by design.
            if (p.isBot) {continue;}
            const prev = where.get(id);
            if (prev) violations.push(`${ctx()}: ${id} in two player rosters (${prev.room}, ${room.name}) after ${opDesc}`);
            else where.set(id, { room: room.name, kind: 'player' });
          }
          for (const id of room.spectators) {
            const prev = where.get(id);
            if (prev) violations.push(`${ctx()}: ${id} double-seated (${prev.kind}@${prev.room} + spec@${room.name}) after ${opDesc}`);
            else where.set(id, { room: room.name, kind: 'spec' });
          }
        }
        // Index stores agree with rosters.
        for (const [id, room] of peek.playerRoom) {
          const w = where.get(id);
          if (!w || w.kind !== 'player' || w.room !== room.name) {
            violations.push(`${ctx()}: playerRoom[${id}]=${room.name} but roster says ${w ? `${w.kind}@${w.room}` : 'gone'} after ${opDesc}`);
          }
        }
        for (const [id, room] of peek.specRooms) {
          const w = where.get(id);
          if (!w || w.kind !== 'spec' || w.room !== room.name) {
            violations.push(`${ctx()}: specRooms[${id}]=${room.name} but roster says ${w ? `${w.kind}@${w.room}` : 'gone'} after ${opDesc}`);
          }
        }
        // Registry agreement + connection sanity + token hygiene.
        for (const [, room] of peek.rooms) {
          for (const id of room.sessionTokens.keys()) {
            if (!room.players.getPlayer(id)) violations.push(`${ctx()}: sessionToken for non-player ${id} in ${room.name} after ${opDesc}`);
          }
        }
        for (const [id, w] of where) {
          const room = [...peek.rooms.values()].find((r) => r.name === w.room)!;
          const st = peek.registry.state(id);
          const conn = room.connections.getConnection(id) as FakeSock | undefined;
          if (w.kind === 'player') {
            if (conn) {
              if (st !== 'active' && st !== 'connecting') violations.push(`${ctx()}: connected player ${id} has state=${st} after ${opDesc}`);
            } else {
              if (st !== 'grace') violations.push(`${ctx()}: disconnected player ${id} has state=${st} after ${opDesc}`);
            }
            // The seated socket must own the current generation — a
            // stale-gen socket still registered is how a dead socket's
            // close evicts a live session.
            if (conn && conn.data.gen !== undefined && conn.data.gen !== peek.registry.gen(id)) {
              violations.push(`${ctx()}: stale-gen socket seated for ${id} (gen ${conn.data.gen} vs ${peek.registry.gen(id)}) after ${opDesc}`);
            }
          } else {
            if (st !== 'spectating' && st !== 'connecting') violations.push(`${ctx()}: spectator ${id} has state=${st} after ${opDesc}`);
            if (!conn) violations.push(`${ctx()}: spectator ${id} has no connection after ${opDesc}`);
          }
        }
        // Reverse: a registry entry must correspond to a real seat.
        for (const id of ids) {
          const st = peek.registry.state(id);
          const w = where.get(id);
          if (st === 'connecting') violations.push(`${ctx()}: ${id} stuck at 'connecting' after ${opDesc}`);
          if ((st === 'active' || st === 'grace') && w?.kind !== 'player') violations.push(`${ctx()}: registry ${st} for ${id} but roster says ${w ? `${w.kind}@${w.room}` : 'gone'} after ${opDesc}`);
          if (st === 'spectating' && w?.kind !== 'spec') violations.push(`${ctx()}: registry spectating for ${id} but roster says ${w ? `${w.kind}@${w.room}` : 'gone'} after ${opDesc}`);
        }
      };

      const join = (sock: FakeSock, id: string, room: string, extra: Record<string, unknown> = {}) => {
        gs!.onMessage(sock as never, JSON.stringify({ type: 'join', playerId: id, room, ...extra }));
      };

      // Deferred seats (terrainReady) legitimately sit at 'connecting' with
      // a sessionToken but no roster entry until the field lands - the
      // stores disagree ON PURPOSE inside that window. Settle waits it out
      // before checkAll asserts agreement.
      const settle = async (id: string): Promise<void> => {
        for (let i = 0; i < 50 && peek.registry.state(id) === 'connecting'; i++) {await sleep(10);}
      };

      const OPS = 260;
      for (let op = 0; op < OPS; op++) {
        const r = rng();
        const id = ids[Math.floor(rng() * ids.length)]!;
        const roomName = rooms[Math.floor(rng() * rooms.length)]!;
        let opDesc = 'noop';

        if (r < 0.30) {
          // Join — fresh or reused id (dup-join / steal / zombie paths).
          const sock = mkSock();
          gs!.onOpen(sock as never);
          const spec = rng() < 0.15;
          // Reuse of an id with a token = reclaim attempt; the fuzz hands
          // the REAL stored token half the time, a forged one otherwise.
          const realRoom = peek.playerRoom.get(id);
          const token = realRoom && rng() < 0.5 ? realRoom.sessionTokens.get(id) : (rng() < 0.2 ? 'forged' : undefined);
          join(sock, id, roomName, { spectate: spec || undefined, token, resumeSeq: rng() < 0.4 ? Math.floor(rng() * 50) : undefined });
          opDesc = `join ${id}@${roomName}${spec ? ' spec' : ''}${token ? ' tok' : ''}`;
          await settle(id);
          // Track whichever socket actually owns the seat post-join —
          // a rejected steal attempt leaves the incumbent registered.
          const seated = (peek.playerRoom.get(id) ?? peek.specRooms.get(id))?.connections.getConnection(id) as FakeSock | undefined;
          if (seated) sockets.set(id, seated);
          const st = peek.registry.state(id);
          if (st === 'active' || st === 'spectating') seatKind.set(id, st === 'active' ? 'player' : 'spec');
        } else if (r < 0.50) {
          // Socket close — live or stale (stale = close an old socket after
          // a reclaim already re-seated the id on a new one).
          const sock = sockets.get(id);
          if (sock) { gs!.onClose(sock as never); opDesc = `close ${id}`; }
          // A second close of the same socket exercises the dead-close path.
          if (sock && rng() < 0.2) { gs!.onClose(sock as never); opDesc += ' +stale-close'; }
        } else if (r < 0.60) {
          // Kick — full teardown funnel.
          const sock = sockets.get(id);
          if (sock?.data.playerId && peek.roomOfPlayer(id)) {
            (gs as unknown as { kickPlayer(i: string): boolean }).kickPlayer(id);
            opDesc = `kick ${id}`;
          }
        } else if (r < 0.68) {
          // Room switch on a live seat — crosses room ownership.
          const sock = sockets.get(id);
          if (sock && peek.roomOfPlayer(id)) {
            const target = rooms[Math.floor(rng() * rooms.length)]!;
            gs!.onMessage(sock as never, JSON.stringify({ type: 'switchRoom', room: target }));
            opDesc = `switch ${id}→${target}`;
            await settle(id);
            if (peek.registry.state(id) === 'active') sockets.set(id, sock);
          }
        } else if (r < 0.74) {
          // Malformed traffic on whatever socket is live.
          const sock = sockets.get(id);
          if (sock) {
            const junk = rng() < 0.5 ? 'not json{{{' : JSON.stringify({ type: 'bogus', x: 1 });
            gs!.onMessage(sock as never, junk);
            opDesc = `garbage→${id}`;
          }
        } else if (r < 0.80) {
          // Idle-reap simulation: age a player's lastSeen past the cap and
          // let the room's removal path run it (mirrors the reaper's funnel).
          const room = peek.roomOfPlayer(id);
          if (room) {
            const p = room.players.getPlayer(id);
            if (p) {
              p.lastSeen = wallMs(0);
              // The tick loop is stopped; this is the same funnel the
              // real reaper calls (GameServer-level — it owns the
              // playerRoom index the room can't see).
              peek.removePlayerCompletely(room, id, 'idle');
              opDesc = `idle-reap ${id}`;
              sockets.delete(id); seatKind.delete(id);
            }
          }
        } else {
          await sleep(25); // lets armed grace timers fire between ops
          opDesc = 'wait-grace';
        }

        // Drain the command buffer manually — the tick loop is stopped.
        for (const [, room] of peek.rooms) room.drainCommands();
        checkAll(opDesc);
      }

      // Final: every seat torn down, nothing may linger.
      for (const [, room] of peek.rooms) {
        for (const [id] of room.players.getAllPlayers()) peek.removePlayerCompletely(room, id, 'teardown');
        for (const id of [...room.spectators]) (gs as unknown as { departSpectator(i: string, r: string): boolean }).departSpectator(id, 'teardown');
      }
      await sleep(30);
      const m = peek.registry.metrics();
      if (m.anomalies.illegal > 0) violations.push(`${ctx()}: ${m.anomalies.illegal} illegal session transitions`);
      if (m.anomalies.seatWithoutBegin > 0) violations.push(`${ctx()}: ${m.anomalies.seatWithoutBegin} seat-without-begin`);
      if (m.anomalies.reclaimNonLive > 0) violations.push(`${ctx()}: ${m.anomalies.reclaimNonLive} reclaim on non-live session`);
      for (const id of ids) {
        const st = peek.registry.state(id);
        if (st !== undefined) violations.push(`${ctx()}: ${id} session leaked at '${st}' after teardown`);
      }

      expect(violations).toEqual([]);
    }
  }, 60_000); // grace timers are real setTimeouts — the waits are honest
});
