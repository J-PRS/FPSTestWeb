import type { ServerWebSocket, Server } from 'bun';
import { CONFIG } from './config.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { MessageHandler } from './MessageHandler.ts';
import { BallSim } from './BallSim.ts';
import { validateMessage, validatePlayerId } from './validation.ts';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import { fileURLToPath } from 'node:url';
import { isWireFrame, decodePosition, encodeTickPlayer, encodeTickFrame } from '../../shared/wire.ts';

export class GameServer {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private connectionManager: ConnectionManager;
  private messageHandler: MessageHandler;
  private ballSim: BallSim;
  private bunServer: Server<WebSocketData> | null = null;
  private hashTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCounter = 0;
  private tickSeq = 0; // monotonically increasing — drives interest-tier phasing
  private lastStatusLine: string = '';
  private statusRepeatCount: number = 0;
  private lastSentPositions: Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; t: number }> = new Map();
  private lastStaleHeartbeat = 0;
  // Tick-bandwidth metrics — aggregated per log window so we can see what
  // interest tiers + suppression are actually saving.
  private metrics = { ticks: 0, recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0, recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, windowStart: 0 };

  constructor() {
    this.playerManager = new PlayerManager();
    this.rateLimiter = new RateLimiter();
    this.connectionManager = new ConnectionManager();

    this.messageHandler = new MessageHandler(
      this.playerManager,
      this.rateLimiter,
      (msg, exclude) => this.connectionManager.broadcast(msg, exclude),
      (pid, msg) => this.connectionManager.sendToPlayer(pid, msg),
    );

    // Server-owned creatures: balls are the shared-PvE pilot. A missing
    // heightmap must degrade gracefully — log and run creature-free rather
    // than take down the whole game server.
    this.ballSim = new BallSim(this.playerManager, (msg) => this.connectionManager.broadcast(msg));
    this.messageHandler.setBallSim(this.ballSim);
    this.ballSim.start(fileURLToPath(new URL('../heightmap.bin', import.meta.url)))
      .catch(err => logger.warn('BallSim disabled — heightmap load failed', { err: String(err) }));

    this.startHashBroadcast();
    this.startTickBroadcast();
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
        if (!existingId) return; // binary before join — ignore
        const pos = decodePosition(u8);
        if (pos) {
          this.handleGameMessage(existingId, pos);
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

    if (!existingPlayerId) {
      this.handleHandshake(ws, raw);
      return;
    }

    this.handleGameMessage(existingPlayerId, raw);
  }

  private reconnectGraceMs = 10000; // Grace period for F5 reconnect
  private disconnectedPlayers: Map<string, { timeout: ReturnType<typeof setTimeout> }> = new Map();
  // playerId -> secret session token. Issued on first join, echoed in the
  // gameState response, required to reclaim a disconnected (grace-period)
  // slot — without it anyone could hijack a stale session just by knowing
  // the playerId format.
  private sessionTokens: Map<string, string> = new Map();
  private static readonly IDLE_KICK_MS = 60_000; // silent >60s → remove

  onClose(ws: ServerWebSocket<WebSocketData>): void {
    const playerId = ws.data.playerId;
    if (!playerId) return;

    this.connectionManager.unregister(playerId);
    this.rateLimiter.removePlayer(playerId);
    this.messageHandler.onPlayerDisconnected(playerId);

    // Keep player state for grace period to allow seamless F5 reconnect
    const existingTimeout = this.disconnectedPlayers.get(playerId);
    if (existingTimeout) clearTimeout(existingTimeout.timeout);

    const timeout = setTimeout(() => {
      this.disconnectedPlayers.delete(playerId);
      this.removePlayerCompletely(playerId, 'grace period');
    }, this.reconnectGraceMs);

    this.disconnectedPlayers.set(playerId, { timeout });
    logger.info('Player disconnected, grace period started', { playerId, graceMs: this.reconnectGraceMs });
  }

  onDrain(ws: ServerWebSocket<WebSocketData>): void {
    logger.debug('Backpressure drain', { playerId: ws.data.playerId });
  }

  getHealthStatus(): { status: string; players: number; maxPlayers: number; tickRate: number } {
    return {
      status: 'running',
      players: this.playerManager.getPlayerCount(),
      maxPlayers: CONFIG.maxPlayers,
      tickRate: CONFIG.tickRate,
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

    // Check for reconnect within grace period BEFORE max-players check.
    // A reconnecting player already has a slot — they should bypass the full-server check.
    const existingPlayer = this.playerManager.getPlayer(playerId);
    if (existingPlayer) {
      const disconnected = this.disconnectedPlayers.get(playerId);
      if (disconnected) {
        // Session reclaim requires the server-issued token — bare playerId
        // knowledge must not be enough to steal a slot
        if (token !== this.sessionTokens.get(playerId)) {
          logger.warn('Reconnect rejected: bad session token', { playerId });
          ws.close(1008, 'Invalid session token');
          return;
        }
        // Cancel grace period removal, reconnect with existing state
        clearTimeout(disconnected.timeout);
        this.disconnectedPlayers.delete(playerId);

        ws.data.playerId = playerId;
        this.connectionManager.register(playerId, ws);
        this.messageHandler.handleHandshake(playerId, undefined, true);
        // Disconnect cancelled any pending respawn — if they come back dead,
        // re-arm it or the restored corpse stays dead forever
        this.messageHandler.onPlayerReconnected(playerId);

        logger.info('Player reconnected within grace period, state restored', { playerId, health: existingPlayer.health, pos: existingPlayer.position });
        return;
      }

      logger.warn('Duplicate playerId rejected', { playerId });
      ws.close(1008, 'Player ID already connected');
      return;
    }

    if (this.playerManager.getPlayerCount() >= CONFIG.maxPlayers) {
      ws.close(1013, 'Server full');
      return;
    }

    ws.data.playerId = playerId;
    const sessionToken = crypto.randomUUID();
    this.sessionTokens.set(playerId, sessionToken);
    this.playerManager.addPlayer(playerId);
    this.connectionManager.register(playerId, ws);
    this.messageHandler.handleHandshake(playerId, sessionToken);

    logger.info('Player connected', { playerId, total: this.playerManager.getPlayerCount() });
  }

  private handleGameMessage(playerId: string, raw: unknown): void {
    const result = validateMessage(raw);
    if (!result.success) {
      logger.warn('Invalid message rejected', { playerId, error: result.error });
      return;
    }

    this.messageHandler.handleMessage(playerId, result.data);
  }

  // Full teardown shared by grace expiry and idle reap — the five stores
  // and the broadcast must move together or a stale slot/token leaks.
  private removePlayerCompletely(playerId: string, reason: string): void {
    this.playerManager.removePlayer(playerId);
    this.messageHandler.onPlayerRemoved(playerId);
    this.sessionTokens.delete(playerId);
    this.lastSentPositions.delete(playerId);
    this.connectionManager.broadcast({ type: 'playerLeft', playerId });
    logger.info('Player removed', { playerId, reason, remaining: this.playerManager.getPlayerCount() });
  }

  private startHashBroadcast(): void {
    this.hashTimer = setInterval(() => {
      const playerCount = this.playerManager.getPlayerCount();
      if (playerCount === 0) return;

      this.tickCounter++;
      const hash = this.computeStateHash();
      const timestamp = Date.now();

      this.connectionManager.broadcast({
        type: 'stateHash',
        hash,
        tick: this.tickCounter,
        playerCount,
        timestamp,
      });

      // Periodic status summary - suppress duplicates, batch with count
      const players = this.playerManager.getAllPlayers();
      const summary = Array.from(players.entries()).map(([id, p]) =>
        `${id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)})`
      ).join(' | ');
      const statusLine = `Status [${playerCount} players] ${summary}`;

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

      logger.debug('State hash broadcast', { tick: this.tickCounter, hash, playerCount });
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
      const players = this.playerManager.getAllPlayers();
      if (players.size === 0) return;
      const now0 = Date.now();

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
        if (this.disconnectedPlayers.has(playerId)) continue;
        const silenceMs = now - p.lastSeen;
        if (silenceMs > GameServer.IDLE_KICK_MS) {
          const ws = this.connectionManager.getConnection(playerId);
          if (ws && ws.readyState === 1) {
            ws.close(1000, 'idle'); // triggers onClose → grace cleanup
          } else {
            this.removePlayerCompletely(playerId, 'idle');
          }
          logger.info('Idle player removed', { playerId, silenceMs });
          this.metrics.recordsIdleReaped++;
          continue;
        }
        // Silent sockets (backgrounded tabs) get no regular updates — but a
        // low-rate heartbeat keeps clients' stored state (health, isDead)
        // converged; otherwise a stale player's fields desync permanently
        // while the state hash still counts them.
        const isStale = silenceMs > 5000;
        if (isStale && now - this.lastStaleHeartbeat < 2000) continue;
        const forceSend = now < p.forceSendUntil;
        const lastSent = this.lastSentPositions.get(playerId);
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
        if (isStale) this.lastStaleHeartbeat = now;
        this.lastSentPositions.set(playerId, {
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

      this.tickSeq++;
      this.metrics.ticks++;

      if (records.length > 0) {
        // Interest management: distance-tiered update rate per recipient.
        // <150m (engagement range) every tick · <400m half rate · beyond 1/10.
        // Hits/kills travel on reliable events, so stale far ghosts only
        // lose smoothness on targets that are visually specks anyway.
        for (const [recipientId, rp] of players) {
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
            if (r.force || this.tickSeq % tier === 0) others.push(r.data);
            else this.metrics.recordsTierSkipped++;
          }
          if (others.length === 0) continue;
          const frame = encodeTickFrame(
            this.playerManager.getLastSeq(recipientId),
            others,
          );
          this.metrics.recordsSent += others.length;
          this.metrics.bytesSent += frame.byteLength;
          this.connectionManager.sendBinaryToPlayer(recipientId, frame);
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
    }, 50); // 20Hz tick broadcast
  }

  private stopTickBroadcast(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private computeStateHash(): string {
    const players = this.playerManager.getAllPlayers();
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
