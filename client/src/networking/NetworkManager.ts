import { ChildLogger } from '../core/Logger.js';
import { isWireFrame, encodePosition, decodeTickFrame, decodeBallSegment, WIRE_BALLSEG } from '../../../shared/wire.js';
import type { ClientMessage, ServerMessage, TickUpdatePlayer, GameStatePlayer, LocalPlayerState, SnapshotPlayer } from '../../../shared/protocol.js';
import type { PickupKind } from '../../../shared/pickups.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { TieredTransport } from './tiers.js';
import type { GameTransport, TransportFactory } from './transport.js';
import { NetTelemetry } from './netTelemetry.js';
import { WeaponType } from '../../../shared/weapons.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetworkManager');

// Roster upsert fields + fresh-player defaults (optional fields default undefined).
const ROSTER_FIELDS = ['internalId', 'position', 'rotation', 'velocity', 'isDead',
  'health', 'ping', 'ski', 'status', 'team', 'transport', 'armorClass', 'sheep'] as const;
const ROSTER_DEFAULTS: Partial<RemotePlayerState> = {
  internalId: '',
  position: { x: 0, y: 500, z: 0 },
  rotation: { yaw: 0, pitch: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  isDead: false,
  health: 100,
};

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
  /** Status bitmask — STATUS_* bits (shared/status.ts). */
  status?: number;
  team?: 'alpha' | 'bravo';
  /** Server-reported connect tier (join transport claim) — scoreboard NET. */
  transport?: 'wt' | 'rtc' | 'ws';
  /** Armor tier from playerJoined/gameState — remote model scale cue. */
  armorClass?: string;
  /** Server-side sheep meter (bots only) — how pedestrian this bot is. */
  sheep?: number;
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
  /** Loadout perk, announced at join so the server can enforce resist/heal. */
  joinPerk: (() => string) | null = null;
  joinClass: (() => string) | null = null;
  /** REMOTE players only — local player is never stored here */
  private players: Map<string, RemotePlayerState> = new Map();
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number, health: number, armor?: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string, weapon?: number) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, armorClass?: string) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number) => void) | null = null;
  /** Server refused a claim — `health` is the authoritative resync value
   *  (rejected predicted self-splash leaves client health divergent). */
  public onShotRejected: ((reason: string, targetId: string | undefined, weaponType: number | undefined, health: number | undefined) => void) | null = null;
  public onPlayerShot: ((id: string, weaponType: number | undefined, pos: { x: number; y: number; z: number } | undefined, dir: { x: number; y: number; z: number } | undefined) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onKnockback: ((position: { x: number; y: number; z: number }, force: number, pull?: boolean) => void) | null = null;
  public onChat: ((playerId: string, text: string) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number, velocity?: { x: number; y: number; z: number }) => void) | null = null;
  public onGameState: ((players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: PickupKind }[]; flags?: { team: 'alpha' | 'bravo'; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: { x: number; y: number; z: number } }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: import('../../../shared/mapSpec.js').StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number> } }) => void) | null = null;
  public onTeamScore: ((scores: { alpha: number; bravo: number }, winAt: number) => void) | null = null;
  public onMatchEnd: ((winner: 'alpha' | 'bravo' | 'draw', scores: { alpha: number; bravo: number }) => void) | null = null;
  public onMatchStart: ((mode: string, scores: { alpha: number; bravo: number }) => void) | null = null;
  /** Server-owned flag state (CTF rooms) — pos/state/carrier per team. */
  public onFlagUpdate: ((flags: { team: 'alpha' | 'bravo'; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]) => void) | null = null;
  public onMatchNotice: ((text: string) => void) | null = null;
  public onPickupSpawn: ((id: number, pos: { x: number; y: number; z: number }, kind?: PickupKind) => void) | null = null;
  /** Powerup applied to US — server-owned buffs (armor/heal/timed). */
  public onBuff: ((msg: { kind: 'heal' | 'armor' | 'regen' | 'dd'; armor?: number; health?: number; until?: number }) => void) | null = null;
  public onPickupGone: ((id: number, by: string | null) => void) | null = null;
  public onFfaScore: ((scores: Record<string, number>, winAt: number) => void) | null = null;
  public onFfaMatchEnd: ((winner: string, scores: Record<string, number>) => void) | null = null;
  /** Admin hot-reload — structures/arena changed mid-match; rebuild them. */
  public onMapUpdate: ((map: { bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: import('../../../shared/mapSpec.js').StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; terrain?: string }) => void) | null = null;
  // Server-owned deployables — rendered as dumb visuals client-side;
  // the sim (firing/damage) stays authoritative on the server.
  public onDeploySpawn: ((id: number, owner: string, kind: 'turret' | 'mine' | 'station' | 'drone', pos: { x: number; y: number; z: number }, team?: 'alpha' | 'bravo') => void) | null = null;
  public onDeployGone: ((id: number) => void) | null = null;
  /** Server sim fired a remote sentry — paint the rocket at the deployable. */
  public onTurretShot: ((id: number, owner: string, targetId: string) => void) | null = null;
  /** Server-owned mine exploded — explosion FX only; damage flows via the
   *  normal playerHit/knockback channel. */
  public onMineBoom: ((id: number, pos: { x: number; y: number; z: number }) => void) | null = null;
  public onSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;
  public onStateHash: ((hash: string, tick: number, playerCount: number, timestamp: number) => void) | null = null;
  public onCorrection: ((seq: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, inputSeq?: number, grounded?: boolean) => void) | null = null;
  public onBallSpawn: ((data: Extract<ServerMessage, { type: 'ballSpawn' }>) => void) | null = null;
  public onBallSegment: ((data: Extract<ServerMessage, { type: 'ballSegment' }>) => void) | null = null;
  public onBallDie: ((data: Extract<ServerMessage, { type: 'ballDie' }>) => void) | null = null;
  public onBallRoster: ((data: Extract<ServerMessage, { type: 'ballRoster' }>) => void) | null = null;
  public onCrawlSpawn: ((data: Extract<ServerMessage, { type: 'crawlSpawn' }>) => void) | null = null;
  public onCrawlEvt: ((data: Extract<ServerMessage, { type: 'crawlEvt' }>) => void) | null = null;
  public onCrawlDie: ((data: Extract<ServerMessage, { type: 'crawlDie' }>) => void) | null = null;
  public onCrawlRoster: ((data: Extract<ServerMessage, { type: 'crawlRoster' }>) => void) | null = null;
  public onRemoteTeleport: ((playerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  private lastPositionSendTime: number = 0;
  private readonly POSITION_SEND_INTERVAL = 50; // 20Hz — extrapolation covers the gap
  private readonly telemetry = new NetTelemetry(this.POSITION_SEND_INTERVAL);
  private hasLoggedConnectionError: boolean = false;

  // --- Client-side prediction: sequence tracking + state history ---
  private sequenceCounter: number = 0;
  private lastTickSeq = -1; // highest server tickSeq applied — stale frames drop
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
        const factory = makeTransport ?? ((cfg) => new TieredTransport(cfg));
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
              map: urlParams.map ?? undefined,
              bots: urlParams.bots,
              perk: this.joinPerk?.(),
              armorClass: this.joinClass?.(),
              transport: this.ws?.tier,
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
            this.lastTickSeq = -1; // a reconnect starts a fresh seq space
            // Drop the wire roster — kept entries pass the liveness gate
            // on their stale ping, so their bodies freeze at the last
            // snapshot for the whole 60s stale window and their HUD dots
            // freeze with them. gameState re-seeds the map on reconnect.
            this.players.clear();
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

  /** Outbound binary frame — pre-encoded by shared/wire.ts. Position input
   *  rides the RELIABLE lane: the move judge sims from every claim, so a
   *  dropped datagram starves the authority sim and earns a correction —
   *  measured ~47% WT datagram loss on loopback, which played as warping.
   *  Stale claims self-reject by seq, so reliability costs nothing.
   *  (WS/RTC already degraded to reliable — only WT changed behavior.) */
  private sendBinary(data: Uint8Array): void {
    if (!this.ws?.connected()) return;
    this.ws.send(data);
  }

  /** Ring of recent health-affecting events — read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  private readonly recentHealthEvents: { type: string; t: number; detail: string }[] = [];
  private static readonly HEALTH_EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'buff', 'heal']);
  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.recentHealthEvents;
  }

  private handleMessage(data: ServerMessage): void {
    // Capture the server-issued session token for future reconnects
    if (data?.type === 'gameState' && typeof data.sessionToken === 'string') {
      this.sessionToken = data.sessionToken;
      localStorage.setItem('fps-session-token', data.sessionToken);
    }
    if (NetworkManager.HEALTH_EVENT_TYPES.has(data.type)) {
      if (this.recentHealthEvents.length >= 24) this.recentHealthEvents.shift();
      const d = data as Record<string, unknown>;
      this.recentHealthEvents.push({ type: data.type, t: Date.now(), detail: `${d.shooterId ?? d.playerId ?? ''}→${d.targetId ?? ''} ${d.damage ?? ''}` });
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
    teamUpdate: (data) => this.upsertRemotePlayer(data.playerId, { team: data.team }),
    playerRespawn: (data) => this.handlePlayerRespawn(data),
    playerHit: (data) => this.handlePlayerHit(data),
    buff: (data) => this.onBuff?.(data),
    playerKill: (data) => this.handlePlayerKill(data),
    knockback: (data) => this.onKnockback?.(data.position, data.force, data.pull),
    jump: (data) => this.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data) => this.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data) => this.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType),
    playerShot: (data) => this.onPlayerShot?.(data.id, data.weaponType, data.pos, data.dir),
    projectileDestroyed: (data) => this.onProjectileDestroyed?.(data.projectileId),
    snapshot: (data) => this.onSnapshot?.(data.players || [], data.timestamp || Date.now()),
    stateHash: (data) => this.onStateHash?.(data.hash, data.tick, data.playerCount, data.timestamp),
    correction: (data) => this.handleCorrection(data),
    teleport: (data) => this.onRemoteTeleport?.(data.playerId, data.position, data.velocity),
    ballSpawn: (data) => this.onBallSpawn?.(data),
    ballSegment: (data) => this.onBallSegment?.(data),
    ballDie: (data) => this.onBallDie?.(data),
    ballRoster: (data) => this.onBallRoster?.(data),
    crawlSpawn: (data) => this.onCrawlSpawn?.(data),
    crawlEvt: (data) => this.onCrawlEvt?.(data),
    crawlDie: (data) => this.onCrawlDie?.(data),
    crawlRoster: (data) => this.onCrawlRoster?.(data),
    pong: (data) => this.handlePong(data.timestamp),
    chat: (data) => this.onChat?.(data.playerId, data.text),
    flagUpdate: (data) => this.onFlagUpdate?.(data.flags),
    matchNotice: (data) => this.onMatchNotice?.(data.text),
    pickupSpawn: (data) => this.onPickupSpawn?.(data.id, data.pos, data.kind),
    pickupGone: (data) => this.onPickupGone?.(data.id, data.by ?? null),
    teamScore: (data) => this.onTeamScore?.(data.scores, data.winAt),
    ffaScore: (data) => this.onFfaScore?.(data.scores, data.winAt),
    ffaMatchEnd: (data) => this.onFfaMatchEnd?.(data.winner, data.scores),
    matchEnd: (data) => this.onMatchEnd?.(data.winner, data.scores),
    matchStart: (data) => this.onMatchStart?.(data.mode, data.scores),
    mapUpdate: (data) => this.onMapUpdate?.(data),
    deploySpawn: (data) => this.onDeploySpawn?.(data.id, data.owner, data.kind, data.pos, data.team),
    deployGone: (data) => this.onDeployGone?.(data.id),
    turretShot: (data) => this.onTurretShot?.(data.id, data.owner, data.targetId),
    mineBoom: (data) => this.onMineBoom?.(data.id, data.pos),
    // Server refused a hit claim — worth surfacing: a healthy client
    // should basically never see this, so it's a desync tell.
    shotRejected: (data) => {
      logger.error(`shot rejected — predicted damage never applied`, {
        reason: data.reason,
        targetId: data.targetId,
        weapon: data.weaponType !== undefined ? WeaponType[data.weaponType] ?? data.weaponType : undefined,
        pingMs: this.telemetry.ping,
      });
      this.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
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
    this.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, team: data.team, scores: data.scores, ffaScores: data.ffaScores, pickups: data.pickups, flags: data.flags, matchEndsAt: data.matchEndsAt, respawnMs: data.respawnMs, deployables: data.deployables, map: data.map });
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
        status: u.status,
        sheep: u.sheep,
      });
      this.onPlayerUpdate?.(u.playerId, u.position, u.rotation, now, u.velocity);
    }
  }

  // Upsert a remote player's roster entry, preserving fields the message
  // doesn't carry: merge order is patch → existing → default, so partial
  // updates (hit = health only) never stomp unrelated roster state.
  private upsertRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): void {
    if (!playerId || playerId === this.localPlayerId) return;
    const existing = this.players.get(playerId);
    const next = { ...existing, id: playerId } as RemotePlayerState;
    for (const k of ROSTER_FIELDS) {
      (next as unknown as Record<string, unknown>)[k] = patch[k] ?? existing?.[k] ?? ROSTER_DEFAULTS[k];
    }
    this.players.set(playerId, next);
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
      transport: data.transport,
      armorClass: data.armorClass,
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
    this.onPlayerRespawn?.(data.playerId, data.position, data.rotation, data.armorClass);
  }

  private handlePlayerHit(data: Extract<ServerMessage, { type: 'playerHit' }>): void {
    // Update REMOTE player health in storage (local player health handled by callback)
    this.upsertRemotePlayer(data.targetId, { health: data.health });
    this.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health, data.armor);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // Update REMOTE player state (local player death handled by callback)
    this.upsertRemotePlayer(data.targetId, { isDead: true, health: 0 });
    this.onPlayerKill?.(data.shooterId, data.targetId, data.weapon);
  }

  private handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position — snap to last valid state
    logger.warn(`Server correction at seq ${data.seq}: pos=(${data.position.x.toFixed(1)},${data.position.y.toFixed(1)},${data.position.z.toFixed(1)})`);
    this.pruneStateHistory(data.seq);
    this.onCorrection?.(data.seq, data.position, data.velocity, data.rotation, data.inputSeq, data.grounded);
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
    if (!tick) return;
    // Stale-drop: under an unordered transport a late frame carries an older
    // tickSeq — interpolating it would rewind remotes. On TCP this never
    // trips (frames can't reorder); it exists for the UDP tiers.
    if (tick.tickSeq <= this.lastTickSeq) return;
    this.lastTickSeq = tick.tickSeq;
    this.handleTickUpdate(tick);
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
    this.sendBinary(encodePosition(position, rotation, velocity, seq, this.telemetry.ping, this.inputSeq));

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
  private inputSeq = 0;
  /** Journal of transmitted input events (change-only stream). On a server
   *  correction the client rewinds to the echoed state and replays every
   *  entry with seq > the server's last consumed inputSeq — CFWK-style
   *  input replay so missed packets converge instead of re-diverging. */
  private inputJournal: { seq: number; t: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number } }[] = [];
  private static readonly INPUT_JOURNAL_MAX = 128;

  sendInputMove(input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }, rotation: { yaw: number; pitch: number }): void {
    const key = `${input.forward},${input.right},${input.jump},${input.ski},${input.jet ?? 0},${input.status ?? 0}`;
    if (key === this.lastSentInput) return;
    this.lastSentInput = key;
    // Change-only stream → unordered transports can deliver stale events
    // after fresh ones; the seq lets the server drop them.
    const seq = ++this.inputSeq;
    this.inputJournal.push({ seq, t: performance.now(), input: { ...input } });
    if (this.inputJournal.length > NetworkManager.INPUT_JOURNAL_MAX) this.inputJournal.shift();
    this.send({ type: 'inputMove', seq, input, rotation });
  }

  /** Journal entries with seq > `after` — what the server hadn't consumed
   *  when it issued a correction. Also prunes consumed entries. */
  inputsAfter(after: number): { t: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number } }[] {
    while (this.inputJournal.length && this.inputJournal[0].seq <= after) this.inputJournal.shift();
    return this.inputJournal;
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

  /** Cosmetic fire relay — hitscan kinds (fan/beam) leave no projectile,
   *  so this tells the server to paint muzzle audio/visual on observers. */
  sendShotFired(a: { weaponType?: number; dir?: { x: number; y: number; z: number } }): void {
    if (!this.connected) return;
    this.send({ type: 'shotFired', ...a });
  }

  sendProjectileDestroy(projectileId: string): void {
    this.send({ type: 'projectileDestroy', projectileId });
  }

  /** Deployable plant claim — sent when the pod lands and seats, so the
   *  position is the settled one the server will enforce caps/TTL on. */
  sendDeploy(kind: 'turret' | 'mine' | 'station' | 'drone', position: { x: number; y: number; z: number }): void {
    if (!this.connected) return;
    this.send({ type: 'deploy', kind, position });
  }

  /** Loadout class pick mid-match — the server banks it for the next
   *  respawn (same rule the client applies locally). */
  sendClassUpdate(armorClass: string): void {
    if (!this.connected) return;
    this.send({ type: 'classUpdate', armorClass });
  }

  /** Perk pick mid-match — same respawn-bank rule as the class pick. */
  sendPerkUpdate(perk: string): void {
    if (!this.connected) return;
    this.send({ type: 'perkUpdate', perk });
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
  sendCrawlerHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    this.send({ type: 'crawlerHit', id, damage, kx, ky, kz });
  }

  sendCreatureHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    this.send({ type: 'creatureHit', id, damage, kx, ky, kz });
  }

  sendSnapshotRequest(): void {
    this.send({ type: 'snapshotRequest' });
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', text });
  }

  /** Mid-match room hop — the server re-seats this session and answers
   *  with a fresh gameState, which the normal (re)connect path rebuilds
   *  from. Returns false when there's no live socket (caller falls back
   *  to a reload join). */
  switchRoom(room: string, map?: string, bots?: number): boolean {
    if (!this.isConnected()) return false;
    this.send({ type: 'switchRoom', room, map, bots });
    return true;
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

  /** Netcode-v2 tier our own connection negotiated — self row on the
   *  scoreboard (remotes get theirs from gameState/playerJoined). */
  getTransportTier(): 'wt' | 'rtc' | 'ws' | 'p2p' | 'host' | undefined {
    return this.ws?.tier;
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
