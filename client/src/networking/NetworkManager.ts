import { ChildLogger } from '../core/Logger.js';
import { isWireFrame, encodePosition, decodeTickFrame, decodeBallSegment, WIRE_BALLSEG } from '../../../shared/wire.js';
import type { ClientMessage, ServerMessage, TickUpdatePlayer, GameStatePlayer, LocalPlayerState, SnapshotPlayer } from '../../../shared/protocol.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import type { GameTransport, TransportFactory } from './transport.js';
import { NetTelemetry } from './netTelemetry.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetworkManager');

export interface RemotePlayerState {
  id: string;
  internalId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  velocity: { x: number; y: number; z: number };
  isDead: boolean;
  health: number;
  ping?: number;
  ski?: number;
  team?: 'alpha' | 'bravo';
}

/**
 * Network manager — owns the transport (WebSocketConnection) directly.
 * One transport, one protocol layer; the binary codec lives in shared/wire.ts.
 */
export class NetworkManager {
  private ws: GameTransport | null = null;
  private localPlayerId: string;
  private sessionToken: string | null;
  private connected: boolean = false;
  /** REMOTE players only — local player is never stored here */
  private players: Map<string, RemotePlayerState> = new Map();
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number, health: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onKnockback: ((position: { x: number; y: number; z: number }, force: number, pull?: boolean) => void) | null = null;
  public onChat: ((playerId: string, text: string) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number, velocity?: { x: number; y: number; z: number }) => void) | null = null;
  public onGameState: ((players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number } }) => void) | null = null;
  public onTeamScore: ((scores: { alpha: number; bravo: number }, winAt: number) => void) | null = null;
  public onMatchEnd: ((winner: 'alpha' | 'bravo', scores: { alpha: number; bravo: number }) => void) | null = null;
  public onMatchStart: ((mode: string, scores: { alpha: number; bravo: number }) => void) | null = null;
  public onSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;
  public onStateHash: ((hash: string, tick: number, playerCount: number, timestamp: number) => void) | null = null;
  public onCorrection: ((seq: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onBallSpawn: ((data: Extract<ServerMessage, { type: 'ballSpawn' }>) => void) | null = null;
  public onBallSegment: ((data: Extract<ServerMessage, { type: 'ballSegment' }>) => void) | null = null;
  public onBallDie: ((data: Extract<ServerMessage, { type: 'ballDie' }>) => void) | null = null;
  public onBallRoster: ((data: Extract<ServerMessage, { type: 'ballRoster' }>) => void) | null = null;
  public onRemoteTeleport: ((playerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  private lastPositionSendTime: number = 0;
  private readonly POSITION_SEND_INTERVAL = 50; // 20Hz — extrapolation covers the gap
  private readonly telemetry = new NetTelemetry(this.POSITION_SEND_INTERVAL);
  private hasLoggedConnectionError: boolean = false;

  // --- Client-side prediction: sequence tracking + state history ---
  private sequenceCounter: number = 0;
  private stateHistory: Map<number, { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number } }> = new Map();
  private readonly STATE_HISTORY_MAX = 120; // ~6s at 20Hz

  // --- Ping measurement ---
  private lastPingSendTime: number = 0;
  private readonly PING_INTERVAL = 2000; // Send ping every 2 seconds

  constructor() {
    // Player ID + token persist in localStorage — a claimed identity
    // survives F5, browser restarts, and (with FPS_SECRET) server restarts.
    const stored = localStorage.getItem('fps-player-id');
    if (stored) {
      this.localPlayerId = stored;
    } else {
      this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('fps-player-id', this.localPlayerId);
    }
    // Session token issued by the server on first join — required to
    // reclaim a grace-period slot after F5/reconnect
    this.sessionToken = localStorage.getItem('fps-session-token');
  }

  setPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  /** `makeTransport` swaps the wire: P2P passes a factory that builds a
   *  LoopbackTransport (host) or DataChannelTransport (guest) instead of
   *  a real WebSocket. Same callbacks, same protocol, different pipe. */
  connect(url: string, makeTransport?: TransportFactory): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const factory = makeTransport ?? ((cfg) => new WebSocketConnection(cfg));
        this.ws = factory({
          url,
          onConnect: () => {
            // Join handshake — must precede the queued-message flush,
            // which WebSocketConnection guarantees (onConnect first)
            this.send({
              type: 'join',
              playerId: this.localPlayerId,
              token: this.sessionToken ?? undefined,
              room: urlParams.room ?? undefined,
              mode: urlParams.mode ?? undefined,
            });
            this.connected = true;
            this.hasLoggedConnectionError = false;
            logger.info(`Connected as ${this.localPlayerId}`);
            resolve();
          },
          onDisconnect: (code, reason) => {
            // 1008 = server rejected our session — drop stored identity so
            // auto-reconnect joins fresh instead of looping on bad creds
            if (code === 1008) {
              localStorage.removeItem('fps-player-id');
              localStorage.removeItem('fps-session-token');
              this.sessionToken = null;
              this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
              localStorage.setItem('fps-player-id', this.localPlayerId);
              logger.info(`Session rejected (${reason}) — rejoining as ${this.localPlayerId}`);
            }
            logger.info('Disconnected');
            this.connected = false;
          },
          onError: (error) => {
            if (!this.hasLoggedConnectionError) {
              logger.error('Connection error', error);
              this.hasLoggedConnectionError = true;
            }
            reject(error);
          },
          onMessage: (data) => this.handleMessage(data),
          onBinaryMessage: (data) => this.handleBinaryMessage(data),
        });
        this.ws.connect(url);
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.ws?.disconnect();
    this.ws = null;
    this.connected = false;
  }

  /** Outbound JSON event — typed against the shared protocol union. */
  private send(msg: ClientMessage): void {
    if (!this.ws?.connected()) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Outbound binary frame — pre-encoded by shared/wire.ts. */
  private sendBinary(data: Uint8Array): void {
    if (!this.ws?.connected()) return;
    this.ws.send(data);
  }

  private handleMessage(data: ServerMessage): void {
    // Capture the server-issued session token for future reconnects
    if (data?.type === 'gameState' && typeof data.sessionToken === 'string') {
      this.sessionToken = data.sessionToken;
      localStorage.setItem('fps-session-token', data.sessionToken);
    }
    // Avoid JSON.stringify on every message — tickUpdate arrives at 20Hz
    const handler = this.handlers[data.type] as ((d: ServerMessage) => void) | undefined;
    if (handler) {
      handler(data);
    } else {
      logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  private readonly handlers: { [K in ServerMessage['type']]: (data: Extract<ServerMessage, { type: K }>) => void } = {
    gameState: (data) => this.handleGameState(data),
    tickUpdate: (data) => this.handleTickUpdate(data),
    playerJoined: (data) => this.handlePlayerJoined(data),
    playerLeft: (data) => this.handlePlayerLeft(data),
    playerRespawn: (data) => this.handlePlayerRespawn(data),
    playerHit: (data) => this.handlePlayerHit(data),
    playerKill: (data) => this.handlePlayerKill(data),
    knockback: (data) => this.onKnockback?.(data.position, data.force, data.pull),
    jump: (data) => this.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data) => this.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data) => this.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType),
    projectileDestroyed: (data) => this.onProjectileDestroyed?.(data.projectileId),
    snapshot: (data) => this.onSnapshot?.(data.players || [], data.timestamp || Date.now()),
    stateHash: (data) => this.onStateHash?.(data.hash, data.tick, data.playerCount, data.timestamp),
    correction: (data) => this.handleCorrection(data),
    teleport: (data) => this.onRemoteTeleport?.(data.playerId, data.position, data.velocity),
    ballSpawn: (data) => this.onBallSpawn?.(data),
    ballSegment: (data) => this.onBallSegment?.(data),
    ballDie: (data) => this.onBallDie?.(data),
    ballRoster: (data) => this.onBallRoster?.(data),
    pong: (data) => this.handlePong(data.timestamp),
    chat: (data) => this.onChat?.(data.playerId, data.text),
    teamScore: (data) => this.onTeamScore?.(data.scores, data.winAt),
    matchEnd: (data) => this.onMatchEnd?.(data.winner, data.scores),
    matchStart: (data) => this.onMatchStart?.(data.mode, data.scores),
  };

  private handleGameState(data: Extract<ServerMessage, { type: 'gameState' }>): void {
    // Protocol handshake: a stale bundle can't parse a new wire format —
    // force-reload once (cache-busted) instead of silently desyncing. The
    // sessionStorage counter caps it at 2 attempts so a genuinely newer
    // server can't reload-loop the tab.
    const serverProto = data.protocolVersion ?? 0;
    if (serverProto !== PROTOCOL_VERSION) {
      const tries = Number(sessionStorage.getItem('fps-proto-reload') ?? '0');
      logger.warn(`Protocol mismatch: client=${PROTOCOL_VERSION} server=${serverProto} (attempt ${tries + 1})`);
      if (tries < 2) {
        sessionStorage.setItem('fps-proto-reload', String(tries + 1));
        const url = new URL(location.href);
        url.searchParams.set('pv', String(Date.now())); // cache-buster vs CDN staleness
        location.href = url.toString();
      }
      return;
    }
    sessionStorage.removeItem('fps-proto-reload'); // clean connect — reset the budget

    // gameState is the authoritative roster on (re)connect — clear stale entries
    // for players who left during our disconnect, then add the current set.
    // (Local player is never stored here; state comes via localPlayerState.)
    this.players.clear();
    if (data.players && Array.isArray(data.players)) {
      for (const player of data.players) {
        if (player.id === this.localPlayerId) continue;
        this.players.set(player.id, player);
      }
    }
    this.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, team: data.team, scores: data.scores });
  }

  private handleTickUpdate(data: { updates: TickUpdatePlayer[]; ackSeq?: number }): void {
    this.telemetry.onTickArrival(Date.now());
    // Batched player updates from server (delta compressed)
    if (data.ackSeq !== undefined && data.ackSeq > 0) {
      this.pruneStateHistory(data.ackSeq);
    }
    if (!data.updates || !Array.isArray(data.updates)) return;
    const now = Date.now();
    for (const u of data.updates) {
      // Defense-in-depth: server already excludes self from tickUpdate,
      // but skip local player here too in case of any server-side regression
      if (u.playerId === this.localPlayerId) continue;
      this.upsertRemotePlayer(u.playerId, {
        internalId: u.internalId || undefined,
        position: u.position,
        rotation: u.rotation,
        velocity: u.velocity,
        isDead: u.isDead,
        health: u.health,
        ping: u.ping,
        ski: u.ski,
      });
      this.onPlayerUpdate?.(u.playerId, u.position, u.rotation, now, u.velocity);
    }
  }

  // Upsert a remote player's roster entry, preserving fields the message doesn't carry
  private upsertRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): void {
    if (!playerId || playerId === this.localPlayerId) return;
    const existing = this.players.get(playerId);
    this.players.set(playerId, {
      ...existing,
      id: playerId,
      internalId: patch.internalId || existing?.internalId || '',
      position: patch.position ?? existing?.position ?? { x: 0, y: 500, z: 0 },
      rotation: patch.rotation ?? existing?.rotation ?? { yaw: 0, pitch: 0 },
      velocity: patch.velocity ?? existing?.velocity ?? { x: 0, y: 0, z: 0 },
      isDead: patch.isDead ?? existing?.isDead ?? false,
      health: patch.health ?? existing?.health ?? 100,
      ping: patch.ping ?? existing?.ping,
      ski: patch.ski ?? existing?.ski,
      team: patch.team ?? existing?.team,
    });
  }

  private handlePlayerJoined(data: Extract<ServerMessage, { type: 'playerJoined' }>): void {
    // Rejoins (grace-period reconnects) re-broadcast playerJoined — only the
    // FIRST sighting is a roster event. Upserting health/isDead on a rejoin
    // would stomp the server-truth values tickUpdate already delivered, and
    // re-firing onPlayerJoined spam-recreates/logs the remote every time.
    const isNew = !this.players.has(data.playerId);
    this.upsertRemotePlayer(data.playerId, {
      position: data.position,
      rotation: data.rotation,
      velocity: isNew ? { x: 0, y: 0, z: 0 } : undefined,
      isDead: isNew ? false : undefined,
      health: isNew ? 100 : undefined,
      team: data.team,
    });
    if (isNew) this.onPlayerJoined?.(data.playerId, data.position, data.rotation);
  }

  private handlePlayerLeft(data: Extract<ServerMessage, { type: 'playerLeft' }>): void {
    if (data.playerId) {
      this.players.delete(data.playerId);
    }
    this.onPlayerLeft?.(data.playerId);
  }

  private handlePlayerRespawn(data: Extract<ServerMessage, { type: 'playerRespawn' }>): void {
    // Update REMOTE player in storage (local player respawn handled by callback)
    if (data.position) {
      this.upsertRemotePlayer(data.playerId, {
        position: data.position,
        rotation: data.rotation,
        velocity: { x: 0, y: 0, z: 0 },
        isDead: false,
        health: 100,
      });
    }
    this.onPlayerRespawn?.(data.playerId, data.position, data.rotation);
  }

  private handlePlayerHit(data: Extract<ServerMessage, { type: 'playerHit' }>): void {
    // Update REMOTE player health in storage (local player health handled by callback)
    this.upsertRemotePlayer(data.targetId, { health: data.health });
    this.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // Update REMOTE player state (local player death handled by callback)
    this.upsertRemotePlayer(data.targetId, { isDead: true, health: 0 });
    this.onPlayerKill?.(data.shooterId, data.targetId);
  }

  private handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position — snap to last valid state
    logger.warn(`Server correction at seq ${data.seq}: pos=(${data.position.x.toFixed(1)},${data.position.y.toFixed(1)},${data.position.z.toFixed(1)})`);
    this.pruneStateHistory(data.seq);
    this.onCorrection?.(data.seq, data.position, data.velocity, data.rotation);
  }

  private handleBinaryMessage(data: Uint8Array): void {
    if (!isWireFrame(data)) {
      logger.debug(`Received non-wire binary message: ${data.length} bytes`);
      return;
    }
    // Binary ball segments decode straight into the JSON message's shape —
    // netBallSegment sees one type regardless of transport.
    if (data[1] === WIRE_BALLSEG) {
      const seg = decodeBallSegment(data);
      if (seg) this.onBallSegment?.({
        type: 'ballSegment',
        id: seg.id, kind: seg.kind,
        position: seg.position, velocity: seg.velocity,
        enraged: seg.enraged, targetId: seg.targetId,
        tp: seg.tp, et: seg.et, slowT: seg.slowT, damp: seg.damp, t: seg.t,
      });
      return;
    }
    const tick = decodeTickFrame(data);
    if (tick) this.handleTickUpdate(tick);
  }

  /**
   * Send player position to server with rate limiting (20Hz binary frame)
   */
  /**
   * Declared discontinuity — the position jump (warp, respawn) is
   * intentional. Server reseats its plausibility anchor instead of
   * rejecting the move and rubber-banding us.
   */
  sendTeleport(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) return;
    this.send({ type: 'teleport', position, rotation, velocity });
  }

  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) return;

    const now = Date.now();

    // Rate limiting
    if (now - this.lastPositionSendTime < this.POSITION_SEND_INTERVAL) {
      return;
    }

    this.lastPositionSendTime = now;

    // Assign sequence number and store in state history for reconciliation
    const seq = ++this.sequenceCounter;
    this.stateHistory.set(seq, { position: { ...position }, velocity: { ...velocity }, rotation: { ...rotation } });
    if (this.stateHistory.size > this.STATE_HISTORY_MAX) {
      const oldest = this.stateHistory.keys().next().value;
      if (oldest !== undefined) this.stateHistory.delete(oldest);
    }

    // Binary frame: 30B instead of ~140B JSON. Server decodes on the wire
    // hot path; the message still passes through the same validation.
    this.sendBinary(encodePosition(position, rotation, velocity, seq, this.telemetry.ping));

    // Send ping if interval elapsed
    if (now - this.lastPingSendTime >= this.PING_INTERVAL) {
      this.lastPingSendTime = now;
      this.send({ type: 'ping', timestamp: now });
    }
  }

  /**
   * Send input move for client-side prediction.
   * Player calls this every frame — we only transmit on actual input change,
   * rate-limited to the position tick rate. Yaw/pitch already ride in the
   * binary position frame, so the rotation payload only matters when the
   * input bits themselves change.
   */
  private lastSentInput = '';
  sendInputMove(input: { forward: number; right: number; jump: number; ski: number }, rotation: { yaw: number; pitch: number }): void {
    const key = `${input.forward},${input.right},${input.jump},${input.ski}`;
    if (key === this.lastSentInput) return;
    this.lastSentInput = key;
    this.send({ type: 'inputMove', input, rotation });
  }

  /**
   * Get all REMOTE players (local player is never included)
   */
  getPlayers(): Map<string, RemotePlayerState> {
    return this.players;
  }

  /**
   * Send shot event to server
   */
  sendShot(a: {
    targetId: string | null; position?: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number }; timestamp?: number;
    projectileId?: string | null; weaponType?: number; airtime?: number;
  }): void {
    this.send({ type: 'shot', ...a });
  }

  /** Single AOE message — weaponType resolves server-side via the shared
   *  weapon table (WEAPONS in shared/weapons.ts). projectileId/airtime bind
   *  the blast to a tracked projectile so the server can validate the
   *  trajectory — skill AOEs (slam) send neither and are position-checked
   *  against the player instead. */
  sendAOEShot(a: {
    position: { x: number; y: number; z: number }; weaponType: number;
    excludeTargetId?: string | null; projectileId?: string | null;
    airtime?: number; power?: number; directHit?: boolean;
  }): void {
    this.send({
      type: 'aoeShot',
      ...a,
      excludeTargetId: a.excludeTargetId ?? null,
      projectileId: a.projectileId ?? undefined,
    });
  }

  sendJump(position: { x: number; y: number; z: number }): void {
    this.send({ type: 'jump', position });
  }

  sendJetpack(position: { x: number; y: number; z: number }): void {
    this.send({ type: 'jetpack', position });
  }

  sendProjectileDestroy(projectileId: string): void {
    this.send({ type: 'projectileDestroy', projectileId });
  }

  /** Offline authority — when there's no server, damage/heal claims apply
   *  locally through this hook instead of being dropped on the floor. */
  localAuthority: { envDamage(amount: number): void; heal(amount: number): void } | null = null;

  /** Self-inflicted environment damage (crawler pounce, etc.) — the server
   *  clamps and applies it, then broadcasts the authoritative health. */
  sendEnvironmentDamage(amount: number): void {
    if (!this.connected) { this.localAuthority?.envDamage(amount); return; }
    this.send({ type: 'environmentDamage', amount });
  }

  /** Client-claimed heal (nugget pickup) — keeps server health the truth. */
  sendHeal(amount: number): void {
    if (!this.connected) { this.localAuthority?.heal(amount); return; }
    this.send({ type: 'heal', amount });
  }

  /** Hit claim on a server-owned creature (netDriven ball). kx/ky/kz is the
   *  impulse the shot imparted — server clamps magnitude and rebroadcasts
   *  the new segment so every client sees the same shove. */
  sendCreatureHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    this.send({ type: 'creatureHit', id, damage, kx, ky, kz });
  }

  sendSnapshotRequest(): void {
    this.send({ type: 'snapshotRequest' });
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', text });
  }

  /** Nugget/flag banking claim — team-mode rooms own the score. */
  sendBank(n: number): void {
    this.send({ type: 'bank', n });
  }

  
  /**
   * Get local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.connected();
  }

  getPing(): number {
    return this.telemetry.ping;
  }

  getPacketLoss(): number {
    return this.telemetry.packetLoss(Date.now());
  }

  getJitter(): number {
    return this.telemetry.jitter();
  }

  private handlePong(timestamp: number): void {
    this.telemetry.onPong(timestamp, Date.now());
  }

  private pruneStateHistory(ackSeq: number): void {
    // Map iterates in insertion order and seqs increase monotonically —
    // stop at the first unacked entry instead of scanning the whole map.
    for (const seq of this.stateHistory.keys()) {
      if (seq > ackSeq) break;
      this.stateHistory.delete(seq);
    }
  }
}
