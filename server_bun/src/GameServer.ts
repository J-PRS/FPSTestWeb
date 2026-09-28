import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { Room } from './Room.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage, validatePlayerId } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import type { Heightfield } from '../../shared/heightfield.ts';
import { isWireFrame, decodePosition, encodeTickPlayer, encodeTickFrame } from '../../shared/wire.ts';
import { STATUS } from '../../shared/status.ts';
import { isPerkId, perkMods } from '../../shared/perks.ts';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';

export class GameServer {
  // One match's state per room — players land in 'default' unless the join
  // handshake names a room. Everything per-match (players, sockets, ball
  // sim, tick bookkeeping) lives inside Room; GameServer is the dispatcher.
  private rooms = new Map<string, Room>();
  private field: Heightfield | null = null; // shared across rooms
  private bunServer: Server<WebSocketData> | null = null;
  private hashTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatusLine: string = '';
  private statusRepeatCount: number = 0;

  // Tick-bandwidth metrics — aggregated per log window so we can see what
  // interest tiers + suppression are actually saving.
  private metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, windowStart: 0 };
  // Ops counters — cheap ints, read by /metrics. msgsIn counts everything
  // that passed validation; tick lag measures setInterval drift (the
  // server-clock skew that makes client replays overshoot).
  private ops = {
    startedAt: Date.now(),
    msgsIn: 0, msgsRejected: 0, joins: 0, leaves: 0,
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
            if (!room.ballSim.hasField) room.ballSim.attachField(this.field);
          }
        })
        .catch(err => logger.warn('BallSim disabled — heightmap load failed', { err: String(err) }));
    } else {
      logger.warn('BallSim disabled — not running under Bun');
    }

    this.startHashBroadcast();
    this.startTickBroadcast();
  }

  // Per-map terrain: spec.terrain names a maps/<file>.bin heightfield;
  // files are shared across rooms via this cache and attach when ready —
  // a room always plays on the default field until its own terrain lands.
  private fields = new Map<string, Promise<Heightfield | null>>();

  private loadField(file: string): Promise<Heightfield | null> {
    let p = this.fields.get(file);
    if (!p) {
      const bunFile = (globalThis as { Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } } }).Bun?.file;
      p = bunFile
        ? bunFile(join(import.meta.dir, '..', '..', 'maps', file)).arrayBuffer()
            .then(ab => BallSim.parseHeightmap(new Uint8Array(ab)))
            .catch(err => { logger.warn('map terrain load failed', { file, err: String(err) }); return null; })
        : Promise.resolve(null);
      this.fields.set(file, p);
    }
    return p;
  }

  private static readonly ROOM_NAME_RE = /^[\w-]{1,32}$/;

  // Persistent identity: playerId → HMAC(playerId, secret). A claimed id
  // can't be taken without its token; tokens survive server restarts when
  // FPS_SECRET is set (random per boot otherwise — dev default).
  private identitySecret = CONFIG.identitySecret || randomBytes(32).toString('hex');
  private claimedIdentities = new Map<string, string>();
  // Unbounded by default — a join-spam botnet would otherwise grow this
  // map forever. Past the cap, evict oldest-first (insertion order).
  private static readonly MAX_IDENTITIES = 10_000;

  // Join throttle: ip → sliding window counters. Entries age out with the
  // window so the map self-cleans.
  private joinWindows = new Map<string, { count: number; start: number }>();
  // Medkit: hp restored per broadcast tick while the mending flag is up.
  // 12 hp/s at the room's tick rate — a field patch, not a fountain.
  private static readonly MEND_HP_PER_TICK = 12 / CONFIG.tickRate;

  private static readonly JOIN_LIMIT = 5;
  private static readonly JOIN_WINDOW_MS = 60_000;

  private joinThrottleAllow(ip: string): boolean {
    // Loopback is the dev box and the pvptest harness — fleets spawn 24+
    // joins/minute legitimately. Flood control is for real traffic only.
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    const now = Date.now();
    let w = this.joinWindows.get(ip);
    if (!w || now - w.start >= GameServer.JOIN_WINDOW_MS) {
      w = { count: 0, start: now };
      this.joinWindows.set(ip, w);
    }
    return ++w.count <= GameServer.JOIN_LIMIT;
  }

  private identityToken(playerId: string): string {
    return createHmac('sha256', this.identitySecret).update(playerId).digest('base64url');
  }

  // Match journal — every win condition lands one JSON line on disk plus
  // a small in-memory ring for /matches. Append-only so a restart never
  // loses history; the ring is just a cheap read cache.
  private matchRing: ({ t: number; room: string; mode: string; winner: string; scores: Record<string, number> })[] = [];
  private recordMatchEnd(rec: {
    room: string; mode: string; winner: string; scores: Record<string, number>;
    players?: { id: string; team?: string; kills: number; deaths: number }[];
  }): void {
    const entry = { t: Date.now(), ...rec };
    this.matchRing.push(entry);
    if (this.matchRing.length > 100) this.matchRing.shift();
    try {
      const dir = join(import.meta.dir, '..', '..', 'logs');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'matches.jsonl'), JSON.stringify(entry) + '\n');
    } catch (e) {
      logger.warn('Match journal write failed', { err: String(e) });
    }
  }

  /** Recent match results — newest last. */
  listMatches(): unknown[] {
    return this.matchRing;
  }

  /** Lifetime leaderboard read off the match journal — survives restarts
   *  since matches.jsonl is append-only. Read-per-request is fine at this
   *  scale; cache it if the file ever grows past a few MB. */
  async getStats(): Promise<unknown[]> {
    interface Row { playerId: string; matches: number; wins: number; kills: number; deaths: number }
    const agg = new Map<string, Row>();
    try {
      const file = Bun.file(join(import.meta.dir, '..', '..', 'logs', 'matches.jsonl'));
      const text = await file.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec: { winner?: string; players?: { id: string; team?: string; kills?: number; deaths?: number }[] };
        try { rec = JSON.parse(line); } catch { continue; }
        for (const p of rec.players ?? []) {
          const row = agg.get(p.id) ?? { playerId: p.id, matches: 0, wins: 0, kills: 0, deaths: 0 };
          row.matches++;
          row.kills += p.kills ?? 0;
          row.deaths += p.deaths ?? 0;
          // FFA records name the player; team records name the side.
          if (rec.winner === p.id || (p.team && rec.winner === p.team)) row.wins++;
          agg.set(p.id, row);
        }
      }
    } catch { /* no journal yet — empty leaderboard */ }
    return [...agg.values()].sort((a, b) => b.wins - a.wins || b.kills - a.kills);
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation — the first joiner defines the match. */
  private roomFor(name: string, mode = ''): Room {
    let room = this.rooms.get(name);
    if (!room) {
      const spec = this.loadMapSpec(name) ?? this.loadMapSpec(mode);
      room = new Room(name, this.field, mode, spec);
      room.onMatchEnd = (rec) => this.recordMatchEnd(rec);
      if (spec?.terrain) {
        const r = room;
        this.loadField(spec.terrain).then(f => { if (f && this.rooms.get(name) === r) r.ballSim.attachField(f); });
      }
      this.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    }
    return room;
  }

  /** maps/<name>.json at repo root — a missing or malformed file just
   *  means "default match rules", not an error. roomFor also tries the
   *  mode name so ad-hoc rooms like 'ctf-2' inherit ctf.json's rules. */
  private loadMapSpec(name: string): MapSpec | undefined {
    if (!name) return undefined;
    try {
      const path = `${import.meta.dir}/../../maps/${name}.json`;
      // readFileSync keeps roomFor synchronous — map files are tiny and
      // loaded once per room lifetime.
      const raw = readFileSync(path, 'utf8');
      const spec = resolveMapSpec(JSON.parse(raw));
      logger.info('Map spec loaded', { room: name, path });
      return spec;
    } catch {
      return undefined;
    }
  }

  /** Quick-join: pick the emptiest open room already running `mode`,
   *  else spin up `<mode>-N`. Mode '' matches any mode-less arena. */
  quickRoom(mode: string): Room {
    let best: Room | undefined;
    for (const room of this.rooms.values()) {
      if (room.mode !== mode || room.playerCount() >= CONFIG.maxPlayers) continue;
      if (!best || room.playerCount() < best.playerCount()) best = room;
    }
    if (best) return best;
    let n = 1;
    while (this.rooms.has(`${mode || 'arena'}-${n}`)) n++;
    return this.roomFor(`${mode || 'arena'}-${n}`, mode);
  }

  // playerId → room index: the binary position path calls this at 20Hz per
  // player, so scanning this.rooms per frame doesn't scale. Kept in sync at
  // join/addPlayer and every removal (close/grace/kick/idle paths all funnel
  // through removePlayerCompletely or onClose).
  private playerRoom = new Map<string, Room>();

  private roomOfPlayer(playerId: string): Room | undefined {
    return this.playerRoom.get(playerId);
  }

  /** Spectator sockets aren't players — roomOfPlayer can't find them. */
  private specRooms = new Map<string, Room>();

  onOpen(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('WebSocket connection opened', { remoteAddress: ws.remoteAddress });
  }

  onMessage(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer): void {
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

    this.handleGameMessage(room, existingPlayerId, raw);
  }

  private reconnectGraceMs = CONFIG.reconnectGraceMs; // Grace period for F5 reconnect
  private static readonly IDLE_KICK_MS = CONFIG.idleKickMs; // silent >60s → remove

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
      players: r.playerCount(),
      maxPlayers: CONFIG.maxPlayers,
      spectators: r.spectators.size || undefined,
      // Live match state so the lobby row shows more than occupancy.
      scores: r.modeSpec?.teams ? { ...r.scores } : undefined,
      ffaLeader: r.modeSpec?.ffa
        ? [...r.ffaScores.entries()].sort((a, b) => b[1] - a[1])[0]
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
    const spec = this.loadMapSpec(name);
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
      gracePending: r.disconnected.size,
      ballSimNow: r.ballSim.simNow,
    }));
    return {
      uptimeS,
      players: this.totalPlayers(),
      rooms,
      joins: o.joins,
      leaves: o.leaves,
      msgsIn: o.msgsIn,
      msgsRejected: o.msgsRejected,
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
    this.stopHashBroadcast();
    this.stopTickBroadcast();
    if (this.bunServer) {
      this.bunServer.stop(true);
      logger.info('Server stopped');
    }
  }

  private handleHandshake(ws: ServerWebSocket<WebSocketData>, raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) {
      ws.close(1008, 'Invalid handshake');
      return;
    }

    const handshake = raw as Record<string, unknown>;
    if (handshake.type !== 'join') {
      ws.close(1008, 'Expected join handshake');
      return;
    }
    const playerIdResult = validatePlayerId(handshake.playerId);
    if (!playerIdResult.success) {
      logger.warn('Invalid playerId rejected', { error: playerIdResult.error });
      ws.close(1008, 'Invalid playerId');
      return;
    }

    const playerId = playerIdResult.data;

    // Join flood guard: joins bypass the per-player RateLimiter (they ARE
    // the registration), so throttle by source IP — 5 joins/min is generous
    // for humans, lethal for a spammer script.
    if (!this.joinThrottleAllow(ws.remoteAddress)) {
      logger.warn('Join flood rejected', { ip: ws.remoteAddress });
      ws.close(1013, 'Join rate limited');
      return;
    }

    const token = typeof handshake.token === 'string' ? handshake.token : undefined;
    const roomName = typeof handshake.room === 'string' && GameServer.ROOM_NAME_RE.test(handshake.room)
      ? handshake.room
      : 'default';

    // A reclaim must land in the room the session was in — find by playerId
    // rather than trusting the claimed room (reconnecting to a different
    // room mid-grace would orphan the slot in the old room).
    const reclaimRoom = this.roomOfPlayer(playerId);
    if (reclaimRoom) {
      const existingPlayer = reclaimRoom.players.getPlayer(playerId);
      const disconnected = reclaimRoom.disconnected.get(playerId);
      if (existingPlayer && disconnected) {
        // Session reclaim requires the server-issued token — bare playerId
        // knowledge must not be enough to steal a slot
        if (token !== reclaimRoom.sessionTokens.get(playerId)) {
          logger.warn('Reconnect rejected: bad session token', { playerId });
          ws.close(1008, 'Invalid session token');
          return;
        }
        // Cancel grace period removal, reconnect with existing state
        clearTimeout(disconnected.timeout);
        reclaimRoom.disconnected.delete(playerId);

        ws.data.playerId = playerId;
        reclaimRoom.connections.register(playerId, ws);
        reclaimRoom.messages.handleHandshake(playerId, undefined, true);
        // Disconnect cancelled any pending respawn — if they come back dead,
        // re-arm it or the restored corpse stays dead forever
        reclaimRoom.messages.onPlayerReconnected(playerId);

        logger.info('Player reconnected within grace period, state restored', { playerId, room: reclaimRoom.name, health: existingPlayer.health, pos: existingPlayer.position });
        return;
      }

      logger.warn('Duplicate playerId rejected', { playerId });
      ws.close(1008, 'Player ID already connected');
      return;
    }

    const roomMode = typeof handshake.mode === 'string' && GameServer.ROOM_NAME_RE.test(handshake.mode)
      ? handshake.mode
      : '';
    const room = this.roomFor(roomName, roomMode);

    // Watch-only join: `spectate: true` registers the socket for this
    // room's broadcasts + tick stream without spawning a player — no
    // roster entry, no team, no idle-reap, no slot in the match.
    if (handshake.spectate === true) {
      if (room.spectators.size >= CONFIG.maxPlayers) {
        ws.close(1013, 'Spectators full');
        return;
      }
      ws.data.playerId = playerId;
      room.spectators.add(playerId);
      this.specRooms.set(playerId, room);
      room.connections.register(playerId, ws);
      room.messages.handleSpectatorHandshake(playerId);
      this.ops.joins++;
      logger.info('Spectator joined', { playerId, room: room.name });
      return;
    }

    // Two caps: the room's own seat count and the process-wide budget —
    // rooms share one core, so total bodies is the number that matters
    // for latency, not per-room occupancy.
    if (room.playerCount() >= CONFIG.maxPlayers ||
        (CONFIG.globalMaxPlayers > 0 && this.totalPlayers() >= CONFIG.globalMaxPlayers)) {
      ws.close(1013, 'Server full');
      return;
    }

    // Claimed identity: a taken name needs its HMAC token, or the claimer
    // and the claimant get rejected — no stealing by knowing the id.
    const claimed = this.claimedIdentities.get(playerId);
    const idToken = this.identityToken(playerId);
    if (claimed && claimed !== token) {
      logger.warn('Join rejected: claimed playerId, bad token', { playerId });
      ws.close(1008, 'Player ID claimed');
      return;
    }
    if (!claimed) {
      if (this.claimedIdentities.size >= GameServer.MAX_IDENTITIES) {
        // Map iterates insertion-ordered — dropping the first half evicts
        // the stalest claims in one pass.
        const it = this.claimedIdentities.keys();
        for (let i = 0; i < GameServer.MAX_IDENTITIES / 2; i++) {
          const k = it.next().value;
          if (k === undefined) break;
          this.claimedIdentities.delete(k);
        }
      }
      this.claimedIdentities.set(playerId, idToken);
    }

    ws.data.playerId = playerId;
    const sessionToken = idToken;
    room.sessionTokens.set(playerId, sessionToken);
    room.players.addPlayer(playerId, room.nextTeam(), isPerkId(handshake.perk) ? handshake.perk : 'none');
    this.playerRoom.set(playerId, room);
    room.connections.register(playerId, ws);
    room.messages.handleHandshake(playerId, sessionToken);
    this.ops.joins++;

    logger.info('Player connected', { playerId, room: room.name, total: room.playerCount() });
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

  private startHashBroadcast(): void {
    this.hashTimer = setInterval(() => {
      for (const room of this.rooms.values()) {
        const playerCount = room.playerCount();
        if (playerCount === 0) continue;

        room.tickSeq++;
        const hash = this.computeStateHash(room);
        const timestamp = Date.now();

        room.broadcast({
          type: 'stateHash',
          hash,
          tick: room.tickSeq,
          playerCount,
          timestamp,
        });

        // Periodic status summary - suppress duplicates, batch with count
        const players = room.players.getAllPlayers();
        const summary = Array.from(players.entries()).map(([id, p]) =>
          `${id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`
        ).join(' | ');
        const statusLine = `Status [${room.name} · ${playerCount} players] ${summary}`;

        if (statusLine === this.lastStatusLine) {
          this.statusRepeatCount++;
        } else {
          if (this.statusRepeatCount > 0) {
            logger.info(`${this.lastStatusLine} [x${this.statusRepeatCount + 1}]`);
            this.statusRepeatCount = 0;
          }
          logger.info(statusLine);
          this.lastStatusLine = statusLine;
        }

        logger.debug('State hash broadcast', { room: room.name, tick: room.tickSeq, hash, playerCount });
      }
    }, CONFIG.hashBroadcastIntervalMs);
  }

  private stopHashBroadcast(): void {
    if (this.hashTimer) {
      clearInterval(this.hashTimer);
      this.hashTimer = null;
    }
  }

  private startTickBroadcast(): void {
    this.tickTimer = setInterval(() => {
      const now0 = Date.now();
      // Tick lag: how late this interval fired vs the nominal 50ms cadence.
      // Sustained lag = sim clock drifts behind wall time — the skew that
      // pushes client ball replays ahead of authority.
      if (this.ops.lastTickAt > 0) {
        const lag = now0 - this.ops.lastTickAt - 50;
        this.ops.tickLagMsSum += lag;
        this.ops.tickLagSamples++;
        if (lag > this.ops.tickLagMsMax) this.ops.tickLagMsMax = lag;
      }
      this.ops.lastTickAt = now0;

      for (const room of this.rooms.values()) {
        // Empty named rooms are teardown: the sim timer + entry would leak
        // per room name otherwise. 'default' is immortal.
        if (room.empty && room.name !== 'default') {
          room.dispose();
          this.rooms.delete(room.name);
          logger.info('Room disposed', { room: room.name });
          continue;
        }
        room.checkMatchClock(now0);
        // Hibernation: nobody watching → freeze ball sim + skip the whole
        // room tick. Bots alone don't count as an audience — they exist
        // to serve humans, and a bot-only 'default' would otherwise sim
        // forever. A rejoining human wakes the room instantly.
        const audience = room.players.getHumanCount() > 0 || room.spectators.size > 0;
        room.ballSim.dormant = !audience;
        if (!audience) continue;
        const players = room.players.getAllPlayers();
        if (players.size === 0) continue;
        this.tickRoom(room, players, now0);
      }
    }, 50); // 20Hz tick broadcast
  }

  private tickRoom(room: Room, players: ReturnType<Room['players']['getAllPlayers']>, now0: number): void {

      // Server sims move first — bot/flag writes land in this tick's
      // records below.
      for (const sim of room.sims) sim.tick(0.05);

      // Batch all player updates into one message with delta compression.
      // Binary records are pre-encoded ONCE per tick — the per-recipient
      // fan-out just concatenates buffers (no JSON.stringify, no filter
      // object churn). internalId isn't in the wire format — clients get
      // it once via gameState/playerJoined and keep it on the roster.
      const records: Array<{ playerId: string; data: Uint8Array; pos: { x: number; y: number; z: number }; force: boolean }> = [];

      for (const [playerId, p] of players) {
        // Delta compression: skip if position hasn't changed significantly
        // Threshold: 0.1m movement or 0.02rad rotation
        const now = now0;
        // Idle reaper: silent for >60s → not a player anymore, drop the slot.
        // Grace-period entries are owned by their removal timeout — reaping
        // them here double-removes (double playerLeft broadcast).
        if (room.disconnected.has(playerId)) continue;
        const silenceMs = now - p.lastSeen;
        if (!p.isBot && silenceMs > GameServer.IDLE_KICK_MS) {
          const ws = room.socketOf(playerId);
          if (ws && ws.readyState === 1) {
            ws.close(1000, 'idle'); // triggers onClose → grace cleanup
          } else {
            this.removePlayerCompletely(room, playerId, 'idle');
          }
          logger.info('Idle player removed', { playerId, silenceMs });
          this.metrics.recordsIdleReaped++;
          continue;
        }
        // Silent sockets (backgrounded tabs) get no regular updates — but a
        // low-rate heartbeat keeps clients' stored state (health, isDead)
        // converged; otherwise a stale player's fields desync permanently
        // while the state hash still counts them. Gated on THAT player's
        // lastSent, not a shared clock — a single shared timestamp meant
        // only the first stale player in map order ever heartbeat.
        // Health channels the server owns: medkit channel (flag) and
        // regenerator perk (passive). Both cap at the player's perk max.
        if (!p.isDead && p.health < p.maxHealth) {
          let heal = 0;
          if (p.status & STATUS.MEND) heal += MEND_HP_PER_TICK;
          heal += perkMods(p.perk).regen / CONFIG.tickRate;
          if (heal > 0) p.health = Math.min(p.maxHealth, p.health + heal);
        }
        const isStale = silenceMs > 5000;
        const forceSend = now < p.forceSendUntil;
        const lastSent = room.lastSentPositions.get(playerId);
        if (isStale && lastSent && now - lastSent.t < 2000) continue;
        if (lastSent && !forceSend) {
          const elapsed = (now - lastSent.t) / 1000;
          // Suppression: if reported state still matches where the clients'
          // dead reckoning would put them (linear extrapolation of the last
          // sent pos+vel), the update carries no new information — skip it.
          // Constant-velocity skiers extrapolate perfectly; error appears
          // only on direction change, bounded by the tolerance.
          const ex = lastSent.x + lastSent.vx * elapsed;
          const ey = lastSent.y + lastSent.vy * elapsed;
          const ez = lastSent.z + lastSent.vz * elapsed;
          const dx = p.position.x - ex;
          const dy = p.position.y - ey;
          const dz = p.position.z - ez;
          const predErrSq = dx * dx + dy * dy + dz * dz;
          const yawDiff = Math.abs(p.rotation.yaw - lastSent.yaw);
          const pitchDiff = Math.abs(p.rotation.pitch - lastSent.pitch);
          // State fields (health/death/ski) must never be eaten by the
          // position check — a flag change forces the record even when the
          // player hasn't moved.
          const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski || p.status !== lastSent.status;
          // Idle players still heartbeat at 4Hz — a >300ms silence would
          // trigger client-side dead reckoning on a stationary player
          if (!stateChanged && predErrSq < 0.09 && yawDiff < 0.02 && pitchDiff < 0.03 && now - lastSent.t < 250) {
            this.metrics.recordsSuppressed++;
            continue; // Skip — within extrapolation tolerance
          }
        }
        room.lastSentPositions.set(playerId, {
          x: p.position.x, y: p.position.y, z: p.position.z,
          vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z,
          yaw: p.rotation.yaw, pitch: p.rotation.pitch,
          hp: p.health, dead: p.isDead, ski: p.skiing, status: p.status, t: now,
        });

        records.push({
          playerId,
          data: encodeTickPlayer({
            playerId,
            position: p.position,
            rotation: p.rotation,
            velocity: p.velocity,
            health: p.health,
            isDead: p.isDead,
            // Only advertise a proven ping — stale heartbeats above would
            // otherwise broadcast the default 0 for ghosts that never
            // reported (renders them with a bogus "0ms" ping).
            ping: p.ping > 0 ? p.ping : undefined,
            ski: p.skiing,
            status: p.status,
          }),
          pos: p.position,
          force: forceSend,
        });
        this.metrics.recordsBuilt++;
      }

      room.tickSeq++;
      this.metrics.ticks++;

      if (records.length > 0) {
        // Interest management: distance-tiered update rate per recipient.
        // <150m (engagement range) every tick · <400m half rate · beyond 1/10.
        // Hits/kills travel on reliable events, so stale far ghosts only
        // lose smoothness on targets that are visually specks anyway.
        // Precompute per-record tier phases once per tick (tier depends on
        // recipient distance, so the O(n²) check stays — but only the cheap
        // distance math; encode was already done once per record above).
        const seq = room.tickSeq;
        for (const [recipientId, rp] of players) {
          // Grace-period entries have no socket — record filtering for them
          // is wasted work
          if (room.disconnected.has(recipientId)) continue;
          const rx = rp.position.x, ry = rp.position.y, rz = rp.position.z;
          const others: Uint8Array[] = [];
          for (const r of records) {
            if (r.playerId === recipientId) continue;
            const dx = r.pos.x - rx;
            const dy = r.pos.y - ry;
            const dz = r.pos.z - rz;
            const dSq = dx * dx + dy * dy + dz * dz;
            const tier = dSq < 22500 ? 1 : dSq < 160000 ? 2 : 10; // 150m / 400m
            // force = hit/knockback window: real positions must reach every
            // observer at full rate while they extrapolate the knockback
            if (r.force || seq % tier === 0) others.push(r.data);
            else this.metrics.recordsTierSkipped++;
          }
          if (others.length === 0) continue;
          const frame = encodeTickFrame(
            room.players.getLastSeq(recipientId),
            others,
          );
          this.metrics.recordsSent += others.length;
          this.metrics.bytesSent += frame.byteLength;
          room.connections.sendBinaryToPlayer(recipientId, frame);
        }
        // Spectators have no viewpoint for interest tiers — they get the
        // full record set every tick.
        if (room.spectators.size > 0) {
          const frame = encodeTickFrame(room.tickSeq, records.map(r => r.data));
          this.metrics.bytesSent += frame.byteLength * room.spectators.size;
          for (const id of room.spectators) room.connections.sendBinaryToPlayer(id, frame);
        }
      }

      // Metrics rollup every 10s while anyone's connected — answers "what
      // did the optimization buy" with real numbers instead of estimates
      const m = this.metrics;
      if (m.windowStart === 0) m.windowStart = now0;
      if (now0 - m.windowStart > 10000) {
        const secs = (now0 - m.windowStart) / 1000;
        logger.info('Tick bandwidth', {
          kbpsDownTotal: +(m.bytesSent * 8 / 1000 / secs).toFixed(1),
          recordsPerSec: +(m.recordsSent / secs).toFixed(0),
          suppressedPerSec: +(m.recordsSuppressed / secs).toFixed(0),
          tierSkippedPerSec: +(m.recordsTierSkipped / secs).toFixed(0),
          players: players.size,
        });
        m.ticks = m.recordsBuilt = m.recordsSuppressed = m.recordsIdleReaped =
          m.recordsSent = m.recordsTierSkipped = m.bytesSent = 0;
        m.windowStart = now0;
      }
  }

  private stopTickBroadcast(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private computeStateHash(room: Room): string {
    // Rolling FNV over quantized state — no sort, no string join. Player
    // ids hash first so membership changes can't alias. (Order-insensitive
    // on purpose: iteration order can differ across a reconnect.)
    let h = 0x811c9dc5;
    for (const [id, p] of room.players.getAllPlayers()) {
      for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0;
      }
      for (const v of [
        Math.round(p.position.x), Math.round(p.position.y), Math.round(p.position.z),
        Math.round(p.health), p.isDead ? 1 : 0,
      ]) {
        h ^= v & 0xffff; h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h.toString(16);
  }
}
