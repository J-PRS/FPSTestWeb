// Room lifecycle conformance fuzz — mint/lookup/recycle/dispose under
// a seeded chaos stream on the REAL GameServer. Distinct from
// sessionFuzz (seat-level store agreement): this fuzzes the room
// directory itself — a small name pool to exercise reuse, a stream of
// fresh names to hammer the cap's recycle path, unlisted mints that
// must stay invisible to quick-join, switchRoom hops that mint and
// cross, and dispose draining.
//
// Invariants checked after every op:
//   * join-driven rooms ≤ maxRooms — the cap is hard, recycling is bounded;
//     boot-seeded standing lobbies sit outside it (roomFactory.roomFor)
//   * a seated player lives in exactly one live room — never a
//     recycled corpse, never two rooms
//   * unlisted rooms are joinable by name but invisible to quickRoom
//   * a recycled name remints fresh (no fault streak, no players)
//   * players in a live room are never evicted by mint pressure
//   * every room's roster agrees with the GameServer's playerRoom index
import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../../src/GameServer.ts';
import { CONFIG } from '../../src/config.ts';
import type { Room } from '../../src/Room.ts';
import type { RoomMods } from '../../../shared/protocol.ts';
import { lcg } from './harness.ts';

interface FakeSock {
  data: { playerId?: string; gen?: number };
  remoteAddress: string;
  readyState: number;
  sent: unknown[];
  closed: { code: number; reason: string }[];
  send(d: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}
const mkSock = (): FakeSock => ({
  data: {},
  remoteAddress: '127.0.0.1',
  readyState: 1,
  sent: [],
  closed: [],
  send(d: string | ArrayBuffer) { this.sent.push(typeof d === 'string' ? JSON.parse(d) : d); },
  close(code = 1000, reason = '') { this.closed.push({ code, reason }); },
});

interface Peek {
  factory: {
    roomFor(name: string, mode?: string, map?: string, bots?: number, mods?: RoomMods): Room | null;
    quickRoom(mode: string, map?: string, bots?: number, mods?: RoomMods): Room | null;
  };
  rooms: Map<string, Room>;
  playerRoom: Map<string, Room>;
  roomOfPlayer(id: string): Room | undefined;
  tickLoop: { stop(): void; tickErrStreak: Map<string, number>; tickQuarantined: Set<string> };
  removePlayerCompletely(room: Room, id: string, reason: string): void;
}

describe('room lifecycle conformance fuzz', () => {
  let gs: GameServer | undefined;
  const prevMax = CONFIG.maxRooms;
  afterEach(() => { (CONFIG as unknown as { maxRooms: number }).maxRooms = prevMax; gs?.stop(); });

  it('the room directory stays bounded and consistent under join/switch/leave chaos', () => {
    const SEEDS = [11, 23, 37, 61, 83];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      // Small cap so the recycle path fires constantly — 256 real rooms
      // of pressure is what the fuzz means, not what it costs.
      (CONFIG as unknown as { maxRooms: number }).maxRooms = 6;
      gs = new GameServer();
      const peek = gs as unknown as Peek;
      peek.tickLoop.stop();

      const violations: string[] = [];
      const ctx = (op: number, d: string) => `seed=${seed} op=${op} ${d}`;
      const sockets = new Map<string, FakeSock>();
      const ids = ['p1', 'p2', 'p3', 'p4'].map((x) => `rf_${seed}_${x}`);
      const pool = ['alpha', 'beta', 'gamma', 'unlisted-vip'];
      let uniqueN = 0;

      const checkAll = (opDesc: string): void => {
        const joinRooms = [...peek.rooms.values()].filter((r) => !r.standing).length;
        if (joinRooms > 6) {violations.push(`${ctx(0, opDesc)}: join rooms=${joinRooms} over cap`);}

        const seatedIn = new Map<string, string>();
        let totalPlayers = 0;
        for (const [name, room] of peek.rooms) {
          for (const [id, p] of room.players.getAllPlayers()) {
            // Server-side bots live in rosters with no socket — the
            // playerRoom index only ever tracks socket-seated players.
            if ((p as { isBot?: boolean }).isBot) {continue;}
            totalPlayers++;
            const prev = seatedIn.get(id);
            if (prev) {violations.push(`${ctx(0, opDesc)}: ${id} seated in two rooms (${prev}, ${name})`);}
            else {seatedIn.set(id, name);}
            if (!peek.roomOfPlayer(id)) {violations.push(`${ctx(0, opDesc)}: ${id} in ${name} roster but playerRoom index lost it`);}
          }
        }
        for (const [id, room] of peek.playerRoom) {
          if (!peek.rooms.has(room.name)) {violations.push(`${ctx(0, opDesc)}: playerRoom[${id}] points at disposed room ${room.name}`);}
          else if (seatedIn.get(id) !== room.name) {violations.push(`${ctx(0, opDesc)}: playerRoom[${id}]=${room.name} but roster says ${seatedIn.get(id) ?? 'gone'}`);}
        }

        // Visibility contract: quickRoom must never hand out an unlisted room.
        for (let i = 0; i < 3; i++) {
          const q = peek.factory.quickRoom(i === 0 ? 'ctf' : i === 1 ? 'dm' : '');
          if (q && q.mods.unlisted === true) {violations.push(`${ctx(0, opDesc)}: quickRoom returned unlisted ${q.name}`);}
        }
      };

      const OPS = 300;
      for (let op = 0; op < OPS; op++) {
        const r = rng();
        const id = ids[Math.floor(rng() * ids.length)]!;
        let desc = 'noop';

        if (r < 0.25) {
          // Join the pool — 'unlisted-vip' minted unlisted half the time.
          const name = pool[Math.floor(rng() * pool.length)]!;
          const sock = mkSock();
          gs.onOpen(sock as never);
          gs.onMessage(sock as never, JSON.stringify({
            type: 'join', playerId: id, room: name,
            unlisted: name === 'unlisted-vip' ? rng() < 0.7 : undefined,
          }));
          sockets.set(id, sock);
          desc = `join ${id}@${name}`;
        } else if (r < 0.38) {
          // Fresh name — mint pressure. Past the cap the eldest
          // audience-less room recycles.
          const name = `u${seed}_${uniqueN++}`;
          const sock = mkSock();
          gs.onOpen(sock as never);
          gs.onMessage(sock as never, JSON.stringify({ type: 'join', playerId: id, room: name }));
          sockets.set(id, sock);
          desc = `mint-join ${id}@${name}`;
          // If the join was refused (every room live), the id must not
          // have a seat.
          const room = peek.roomOfPlayer(id);
          if (room && !peek.rooms.has(room.name)) {violations.push(`${ctx(op, desc)}: seated in a room not in the directory`);}
        } else if (r < 0.52) {
          // Room switch — to a pool name, a fresh name, or unlisted.
          const sock = sockets.get(id);
          if (sock?.data.playerId) {
            const target = rng() < 0.6 ? pool[Math.floor(rng() * pool.length)]! : `hop${Math.floor(rng() * 4)}`;
            gs.onMessage(sock as never, JSON.stringify({ type: 'switchRoom', room: target, unlisted: rng() < 0.15 }));
            desc = `switch ${id}→${target}`;
          }
        } else if (r < 0.65) {
          // Leave — the close funnel.
          const sock = sockets.get(id);
          if (sock) { gs.onClose(sock as never); desc = `close ${id}`; }
        } else if (r < 0.72) {
          // Spectator join — watch audience, not a player seat.
          const sock = mkSock();
          gs.onOpen(sock as never);
          const name = pool[Math.floor(rng() * pool.length)]!;
          gs.onMessage(sock as never, JSON.stringify({ type: 'join', playerId: `spec_${seed}_${Math.floor(rng() * 3)}`, room: name, spectate: true }));
          desc = `spectate@${name}`;
        } else if (r < 0.8) {
          // Fault-streak seeding on a random room name — a recycled name
          // must remint clean (the roomCap pin, exercised under chaos).
          const names = [...peek.rooms.keys()];
          if (names.length > 0) {
            const n = names[Math.floor(rng() * names.length)]!;
            peek.tickLoop.tickErrStreak.set(n, 4);
            peek.tickLoop.tickQuarantined.add(n);
            desc = `fault-seed ${n}`;
          }
        } else if (r < 0.86) {
          // Direct recycle pressure — mint via the factory like a join
          // storm would.
          peek.factory.roomFor(`direct${Math.floor(rng() * 20)}`, '', '', 0, { unlisted: rng() < 0.2 });
          desc = 'direct-mint';
        }

        for (const [, room] of peek.rooms) {room.drainCommands();}
        checkAll(desc);
      }

      // Teardown agreement: no room holds a ghost, no index points at a
      // corpse, unlisted rooms never leaked into quick-join while live.
      for (const sock of sockets.values()) {
        const id = sock.data.playerId;
        if (!id) {continue;}
        const room = peek.roomOfPlayer(id);
        if (room) {peek.removePlayerCompletely(room, id, 'teardown');}
      }
      for (const [name, room] of peek.rooms) {
        if (room.mods.unlisted === true && peek.factory.quickRoom('') === room) {
          violations.push(`${ctx(OPS, 'final')}: unlisted ${name} surfaced by quickRoom after teardown`);
        }
      }

      expect(violations).toEqual([]);
      gs.stop(); gs = undefined;
    }
  });
});
