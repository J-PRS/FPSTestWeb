import { simMs } from './simClock.ts';
import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { Room } from './Room.ts';
import { totalPlayers as opsTotalPlayers, getServerInfo as opsGetServerInfo, getHealthStatus as opsGetHealthStatus, getMetrics as opsGetMetrics } from './serverOps.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage } from './wire.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import type { Heightfield } from '../../shared/heightfield.ts';
import { isWireFrame, decodePosition } from '../../shared/wire.ts';
import { TickLoop } from './TickLoop.ts';
import { evictEldest } from './evictEldest.ts';
import { SessionManager } from './SessionManager.ts';
import { MapCatalog } from './mapCatalog.ts';
import { RoomFactory } from './roomFactory.ts';
import { MatchJournal } from './matchJournal.ts';
import { RoomSwitcher } from './roomSwitch.ts';
import { SessionRegistry } from './sessionRegistry.ts';
import { wallNow } from './wallClock.ts';
import type { TeamId } from '../../shared/teams.ts';

interface RestoreSeat {
  id: string; name?: string; team?: TeamId; perk?: string; armorClass?: string;
  pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number };
  yaw?: number; pitch?: number; health?: number; isDead?: boolean; token: string;
}

interface RestoreRoom {
  name: string; mode?: string; map?: string; bots?: number; unlisted?: boolean;
  players: RestoreSeat[];
}

interface RestoreState { v: 1; rooms: RestoreRoom[] }

export class GameServer {
  // One match's state per room — players land in 'default' unless the join
  // handshake names a room. Everything per-match (players, sockets, ball
  // sim, tick bookkeeping) lives inside Room; GameServer is the dispatcher.
  rooms = new Map<string, Room>();
  private field: Heightfield | null = null; // shared across rooms
  private bunServer: Server<WebSocketData> | null = null;
  readonly tickLoop: TickLoop;
  readonly sessions: SessionManager;
  /** Session lifecycle state machine — every connect/seat/grace/reap
   *  decision funnels through here (see sessionRegistry.ts). */
  readonly registry = new SessionRegistry();
  private readonly maps = new MapCatalog();
  private readonly factory: RoomFactory;
  private readonly switcher: RoomSwitcher;

