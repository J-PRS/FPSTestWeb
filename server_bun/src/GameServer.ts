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
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

  private static readonly ROOM_NAME_RE = /^[\w-]{1,32}$/;

  // Persistent identity: playerId → HMAC(playerId, secret). A claimed id
  // can't be taken without its token; tokens survive server restarts when
  // FPS_SECRET is set (random per boot otherwise — dev default).
  private identitySecret = CONFIG.identitySecret || randomBytes(32).toString('hex');
  private claimedIdentities = new Map<string, string>();

  private identityToken(playerId: string): string {
    return createHmac('sha256', this.identitySecret).update(playerId).digest('base64url');
  }

  /** Resolve-or-create a room. Joins may name any room; 'default' is the
   *  unnamed lobby every existing client already lands in. `mode` is only
   *  honored at creation — the first joiner defines the match. */
  private roomFor(name: string, mode = ''): Room {
    let room = this.rooms.get(name);
    if (!room) {
      const spec = this.loadMapSpec(name);
      room = new Room(name, this.field, mode, spec);
      this.rooms.set(name, room);
      logger.info('Room created', { room: name, mode: room.mode });
    }
    return room;
  }

  /** maps/<room>.json at repo root — a missing or malformed file just
   *  means "default match rules", not an error. */
  private loadMapSpec(name: string): MapSpec | undefined {
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

  /** Find which room a player lives in — used by disconnect/teardown paths
   *  where we only have the playerId. O(#rooms), and those calls are rare. */
  private roomOfPlayer(playerId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.getPlayer(playerId)) return room;
    }
    return undefined;
  }

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
    }));
  }

  private totalPlayers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.playerCount();
    return n;
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

    if (room.playerCount() >= CONFIG.maxPlayers) {
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
    if (!claimed) this.claimedIdentities.set(playerId, idToken);

    ws.data.playerId = playerId;
    const sessionToken = idToken;
    room.sessionTokens.set(playerId, sessionToken);
    const player = room.players.addPlayer(playerId);
    room.assignTeam(player);
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
        const players = room.players.getAllPlayers();
        if (players.size === 0) continue;
        this.tickRoom(room, players, now0);
      }
    }, 50); // 20Hz tick broadcast
  }

  private tickRoom(room: Room, players: ReturnType<Room['players']['getAllPlayers']>, now0: number): void {

      // Bots move first — their writes land in this tick's records below.
      room.bots.tick(0.05);
      room.tickFlags(0.05);

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
          const stateChanged = p.health !== lastSent.hp || p.isDead !== lastSent.dead || p.skiing !== lastSent.ski;
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
          hp: p.health, dead: p.isDead, ski: p.skiing, t: now,
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
        for (const [recipientId, rp] of players) {
          // Grace-period entries have no socket — record filtering for them
          // is wasted work
          if (room.disconnected.has(recipientId)) continue;
          const others: Uint8Array[] = [];
          for (const r of records) {
            if (r.playerId === recipientId) continue;
            const dx = r.pos.x - rp.position.x;
            const dy = r.pos.y - rp.position.y;
            const dz = r.pos.z - rp.position.z;
            const dSq = dx * dx + dy * dy + dz * dz;
            const tier = dSq < 22500 ? 1 : dSq < 160000 ? 2 : 10; // 150m / 400m
            // force = hit/knockback window: real positions must reach every
            // observer at full rate while they extrapolate the knockback
            if (r.force || room.tickSeq % tier === 0) others.push(r.data);
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
    const players = room.players.getAllPlayers();
    const sortedIds = Array.from(players.keys()).sort();

    const playerData = sortedIds.map(id => {
      const p = players.get(id)!;
      return `${id}:${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}:${p.health}:${p.isDead ? 1 : 0}`;
    }).join('|');

    let hash = 5381;
    for (let i = 0; i < playerData.length; i++) {
      hash = ((hash << 5) + hash) + playerData.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }
}
