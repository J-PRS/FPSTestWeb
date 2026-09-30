import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { Room } from './Room.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import type { Heightfield } from '../../shared/heightfield.ts';
import { isWireFrame, decodePosition } from '../../shared/wire.ts';
import { TickLoop } from './TickLoop.ts';
import { SessionManager } from './SessionManager.ts';
import { MapCatalog } from './mapCatalog.ts';
import { RoomFactory } from './roomFactory.ts';
import { MatchJournal } from './matchJournal.ts';
import { RoomSwitcher } from './roomSwitch.ts';

export class GameServer {
  // One match's state per room — players land in 'default' unless the join
  // handshake names a room. Everything per-match (players, sockets, ball
  // sim, tick bookkeeping) lives inside Room; GameServer is the dispatcher.
  private rooms = new Map<string, Room>();
  private field: Heightfield | null = null; // shared across rooms
  private bunServer: Server<WebSocketData> | null = null;
  private readonly tickLoop: TickLoop;
  private readonly sessions: SessionManager;
  private readonly maps = new MapCatalog();
  private readonly factory: RoomFactory;
  private readonly switcher: RoomSwitcher;

  // Ops counters — cheap ints, read by /metrics. msgsIn counts everything
  // that passed validation; tick lag measures setInterval drift (the
  // server-clock skew that makes client replays overshoot).
  private ops = {
    startedAt: Date.now(),
    msgsIn: 0, msgsRejected: 0, joins: 0, leaves: 0,
    // Which netcode-v2 tier clients actually land on — the cost/perf mix
    // this deployment is paying for.
    tierWs: 0, tierWt: 0, tierRtc: 0, tierOther: 0,
    tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0,
    lastTickAt: 0,
  };

  constructor() {
    // Server-owned creatures: balls are the shared-PvE pilot. A missing
    // heightmap must degrade gracefully — log and run creature-free rather
    // than take down the whole game server. The parsed field is shared by
    // every room's BallSim rather than re-read per match.
    const heightmapPath = CONFIG.heightmapPath || fileURLToPath(new URL('../heightmap.bin', import.meta.url));
    const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
    if (bunFile) {
      bunFile(heightmapPath).arrayBuffer()
        .then(ab => {
          this.field = BallSim.parseHeightmap(new Uint8Array(ab));
          // Rooms that already exist (players joined before the load
          // finished) get the field attached now.
          for (const room of this.rooms.values()) {
            if (!room.ballSim.hasField) { room.field = this.field; room.ballSim.attachField(this.field); }
          }
        })
        .catch(err => logger.warn('BallSim disabled — heightmap load failed', { err: String(err) }));
    } else {
      logger.warn('BallSim disabled — not running under Bun');
    }

    // The broadcast engine — owns both timers; teardown delegates back
    // here so playerRoom/ops stay in one place.
    this.tickLoop = new TickLoop(this.rooms, this.ops, (room, id, reason) => this.removePlayerCompletely(room, id, reason));
    this.tickLoop.start();
    // SessionManager owns the join handshake: identity claims, join
    // throttle, grace-period reclaim, spectate.
    this.sessions = new SessionManager({
      rooms: this.rooms,
      playerRoom: this.playerRoom,
      specRooms: this.specRooms,
      roomFor: (n, m, mp, b) => this.factory.roomFor(n, m, mp, b),
      roomOfPlayer: (id) => this.roomOfPlayer(id),
      totalPlayers: () => this.totalPlayers(),
      ops: this.ops,
    });
    this.factory = new RoomFactory({
      rooms: this.rooms,
      maps: this.maps,
      field: () => this.field,
      recordEnd: (rec) => this.journal.recordEnd(rec),
      kickPlayer: (pid) => this.kickPlayer(pid),
    });
    this.switcher = new RoomSwitcher({
      roomOfPlayer: (id) => this.roomOfPlayer(id),
      roomFor: (n, m, mp, b) => this.factory.roomFor(n, m, mp, b),
      removePlayerCompletely: (r, id, reason) => this.removePlayerCompletely(r, id, reason),
      totalPlayers: () => this.totalPlayers(),
      playerRoom: this.playerRoom,
      sessions: this.sessions,
    });
  }

  // playerId → room index: the binary position path calls this at 20Hz per
  // player, so scanning this.rooms per frame doesn't scale. Kept in sync at
  // join/addPlayer and every removal (close/grace/kick/idle paths all funnel
  // through removePlayerCompletely or onClose).
  private playerRoom = new Map<string, Room>();

  private roomOfPlayer(playerId: string): Room | undefined {
    return this.playerRoom.get(playerId);
  }

  // Match history lives in MatchJournal — the ring is a read cache over
  // the append-only matches.jsonl journal.
  private readonly journal = new MatchJournal();

  /** Recent match results — newest last. */
  listMatches(): unknown[] {
    return this.journal.list();
  }