  // Ops counters — cheap ints, read by /metrics. msgsIn counts everything
  // that passed validation; tick lag measures setInterval drift (the
  // server-clock skew that makes client replays overshoot).
  ops = {
    startedAt: wallNow(),
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
            // The creature sim rides the same field — it sits dead
            // without it (step() early-returns on !field).
            if (!room.creatureSim.hasField) room.creatureSim.attachField(this.field);
            // moveSim + projectiles got null at construction the same
            // way — without this their seats sit in pendingTrack forever:
            // no reconcile, no transit channel, no corrections for anyone
            // who joined before the heightmap read resolved.
            if (!room.moveSim.hasField) room.moveSim.attachField(this.field, (pid) => room.players.getPlayer(pid)?.position);
            room.projectiles.attachField(this.field);
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
      roomFor: (n, m, mp, b, u) => this.factory.roomFor(n, m, mp, b, u),
      roomOfPlayer: (id) => this.roomOfPlayer(id),
      totalPlayers: () => opsTotalPlayers(this),
      ops: this.ops,
      registry: this.registry,
      departSpectator: (id, reason, closeCode) => this.departSpectator(id, reason, closeCode),
    });
    this.factory = new RoomFactory({
      rooms: this.rooms,
      sessions: this.registry,
      maps: this.maps,
      field: () => this.field,
      recordEnd: (rec) => this.journal.recordEnd(rec),
      kickPlayer: (pid) => this.kickPlayer(pid),
      forgetRoom: (name) => this.tickLoop.forgetRoom(name),
    });
    this.switcher = new RoomSwitcher({
      roomOfPlayer: (id) => this.roomOfPlayer(id),
      roomFor: (n, m, mp, b, u) => this.factory.roomFor(n, m, mp, b, u),
      removePlayerCompletely: (r, id, reason) => this.removePlayerCompletely(r, id, reason),
      totalPlayers: () => opsTotalPlayers(this),
      specRooms: this.specRooms,
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

  quickRoom(mode: string, map = '', bots?: number): Room | null {
    return this.factory.quickRoom(mode, map, bots);
  }

  /** Route guard: does maps/<name>.json resolve? The catalog negative-
   *  caches misses, so a bogus-name flood costs a Map get, not a disk
   *  read + a throwaway Room per request. */
  hasMap(name: string): boolean { return this.maps.has(name); }

  listMaps(): { name: string; mode: string; modes: string[]; bots: number; t2: boolean }[] {
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
    }, CONFIG.joinTimeoutMs).unref?.();
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
          // Same containment as the JSON lane — a throwing handler drops
          // this socket, not the process.
          try {
            this.handleGameMessage(room, existingId, pos);
          } catch (e) {
            logger.error('Message handler failed', { playerId: existingId, type: 'position(binary)', err: e instanceof Error ? e.stack ?? e.message : String(e) });
            try { ws.close(1011, 'server error'); } catch { /* socket already dying */ }
          }
        }
        return;
      }
      this.invalidWarn(ws.data.playerId, 'Unknown binary frame rejected');
      return;
    }
    const text = message;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.invalidWarn(ws.data.playerId, 'Failed to parse JSON');
      return;
    }

    const existingPlayerId = ws.data.playerId;
    if (existingPlayerId && this.specRooms.has(existingPlayerId)) return; // spectators are read-only
    const room = existingPlayerId ? this.roomOfPlayer(existingPlayerId) : undefined;

    // A bad message must only cost its own sender — anything downstream
    // that throws (handler bug, malformed fields the shape checks missed)
    // logs the player + message type and drops that socket, not the process.
    try {
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
    } catch (e) {
      const t = (raw as { type?: string })?.type ?? '?';
      logger.error('Message handler failed', { playerId: existingPlayerId, type: t, err: e instanceof Error ? e.stack ?? e.message : String(e) });
      try { ws.close(1011, 'server error'); } catch { /* socket already dying */ }
    }
  }

  private reconnectGraceMs = CONFIG.reconnectGraceMs; // Grace period for F5 reconnect

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const playerId = ws.data.playerId;
    if (!playerId) return;
    // Throttle entries keyed by playerId must die with the socket —
    // otherwise they linger until the 4096 wholesale clear, which also
    // resets the gate for live spammers.
    this.invalidWarnAt.delete(playerId);
    if (this.departSpectator(playerId, 'spectator left')) return;
    const room = this.roomOfPlayer(playerId);
    if (!room) {
      // Closed mid-handshake (connecting, never seated) — no room entry
      // exists to tear down, but the session record must not leak.
      this.registry.terminate(playerId, 'closed before seat');
      return;
    }

    // A stale socket's close must not detach a re-seated session: RTC
    // adapters close both datachannels asynchronously, so the old
    // socket's onClose can land AFTER a reclaim already handed the seat
    // to a new socket — marking a live player disconnected and flapping
    // the connection every reconnect cycle. The seat generation makes it
    // a no-op by construction; the map check stays as belt-and-suspenders
    // for sockets seated before the registry existed (adapters).
    if (room.connections.getConnection(playerId) !== ws) return;
    if (ws.data.gen !== undefined && ws.data.gen !== this.registry.gen(playerId)) return;

    // The grace countdown arms inside the session itself — reclaim and
    // terminate clear it, so the timer can't outlive the seat.
    this.registry.disconnect(playerId, 'socket closed', this.reconnectGraceMs,
      () => this.removePlayerCompletely(room, playerId, 'grace period'));
    room.connections.unregister(playerId);
    room.rateLimiter.removePlayer(playerId);
    room.messages.onPlayerDisconnected(playerId);

    logger.info('Player disconnected, grace period started', { playerId, room: room.name, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  /** Lobby listing — live matches a client can join by name. */
  listRooms() {
    return [...this.rooms.values()].filter(r => !r.unlisted).map(r => ({
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
    const spec = this.maps.reloadSpec(this.maps.mapNameOf(name) ?? name);
    if (!spec) return 'no-spec';
    room.mapSrc = this.maps.mapNameOf(name) ?? name;
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

  /** Server-browser card: what a master list / LAN browser displays per
   *  host. Cheap to poll — one row per room, no per-player data. */
  getServerInfo() { return opsGetServerInfo(this); }

  getHealthStatus() { return opsGetHealthStatus(this); }

  /** Ops snapshot for /metrics. */
  getMetrics() { return opsGetMetrics(this); }

  setBunServer(server: Server<WebSocketData>): void {
    this.bunServer = server;
  }

  /** Dev-restart seat snapshot — humans only, bots re-mint from spec.bots.
   *  Handed to the dev-watch parent (in-memory, no disk) so a respawned
   *  child can re-seat reconnecting clients where they were. */
  exportRestore(): RestoreState {
    const rooms: RestoreRoom[] = [];
    for (const room of this.rooms.values()) {
      const players: RestoreSeat[] = [];
      for (const [id, p] of room.players.getAllPlayers()) {
        if (p.isBot) continue;
        const token = room.sessionTokens.get(id);
        if (!token) continue; // pre-seat or bot — nothing to reclaim with
        players.push({
          id, name: p.name, team: p.team, perk: p.perk, armorClass: p.armorClass,
          pos: { ...p.position }, vel: { ...p.velocity },
          yaw: p.rotation.yaw, pitch: p.rotation.pitch,
          health: p.health, isDead: p.isDead, token,
        });
      }
      if (players.length) {
        rooms.push({ name: room.name, mode: room.mode, map: room.mapSrc, bots: room.spec.bots, unlisted: room.unlisted, players });
      }
    }
    return { v: 1, rooms };
  }

  /** Re-seat the exported snapshot: rebuild rooms, drop each human body
   *  back at its saved spot, park the session in grace — the client's
   *  normal reconnect then walks the existing reclaim path (token check,
   *  resumeSeq replay, respawn re-arm) untouched. */
  restoreFrom(raw: unknown): void {
    const s = raw as RestoreState | null;
    if (!s || s.v !== 1 || !Array.isArray(s.rooms)) return;
    let seated = 0;
    for (const rs of s.rooms) {
      if (!rs || typeof rs.name !== 'string' || !Array.isArray(rs.players)) continue;
      const room = this.factory.roomFor(rs.name, rs.mode ?? '', rs.map ?? '', rs.bots, rs.unlisted === true);
      if (!room) continue;
      for (const ps of rs.players) {
        if (!ps || typeof ps.id !== 'string' || typeof ps.token !== 'string') continue;
        // A corrupt blob must not seed NaN bodies into a live room.
        if (!ps.pos || !Number.isFinite(ps.pos.x) || !Number.isFinite(ps.pos.y) || !Number.isFinite(ps.pos.z)) continue;
        if (room.players.getPlayer(ps.id)) continue;
        const p = room.players.addPlayer(ps.id, ps.team, ps.perk ?? 'none', ps.armorClass ?? 'medium');
        p.position = { ...ps.pos };
        p.velocity = { ...ps.vel };
        p.rotation.yaw = ps.yaw ?? 0;
        p.rotation.pitch = ps.pitch ?? 0;
        p.lastValidPosition = { ...ps.pos };
        if (typeof ps.health === 'number') p.health = ps.health;
        p.isDead = ps.isDead === true;
        p.pendingRespawn = p.isDead;
        p.name = ps.name;
        // A mid-fight seat, not a fresh spawn — no protection bubble.
        p.protectedUntil = simMs(0);
        room.sessionTokens.set(ps.id, ps.token);
        this.playerRoom.set(ps.id, room);
        this.registry.seedGrace(ps.id, room.name, this.reconnectGraceMs,
          () => this.removePlayerCompletely(room, ps.id, 'grace period'));
        room.messages.onPlayerDisconnected(ps.id);
        seated++;
      }
      logger.info('Restored seats across restart', { room: room.name, players: rs.players.length });
    }
    if (seated) logger.info('Restart restore complete', { seats: seated });
  }

  stop(): void {
    this.tickLoop.stop();
    // Deliver real close frames first — server.stop(true) severs sockets
    // mid-flight, so without this every player sees a mystery drop on
    // both the banner and their logs rather than 'server restarting'.
    for (const room of this.rooms.values()) room.connections.closeAll(1001, 'server restarting');
    for (const room of this.specRooms.values()) room.connections.closeAll(1001, 'server restarting');
    if (this.bunServer) {
      this.bunServer.stop(true);
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    this.sessions.handle(ws, raw);
  }

  // Garbage-flood bound: every bad message is counted, but warning about
  // each one trades a wire flood for a log-IO flood — one warn per
  // player per window keeps the abuse visible without the write cost.
  private readonly invalidWarnAt = new Map<string, number>();
  private static readonly INVALID_WARN_GAP_MS = 5000;

  /** One warn per sender per window for every garbage-frame path —
   *  parse/binary rejects arrive before validation, so they share this
   *  throttle or a malformed flood bypasses the bound entirely. */
  private invalidWarn(playerId: string | undefined, msg: string, data?: Record<string, unknown>): void {
    const key = playerId ?? 'prejoin';
    const now = wallNow();
    if (now - (this.invalidWarnAt.get(key) ?? 0) >= GameServer.INVALID_WARN_GAP_MS) {
      this.invalidWarnAt.set(key, now);
      if (this.invalidWarnAt.size > 4096) evictEldest(this.invalidWarnAt);
      logger.warn(msg, { playerId, ...data });
    }
  }

  private handleGameMessage(room: Room, playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {
      this.ops.msgsRejected++;
      this.invalidWarn(playerId, 'Invalid message rejected', { room: room.name, error: result.error });
      return;
    }

    this.ops.msgsIn++;
    // Backstop bound: legit traffic is ~20 reports + a few actions per
    // player per tick (~500 for a full room) — a flooding client would
    // otherwise grow this array unboundedly between drains and stall the
    // cmd phase for everyone. Excess counts as rejected (the metric is
    // the observability surface — a per-drop log would spam, since a
    // flooded queue parks at the cap until the next drain).
    if (room.commands.length >= 2000) {
      this.ops.msgsRejected++;
      return;
    }
    // Command buffer: effects land at phase 0 of the next room tick, in
    // arrival order — sims never see a mid-frame mutation order. The
    // arrival stamp feeds the rate limiter: a stalled tick draining a
    // backlog must not count every queued report inside one window.
    room.commands.push({ playerId, msg: result.data, at: wallNow() });
  }

  // Full teardown shared by grace expiry and idle reap — the five stores
  // and the broadcast must move together or a stale slot/token leaks.
  /** Single spectator exit path — onClose and SessionManager's id-claim
   *  both route here so the room roster, connection, specRooms index and
   *  session record always die together. closeCode closes the spectator's
   *  socket first when its departure is server-initiated (id claim). */
  departSpectator(playerId: string, reason: string, closeCode?: number): boolean {
    const specRoom = this.specRooms.get(playerId);
    if (!specRoom) return false;
    if (closeCode !== undefined) specRoom.connections.getConnection(playerId)?.close(closeCode, reason);
    specRoom.spectators.delete(playerId);
    specRoom.connections.unregister(playerId);
    this.specRooms.delete(playerId);
    this.registry.terminate(playerId, reason);
    logger.info('Spectator left', { playerId, room: specRoom.name });
    return true;
  }

  private removePlayerCompletely(room: Room, playerId: string, reason: string): void {
    this.registry.terminate(playerId, reason);
    room.removePlayerCompletely(playerId, reason, (m, o) => logger.info(m, o));
    this.playerRoom.delete(playerId);
    this.ops.leaves++;
  }

}