  /** Lifetime leaderboard read off the match journal — survives restarts
   *  since matches.jsonl is append-only. */
  async getStats(): Promise<unknown[]> {
    return this.journal.stats();
  }

  quickRoom(mode: string, map = '', bots?: number): Room {
    return this.factory.quickRoom(mode, map, bots);
  }

  listMaps(): { name: string; mode: string; bots: number }[] {
    return this.maps.list();
  }

  /** Spectator sockets aren't players — roomOfPlayer can't find them. */
  private specRooms = new Map<string, Room>();

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('WebSocket connection opened', { remoteAddress: ws.remoteAddress });
    // Join deadline: a socket that connects but never completes the join
    // handshake would otherwise sit forever (QUIC/RTC peers don't die on
    // their own quickly). 15s is generous — real clients join in ms.
    setTimeout(() => {
      if (!ws.data.playerId && ws.readyState === 1) ws.close(1000, 'join timeout');
    }, 15000).unref?.();
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer | Uint8Array): void {
    // Binary hot path: [0x54] magic frames skip JSON entirely.
    // Currently only `position` (28B, replaces a ~140B JSON message at 20Hz).
    if (typeof message !== 'string') {
      const u8 = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array((message as Uint8Array).buffer, (message as Uint8Array).byteOffset, (message as Uint8Array).byteLength);
      if (isWireFrame(u8)) {
        const existingId = ws.data.playerId;
        const room = existingId ? this.roomOfPlayer(existingId) : undefined;
        if (!existingId || !room) return; // binary before join — ignore
        const pos = decodePosition(u8);
        if (pos) {
          this.handleGameMessage(room, existingId, pos);
        }
        return;
      }
      logger.warn('Unknown binary frame rejected', { playerId: ws.data.playerId });
      return;
    }
    const text = message;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      logger.warn('Failed to parse JSON', { playerId: ws.data.playerId });
      return;
    }

    const existingPlayerId = ws.data.playerId;
    if (existingPlayerId && this.specRooms.has(existingPlayerId)) return; // spectators are read-only
    const room = existingPlayerId ? this.roomOfPlayer(existingPlayerId) : undefined;

    if (!existingPlayerId || !room) {
      this.handleHandshake(ws, raw);
      return;
    }

    // A room hop crosses room ownership — handle it at the dispatcher, not
    // inside one room's MessageHandler.
    const probe = raw as { type?: string };
    if (probe.type === 'switchRoom') {
      this.switcher.switchRoom(ws, existingPlayerId, raw);
      return;
    }

    this.handleGameMessage(room, existingPlayerId, raw);
  }

  private reconnectGraceMs = CONFIG.reconnectGraceMs; // Grace period for F5 reconnect

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const playerId = ws.data.playerId;
    if (!playerId) return;
    const specRoom = this.specRooms.get(playerId);
    if (specRoom) {
      specRoom.spectators.delete(playerId);
      specRoom.connections.unregister(playerId);
      this.specRooms.delete(playerId);
      logger.info('Spectator left', { playerId, room: specRoom.name });
      return;
    }
    const room = this.roomOfPlayer(playerId);
    if (!room) return;

    room.connections.unregister(playerId);
    room.rateLimiter.removePlayer(playerId);
    room.messages.onPlayerDisconnected(playerId);

    // Keep player state for grace period to allow seamless F5 reconnect
    const existingTimeout = room.disconnected.get(playerId);
    if (existingTimeout) clearTimeout(existingTimeout.timeout);

    const timeout = setTimeout(() => {
      room.disconnected.delete(playerId);
      this.removePlayerCompletely(room, playerId, 'grace period');
    }, this.reconnectGraceMs);

    room.disconnected.set(playerId, { timeout });
    logger.info('Player disconnected, grace period started', { playerId, room: room.name, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  /** Lobby listing — live matches a client can join by name. */
  listRooms() {
    return [...this.rooms.values()].map(r => ({
      name: r.name,
      mode: r.mode || undefined,
      map: this.maps.mapNameOf(r.name),
      players: r.playerCount(),
      maxPlayers: CONFIG.maxPlayers,
      spectators: r.spectators.size || undefined,
      // Live match state so the lobby row shows more than occupancy.
      scores: r.modeSpec?.teams ? { ...r.scores } : undefined,
      ffaLeader: r.modeSpec?.ffa
        ? [...r.ffaScores.entries()].toSorted((a, b) => b[1] - a[1])[0]
        : undefined,
      winAt: r.modeSpec?.winAt,
      // Lobby countdown — ms until the horn; omitted when the clock isn't armed.
      timeLeftMs: r.matchTimeLeftMs() || undefined,
    }));
  }

  // ---- Admin API ----------------------------------------------------

  /** Re-read maps/<name>.json and hot-swap it into the live room. The
   *  room keeps its mode (locked at creation) and roster; only the
   *  layout — spawns, structures, arena, ball mix, bot fill — reloads. */
  reloadRoom(name: string): 'ok' | 'no-room' | 'no-spec' {
    const room = this.rooms.get(name);
    if (!room) return 'no-room';
    // The room's name isn't always its map's (ad-hoc room names, map= pick
    // in /join, post-rotation state) — reload whatever spec it's playing.
    const spec = this.maps.loadMapSpec(this.maps.mapNameOf(name) ?? name);
    if (!spec) return 'no-spec';
    room.applySpec(spec);
    logger.info('Room spec reloaded', { room: name });
    return 'ok';
  }

  /** Boot a player out of their room — the wire sees a normal playerLeft. */
  kickPlayer(playerId: string): boolean {
    const room = this.roomOfPlayer(playerId);
    if (!room) return false;
    room.socketOf(playerId)?.close(1000, 'kicked');
    this.removePlayerCompletely(room, playerId, 'adminKick');
    logger.info('Player kicked', { playerId });
    return true;
  }

  /** End the room's current match with the standing leader (or draw). */
  forceEndMatch(roomName: string): 'ok' | 'no-room' | 'no-mode' {
    const room = this.rooms.get(roomName);
    if (!room) return 'no-room';
    return room.forceEndMatch() ? 'ok' : 'no-mode';
  }

  private totalPlayers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.playerCount();
    return n;
  }

  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll — one row per room, no per-player data. */
  getServerInfo() {
    const uptimeS = Math.floor((Date.now() - this.ops.startedAt) / 1000);
    return {
      name: CONFIG.serverName,
      region: CONFIG.serverRegion || undefined,
      tickRate: CONFIG.tickRate,
      maxPlayers: CONFIG.maxPlayers,
      players: this.totalPlayers(),
      uptimeS,
      rooms: this.listRooms(),
    };
  }

  getHealthStatus(): { status: string; players: number; maxPlayers: number; tickRate: number } {
    return {
      status: 'running',
      players: this.totalPlayers(),
      maxPlayers: CONFIG.maxPlayers,
      tickRate: CONFIG.tickRate,
    };
  }

  /** Ops snapshot for /metrics — counts since boot plus tick-lag stats,
   *  with per-room occupancy/ball counts for match-level observability. */
  getMetrics() {
    const o = this.ops;
    const uptimeS = Math.floor((Date.now() - o.startedAt) / 1000);
    const rooms = [...this.rooms.values()].map(r => ({
      name: r.name,
      players: r.playerCount(),
      balls: r.ballSim.ballCount,
      scores: r.modeSpec?.teams ? { ...r.scores } : undefined,
      pickups: r.pickups?.snapshot().length ?? 0,
      gracePending: r.disconnected.size,
      ballSimNow: r.ballSim.simNow,
      // Since-boot judge/claim counters — the room's 15s rollup clears
      // per flush, so scrapes need the cumulative mirror.
      health: Object.fromEntries(r.healthTotal),
    }));
    const mem = process.memoryUsage();
    return {
      uptimeS,
      players: this.totalPlayers(),
      memMB: {
        rss: +(mem.rss / 1048576).toFixed(1),
        heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
        heapTotal: +(mem.heapTotal / 1048576).toFixed(1),
      },
      // Last 10s tick-fanout window — null until a player has been connected
      // long enough to close one.
      bandwidth: this.tickLoop.bandwidthWindow(),
      rooms,
      joins: o.joins,
      leaves: o.leaves,
      msgsIn: o.msgsIn,
      msgsRejected: o.msgsRejected,
      tiers: { ws: o.tierWs, wt: o.tierWt, rtc: o.tierRtc, other: o.tierOther },
      tickLagMs: {
        avg: o.tickLagSamples ? +(o.tickLagMsSum / o.tickLagSamples).toFixed(2) : 0,
        max: o.tickLagMsMax,
      },
    };
  }

  setBunServer(server: Server<WebSocketData>): void {
    this.bunServer = server;
  }

  stop(): void {
    this.tickLoop.stop();
    if (this.bunServer) {
      this.bunServer.stop(true);
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    this.sessions.handle(ws, raw);
  }

  private handleGameMessage(room: Room, playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {
      this.ops.msgsRejected++;
      logger.warn('Invalid message rejected', { playerId, room: room.name, error: result.error });
      return;
    }

    this.ops.msgsIn++;
    room.messages.handleMessage(playerId, result.data);
  }

  // Full teardown shared by grace expiry and idle reap — the five stores
  // and the broadcast must move together or a stale slot/token leaks.
  private removePlayerCompletely(room: Room, playerId: string, reason: string): void {
    room.removePlayerCompletely(playerId, reason, (m, o) => logger.info(m, o));
    this.playerRoom.delete(playerId);
    this.ops.leaves++;
  }

}
