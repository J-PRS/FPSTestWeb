import { ChildLogger } from '../core/Logger.js';
import { isWireFrame, encodePosition, decodeTickFrame, decodeBallSegment, WIRE_BALLSEG, SERVER_TICK_MS, type TickDecodePool } from '../../../shared/wire.js';
import type { ClientMessage, ServerMessage, TickUpdatePlayer, GameStatePlayer, LocalPlayerState, SnapshotPlayer, TransportKind } from '../../../shared/protocol.js';
import type { PickupKind } from '../../../shared/pickups.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { PROTOCOL_VERSION } from '../../../shared/protocol.js';
import { TieredTransport } from './tiers.js';
import type { GameTransport, TransportFactory } from './transport.js';
import { NetTelemetry } from './netTelemetry.js';
import { WeaponType } from '../../../shared/weapons.js';
import { urlParams } from '../core/params.js';
import type { TeamId } from '../../../shared/teams.js';
import { ClaimLedger, noteMutedClaim, rejectCensus, dedupCensus, dropCensus } from './claimLedger.js';
import { InputStream } from './inputStream.js';

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
  team?: TeamId;
  /** Server-reported connect tier (join transport claim) — scoreboard NET. */
  transport?: TransportKind;
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
  public onPlayerKill: ((shooterId: string, targetId: string, weapon?: number, air?: number) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, armorClass?: string) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number, shotId?: string) => void) | null = null;
  /** Server refused a claim — `health` is the authoritative resync value
   *  (rejected predicted self-splash leaves client health divergent). */
  public onShotRejected: ((reason: string, targetId: string | undefined, weaponType: number | undefined, health: number | undefined) => void) | null = null;
  public onPlayerShot: ((id: string, weaponType: number | undefined, pos: { x: number; y: number; z: number } | undefined, dir: { x: number; y: number; z: number } | undefined) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string, shotId?: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onKnockback: ((position: { x: number; y: number; z: number }, force: number, pull?: boolean) => void) | null = null;
  public onChat: ((playerId: string, text: string, team: boolean, vgs: string | undefined) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number, velocity?: { x: number; y: number; z: number }) => void) | null = null;
  public onGameState: ((players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; mapName?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: PickupKind }[]; flags?: { team: TeamId; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: import('../../../shared/mapSpec.js').StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; terrainTex?: string; sky?: string } }) => void) | null = null;
  public onTeamScore: ((scores: { alpha: number; bravo: number }, winAt: number) => void) | null = null;
  public onMatchEnd: ((winner: TeamId | 'draw', scores: { alpha: number; bravo: number }) => void) | null = null;
  public onMatchStart: ((mode: string, scores: { alpha: number; bravo: number }) => void) | null = null;
  /** Server-owned flag state (CTF rooms) — pos/state/carrier per team. */
  public onFlagUpdate: ((flags: { team: TeamId; pos: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]) => void) | null = null;
  public onMatchNotice: ((text: string) => void) | null = null;
  /** Server anti-cheat flag — renders as a banner, not a disconnect. */
  public onServerWarn: ((text: string) => void) | null = null;
  public onPickupSpawn: ((id: number, pos: { x: number; y: number; z: number }, kind?: PickupKind) => void) | null = null;
  /** Powerup applied to US — server-owned buffs (armor/heal/timed). */
  public onBuff: ((msg: { kind: 'heal' | 'armor' | 'regen' | 'dd'; armor?: number; health?: number; until?: number }) => void) | null = null;
  /** Server-owned heal echo (regen/mend/powerup tick in the sim) — keeps
   *  local hp converged between discrete hit events. */
  public onYourHealth: ((health: number) => void) | null = null;
  public onYourCharge: ((charge: number) => void) | null = null;
  public onPickupGone: ((id: number, by: string | null) => void) | null = null;
  public onFfaScore: ((scores: Record<string, number>, winAt: number) => void) | null = null;
  public onFfaMatchEnd: ((winner: string, scores: Record<string, number>) => void) | null = null;
  /** Admin hot-reload — structures/arena changed mid-match; rebuild them. */
  public onMapUpdate: ((map: { mapName?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: import('../../../shared/mapSpec.js').StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number }; terrainTex?: string; sky?: string; interiors?: import('../../../shared/mapSpec.js').InteriorSpec[] }) => void) | null = null;
  // Server-owned deployables — rendered as dumb visuals client-side;
  // the sim (firing/damage) stays authoritative on the server.
  public onDeploySpawn: ((id: number, owner: string, kind: DeployKind, pos: { x: number; y: number; z: number }, team?: TeamId) => void) | null = null;
  public onDeployGone: ((id: number) => void) | null = null;
  /** Base asset shelled into a hulk / stood back up — wreck↔live visuals. */
  public onDeployDown: ((id: number, kind: DeployKind, team: string | undefined, respawnS: number) => void) | null = null;
  public onDeployUp: ((id: number) => void) | null = null;
  /** Base sensor sweep — hostiles inside a mast's radius, relayed to its team. */
  public onSensorPing: ((id: number, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]) => void) | null = null;
  /** Server sim fired a remote sentry — paint the rocket at the deployable. */
  public onTurretShot: ((id: number, owner: string, targetId: string) => void) | null = null;
  public onSentryShot: ((id: number, owner: string, x: number, y: number, z: number) => void) | null = null;
  /** Server-owned mine exploded — explosion FX only; damage flows via the
   *  normal playerHit/knockback channel. */
  public onMineBoom: ((id: number, pos: { x: number; y: number; z: number }) => void) | null = null;
  /** Server's vitals table for a deployable — repair heals echo back
   *  through this; armor is the repair-tool overheal pool. */
  public onDeployHp: ((id: number, hp: number, armor: number, src?: string) => void) | null = null;
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
  // Tick ARRIVAL cadence is the server loop's 50ms interval (20Hz).
  private readonly telemetry = new NetTelemetry(50);
  private hasLoggedConnectionError: boolean = false;

  // --- Client-side prediction: sequence tracking + state history ---
  private sequenceCounter: number = 0;
  private lastTickSeq = -1; // highest server tickSeq applied — stale frames drop
  /** Decode slots reused every tick — upsert deep-fills roster vecs so
   *  rostered values never alias a slot (see decodeTickFrame pool docs). */
  private tickPool: TickDecodePool = { slots: [], resolveId: (id) => this.wireIds.get(id) };
  /** v3 tick-frame roster: u16 -> playerId, fed by 'wireIds' events that
   *  always precede the first frame referencing them (same socket). */
  private readonly wireIds = new Map<number, string>();
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
  // True once connect() has been asked for a session — distinguishes
  // 'never went online' (offline mode) from 'online and currently down'
  // so the HUD can warn only in the second case.
  private onlineExpected = false;
  // Silence watchdog — a black-holed socket (dead tunnel/proxy, half-open
  // TCP) keeps readyState OPEN and never fires close: no banner, no
  // reconnect, frozen game. Any inbound frame proves liveness; >STALL_MS
  // of nothing while "connected" forces a teardown + re-probe.
  private lastRxAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly STALL_MS = 4000;
  private lastUrl: string | null = null;
  private lastFactory: TransportFactory | undefined;

  connect(url: string, makeTransport?: TransportFactory): Promise<void> {
    this.onlineExpected = true;
    this.lastUrl = url;
    this.lastFactory = makeTransport;
    this.lastRxAt = Date.now();
    this.stallTimer ??= setInterval(() => this.checkStall(), 1000);
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
              // Offset cursor — a reclaim carries the last reliable ev we
              // saw so the server replays only the missed frames.
              resumeSeq: this.sessionToken ? this.lastEv : undefined,
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
            this.lastDownReason = null;
            // Queued reliable commands ride the live lane after the join
            // (bounded 16 — a dead lane never earns an unbounded backlog).
            for (const q of this.pendingCmds) this.send(q);
            this.pendingCmds = [];
            resolve();
          },
          onDisconnect: (code, reason) => {
            // 1008 = server rejected our session — drop stored identity so
            // auto-reconnect joins fresh instead of looping on bad creds
            if (code === 1008) this.resetIdentity(reason);
            // A reasoned close ('server restarting', 'kicked') reads
            // differently than a dead pipe — the banner names it.
            this.lastDownReason = code !== undefined && code >= 1000 && reason ? reason : null;
            logger.info('Disconnected', { code, reason });
            this.connected = false;
            this.lastTickSeq = -1; // a reconnect starts a fresh seq space
            // Claims sent on the dead lane are void — the server replays
            // in-flight hits, not lost ones; stamped claims classify as
            // transport-lost, not unconfirmed.
            this.ledger.dropAll(true);
            this.lastHitSeq = 0;   // hit seqs are per-room — a stale high
                                   // watermark would drop every later hit
            // Same for the cadence metric — else the dead period counts as
            // missed ticks and loss reads ~100% right after rejoining.
            this.telemetry.reset();
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

  /** Server says our stored identity is no good — burn id+token so the
   *  next connect joins fresh. Reached via close(1008) on WS and via the
   *  `sessionRejected` message on WT/RTC, where the close code is lost. */
  private resetIdentity(reason?: string): void {
    localStorage.removeItem('fps-player-id');
    localStorage.removeItem('fps-session-token');
    this.sessionToken = null;
    this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('fps-player-id', this.localPlayerId);
    logger.info(`Session rejected (${reason}) — rejoining as ${this.localPlayerId}`);
  }

  disconnect(): void {
    this.onlineExpected = false;
    this.lastRxAt = 0;
    this.ws?.disconnect();
    this.ws = null;
    this.connected = false;
  }

  private checkStall(): void {
    if (!this.isConnected() || !this.lastUrl) return;
    const silent = Date.now() - this.lastRxAt;
    if (this.lastRxAt === 0 || silent < NetworkManager.STALL_MS) return;
    logger.warn(`no server traffic in ${Math.round(silent)}ms — socket silent, reprobing`, { tier: this.ws?.tier });
    const url = this.lastUrl;
    // TieredTransport is one-shot after disconnect() (closed flag), so
    // go through connect() which builds a fresh transport and re-probes.
    this.ws?.disconnect();
    this.ws = null;
    this.connected = false;
    void this.connect(url, this.lastFactory).catch(() => { /* probe errors are already logged */ });
  }

  /** Online session whose socket is down right now (reconnect loop
   *  running underneath). False for offline mode and clean shutdowns. */
  connectionDown(): boolean {
    return this.onlineExpected && !this.isConnected();
  }

  /** Close-frame reason from the last drop, or null for a silent drop. */
  private lastDownReason: string | null = null;
  connectionDownReason(): string | null {
    return this.connectionDown() ? this.lastDownReason : null;
  }

  /** Sends that never left the pipe — connected() false or the inner
   *  lane dropped the frame. Sampled warn keeps Alt+Q honest about
   *  "I shot but nothing happened" windows (RTC flap, probe racing). */
  private sendDrops = 0;

  /** Commands worth surviving a dead lane — time-critical claims (shots,
   *  hits, inputMove) are dropped as before; replaying a 30s-old hit is a
   *  stale-claim bug, not a recovery. Bounded like Colyseus
   *  maxEnqueuedMessages so a dead lane can't queue forever. */
  private static readonly QUEUEABLE = new Set([
    'chat', 'deploy', 'classUpdate', 'perkUpdate', 'respawn',
    'switchRoom', 'resync', 'snapshotRequest',
  ]);
  private pendingCmds: ClientMessage[] = [];
  private static readonly MAX_PENDING_CMDS = 16;

  /** Last processed reliable `ev` seq — presented as resumeSeq on a
   *  token-carrying join so the server replays only the missed frames. */
  private lastEv = 0;

  /** Outbound JSON event — typed against the shared protocol union. */
  private send(msg: ClientMessage): void {
    if (!this.ws?.connected()) {
      if (this.onlineExpected && NetworkManager.QUEUEABLE.has(msg.type)) {
        this.pendingCmds.push(msg);
        if (this.pendingCmds.length > NetworkManager.MAX_PENDING_CMDS) this.pendingCmds.shift();
        return;
      }
      this.noteDrop(msg.type);
      return;
    }
    const s = JSON.stringify(msg);
    this.txBytes += s.length;
    if (this.ws.send(s) === false) this.noteDrop(msg.type);
  }

  private noteDrop(type: string): void {
    // Contract scream: a transport that flips connected()→false without
    // first firing onDisconnect leaves the tier manager blind (the WT
    // 64KB-carry bug). If we still believe we're online while the lane
    // reports dead, the transport violated the contract — say so loudly.
    if (this.connected && this.ws && !this.ws.connected()) {
      logger.error(`lane went dead with NO disconnect event — transport contract violation`, { tier: this.ws.tier });
      this.connected = false; // let the HUD stall-watchdog see the drop
    }
    this.sendDrops++;
    // First drop is loud; repeats get sampled — a dead lane would
    // otherwise spam the buffer once per position frame.
    if (this.sendDrops === 1 || (this.sendDrops & 31) === 0) {
      logger.warn(`send dropped x${this.sendDrops} — no live lane`, { lastType: type });
    }
  }

  /** Outbound binary frame — pre-encoded by shared/wire.ts. On RTC this
   *  rides the 'game' lane (unordered, maxRetransmits:2): bounded retries
   *  cover jitter without head-of-line stalling the association — the
   *  reliable lane's retransmit queue was the recurring 4-5s silence.
   *  A rare real loss just widens the judge's time-gap tolerance; stale
   *  frames self-reject by seq, so disorder is free. WS/WT unchanged. */
  private sendBinary(data: Uint8Array): void {
    if (!this.ws?.connected()) { this.noteDrop('bin'); return; }
    this.txBytes += data.length;
    this.ws.send(data);
  }

  /** Byte counters → smoothed B/s pair, read by the backquote perf HUD.
   *  tx is exact (we build the buffers); rx counts binary exactly and
   *  approximates JSON events by re-stringify — they're sparse, so the
   *  cost is nothing and the number is close enough for a debug readout. */
  private txBytes = 0;
  private rxBytes = 0;
  private bwT = 0;
  private bwLastTx = 0;
  private bwLastRx = 0;
  private bwUp = 0;
  private bwDown = 0;
  private ledger = new ClaimLedger();
  private inputs = new InputStream();

  bandwidth(): { up: number; down: number } {
    const now = performance.now();
    this.ledger.sweep(now, { pingMs: this.telemetry.ping, tier: this.ws?.tier });
    if (this.bwT === 0) { this.bwT = now; return { up: 0, down: 0 }; }
    const dt = (now - this.bwT) / 1000;
    if (dt >= 0.5) {
      this.bwUp = this.bwUp * 0.5 + ((this.txBytes - this.bwLastTx) / dt) * 0.5;
      this.bwDown = this.bwDown * 0.5 + ((this.rxBytes - this.bwLastRx) / dt) * 0.5;
      this.bwT = now;
      this.bwLastTx = this.txBytes;
      this.bwLastRx = this.rxBytes;
    }
    return { up: this.bwUp, down: this.bwDown };
  }

  /** Ring of recent health-affecting events — read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  private readonly recentHealthEvents: { type: string; t: number; detail: string }[] = [];
  private static readonly HEALTH_EVENT_TYPES = new Set(['playerHit', 'playerKill', 'playerRespawn', 'buff', 'heal']);
  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.recentHealthEvents;
  }

  /** Wire-feed seam for recorded streams (.rec): pushes one message
   *  through the exact live dispatch path — handlers can't tell the
   *  difference between a capture and a socket. Dev replay only. */
  replayWireMessage(data: ServerMessage | Uint8Array): void {
    if (typeof data === 'object' && !(data instanceof Uint8Array)) this.handleMessage(data);
    else this.handleBinaryMessage(data as Uint8Array);
  }

  private handleMessage(data: ServerMessage): void {
    this.lastRxAt = Date.now();
    this.rxBytes += JSON.stringify(data).length; // rx approximation — JSON events are sparse
    // Offset cursor: every reliable frame carries a room-scoped `ev`.
    // Replays only ever carry seq > our watermark, so tracking the max
    // doubles as the dup guard if a transport ever re-delivers.
    const ev = (data as ServerMessage & { ev?: number }).ev;
    if (ev !== undefined && ev > this.lastEv) this.lastEv = ev;
    // Capture the server-issued session token for future reconnects.
    // gameState also re-seeds the ev watermark: `ev` is room-scoped, so a
    // room hop or fresh join must adopt THIS room's seq, not max() against
    // a stale watermark from the old room.
    if (data?.type === 'gameState') {
      if (ev !== undefined) this.lastEv = ev;
      if (typeof data.sessionToken === 'string') {
        this.sessionToken = data.sessionToken;
        localStorage.setItem('fps-session-token', data.sessionToken);
      }
    }
    if (NetworkManager.HEALTH_EVENT_TYPES.has(data.type)) {
      if (this.recentHealthEvents.length >= 24) this.recentHealthEvents.shift();
      const d = data as Record<string, unknown>;
      this.recentHealthEvents.push({ type: data.type, t: Date.now(), detail: `${d.shooterId ?? d.playerId ?? ''}→${d.targetId ?? ''} ${d.damage ?? ''}` });
    }
    // Avoid JSON.stringify on every message — tickUpdate arrives at 20Hz
    const handler = this.handlers[data.type] as ((d: ServerMessage) => void) | undefined;
    if (handler) {
      // A malformed-but-parseable message mustn't reach the connection's
      // onError path — one bad packet shouldn't cost a reconnect.
      try { handler(data); }
      catch (e) { logger.warn(`Handler threw for ${data.type}`, e); }
    } else {
      logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  private readonly handlers: { [K in ServerMessage['type']]: (data: Extract<ServerMessage, { type: K }>) => void } = {
    gameState: (data) => this.handleGameState(data),
    tickUpdate: (data) => this.handleTickUpdate(data),
    playerJoined: (data) => this.handlePlayerJoined(data),
    playerLeft: (data) => this.handlePlayerLeft(data),
    wireIds: (data) => { for (const [id, pid] of Object.entries(data.add)) this.wireIds.set(Number(id), pid); },
    teamUpdate: (data) => this.upsertRemotePlayer(data.playerId, { team: data.team }),
    playerRespawn: (data) => this.handlePlayerRespawn(data),
    playerHit: (data) => this.handlePlayerHit(data),
    buff: (data) => this.onBuff?.(data),
    yourHealth: (data) => this.onYourHealth?.(data.health),
    yourCharge: (data) => this.onYourCharge?.(data.charge),
    playerKill: (data) => this.handlePlayerKill(data),
    knockback: (data) => this.onKnockback?.(data.position, data.force, data.pull),
    jump: (data) => this.onPlayerJump?.(data.playerId, data.position),
    jetpack: (data) => this.onPlayerJetpack?.(data.playerId, data.position),
    projectileCreated: (data) => this.onProjectileCreated?.(data.projectileId, data.ownerId, data.position, data.velocity, data.weaponType, data.shotId),
    playerShot: (data) => this.onPlayerShot?.(data.id, data.weaponType, data.pos, data.dir),
    projectileDestroyed: (data) => this.onProjectileDestroyed?.(data.projectileId, data.shotId),
    snapshot: (data) => this.onSnapshot?.(data.players || [], data.timestamp || Date.now()),
    stateHash: (data) => this.onStateHash?.(data.hash, data.tick, data.playerCount, data.timestamp),
    correction: (data) => this.handleCorrection(data),
    inputSync: (data) => this.inputs.resend(data.lastSeq, (m) => this.send(m), this.isConnected()),
    claimAck: (data) => this.ledger.ack(data),
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
    chat: (data) => this.onChat?.(data.playerId, data.text, data.team === true, typeof data.vgs === 'string' ? data.vgs : undefined),
    flagUpdate: (data) => this.onFlagUpdate?.(data.flags),
    matchNotice: (data) => this.onMatchNotice?.(data.text),
    serverWarn: (data) => this.onServerWarn?.(data.text),
    // WT/RTC path of the 1008 identity reject — the close code is lost
    // on those tiers, so the server sends this before closing.
    sessionRejected: (data) => this.resetIdentity(data.reason),
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
    deployDown: (data) => this.onDeployDown?.(data.id, data.kind, data.team, data.respawnS),
    deployUp: (data) => this.onDeployUp?.(data.id),
    sensorPing: (data) => this.onSensorPing?.(data.id, data.team, data.targets),
    turretShot: (data) => this.onTurretShot?.(data.id, data.owner, data.targetId),
    sentryShot: (data) => this.onSentryShot?.(data.id, data.owner, data.x, data.y, data.z),
    mineBoom: (data) => this.onMineBoom?.(data.id, data.pos),
    deployHp: (data) => this.onDeployHp?.(data.id, data.hp, data.armor, data.src),
    // Server refused a hit claim — worth surfacing: a healthy client
    // should basically never see this, so it's a desync tell.
    shotRejected: (data) => {
      rejectCensus.total++;
      rejectCensus.byReason.set(data.reason, (rejectCensus.byReason.get(data.reason) ?? 0) + 1);
      rejectCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) this.ledger.confirmHit(data.targetId ?? '', data.shotId);
      logger.error(`shot rejected — predicted damage never applied`, {
        reason: data.reason,
        targetId: data.targetId,
        weapon: data.weaponType !== undefined ? WeaponType[data.weaponType] ?? data.weaponType : undefined,
        pingMs: this.telemetry.ping,
      });
      this.onShotRejected?.(data.reason, data.targetId, data.weaponType, data.health);
    },
    // Honest-lag discard (dead shooter/target) — not a reject, but the
    // predicted hit still needs clearing or the ledger warns phantom.
    claimDropped: (data) => {
      dropCensus.total++;
      dropCensus.byReason.set(data.reason, (dropCensus.byReason.get(data.reason) ?? 0) + 1);
      dropCensus.last = `${data.reason}${data.targetId ? ` →${data.targetId}` : ''}`;
      if (data.targetId || data.shotId) this.ledger.confirmHit(data.targetId ?? '', data.shotId);
      logger.warn(`claim dropped — predicted damage never applied`, {
        reason: data.reason, targetId: data.targetId,
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
    // A new gameState means a new room instance — both seq spaces
    // restart at 1 (hitSeq and tickSeq are per-room), so the prior
    // room's high watermarks must not gate it. A room hop without
    // reconnect would otherwise freeze every remote for the session.
    this.lastHitSeq = 0;
    this.lastTickSeq = -1;
    this.ledger.dropAll(false);
    this.resyncQuietUntil = 0; // truth landed — position claims are judged fresh
    const serverProto = data.protocolVersion ?? 0;
    if (serverProto !== PROTOCOL_VERSION) {
      const tries = Number(sessionStorage.getItem('fps-proto-reload') ?? '0');
      logger.warn(`Protocol mismatch: client=${PROTOCOL_VERSION} server=${serverProto} (attempt ${tries + 1})`);
      // Browser-only escape: headless harnesses (vitest, e2e replays) have
      // no location to reload — they get the warn + early return only.
      if (tries < 2 && typeof location !== 'undefined') {
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
    // v3 id space is per-room — a stale mapping would bind records to
    // the wrong body, so the roster snapshot replaces, not merges.
    this.wireIds.clear();
    if (data.wireIds) for (const [id, pid] of Object.entries(data.wireIds)) this.wireIds.set(Number(id), pid);
    if (data.players && Array.isArray(data.players)) {
      for (const player of data.players) {
        if (player.id === this.localPlayerId) continue;
        this.players.set(player.id, player);
      }
    }
    logger.warn(`raw gameState map: ${data.map ? JSON.stringify(data.map).slice(0, 300) : 'none'}`);
    this.onGameState?.(data.players || [], data.localPlayerState, { room: data.room, mode: data.mode, mapName: data.mapName, team: data.team, scores: data.scores, ffaScores: data.ffaScores, pickups: data.pickups, flags: data.flags, matchEndsAt: data.matchEndsAt, respawnMs: data.respawnMs, deployables: data.deployables, map: data.map });
  }

  private handleTickUpdate(data: { updates: TickUpdatePlayer[]; count?: number; ackSeq?: number; inputAck?: number; tickSeq?: number }): void {
    // Host loopback delivers ticks in per-frame bursts — feeding those to
    // the gap tracker turns frame hitches into fake "packet loss".
    if (this.ws?.tier !== 'host') this.telemetry.onTickArrival(Date.now());
    // Batched player updates from server (delta compressed)
    if (data.ackSeq !== undefined && data.ackSeq > 0) {
      this.pruneStateHistory(data.ackSeq);
    }
    // Tick-set confirm: the server consumed inputs ≤ inputAck — those
    // journal entries are dead weight and only matter to replay.
    if (data.inputAck !== undefined && data.inputAck > 0) {
      this.inputs.inputsAfter(data.inputAck);
    }
    if (!data.updates || !Array.isArray(data.updates)) return;
    const now = Date.now();
    // Snapshots must carry the SERVER timeline (tickSeq×50), not arrival
    // wall time — arrival stamps fold transport jitter into the rendered
    // path itself, which is the rubberband mechanism. The JSON path has
    // no tickSeq and keeps the arrival fallback (host/loopback: jitter≈0).
    const serverMs = data.tickSeq !== undefined ? data.tickSeq * SERVER_TICK_MS : now;
    // Pooled decode hands back its whole slots array + a live count —
    // entries past it are stale from earlier, larger frames.
    const n = data.count ?? data.updates.length;
    for (let i = 0; i < n; i++) {
      const u = data.updates[i]!;
      // v3 record ahead of its roster — can't build a body without an
      // identity, so it drops; the next record for that id resolves.
      if (!u.playerId) continue;
      this.applyTickPlayerUpdate(u, serverMs);
    }
  }

  private applyTickPlayerUpdate(u: TickUpdatePlayer, serverMs: number): void {
    // Defense-in-depth: server already excludes self from tickUpdate,
    // but skip local player here too in case of any server-side regression
    if (u.playerId === this.localPlayerId) return;
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
    this.onPlayerUpdate?.(u.playerId, u.position, u.rotation, serverMs, u.velocity);
  }

  // Upsert a remote player's roster entry, preserving fields the message
  // doesn't carry: merge order is patch → existing → default, so partial
  // updates (hit = health only) never stomp unrelated roster state.
  private upsertRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): void {
    if (!playerId || playerId === this.localPlayerId) return;
    const existing = this.players.get(playerId);
    // Mutate in place: a fresh object per player per tick was the
    // biggest steady-state allocation on the 20Hz wire path. Merge
    // order is unchanged — patch → existing → default.
    const next = existing ?? ({ id: playerId } as RemotePlayerState);
    if (!existing) {
      // Vec defaults are shared literals — clone or the first in-place
      // update corrupts every roster entry built after this one.
      next.position = { ...ROSTER_DEFAULTS.position! };
      next.rotation = { ...ROSTER_DEFAULTS.rotation! };
      next.velocity = { ...ROSTER_DEFAULTS.velocity! };
    }
    for (const k of ROSTER_FIELDS) {
      // Vec fields are handled below — storing the patch ref would alias
      // the decode pool (a pooled slot tracks whichever player decoded
      // LAST), so they fill the entry's own sub-objects instead.
      if (k === 'position' || k === 'rotation' || k === 'velocity') continue;
      (next as unknown as Record<string, unknown>)[k] = patch[k] ?? next[k] ?? ROSTER_DEFAULTS[k];
    }
    if (patch.position) { next.position.x = patch.position.x; next.position.y = patch.position.y; next.position.z = patch.position.z; }
    if (patch.rotation) { next.rotation.yaw = patch.rotation.yaw; next.rotation.pitch = patch.rotation.pitch; }
    if (patch.velocity) { next.velocity.x = patch.velocity.x; next.velocity.y = patch.velocity.y; next.velocity.z = patch.velocity.z; }
    if (!existing) this.players.set(playerId, next);
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

  /** Reconnect grace lets the server replay in-flight playerHit events —
   *  seq is per-room monotonic so a stale re-delivery can't double-apply.
   *  Reset on disconnect/gameState: a new room's seq restarts at 1, and a
   *  retained high watermark would silently drop every hit for the whole
   *  session — the "half my damage instances don't work" desync. */
  private lastHitSeq = 0;

  private handlePlayerHit(data: Extract<ServerMessage, { type: 'playerHit' }>): void {
    if (data.shooterId === this.localPlayerId) this.ledger.confirmHit(data.targetId);
    if (data.seq !== undefined) {
      if (data.seq <= this.lastHitSeq) {
        dedupCensus.hitSeqDrops++;
        logger.warn(`playerHit dropped as stale seq ${data.seq} <= ${this.lastHitSeq}`);
        return;
      }
      this.lastHitSeq = data.seq;
    }
    // Update REMOTE player health in storage (local player health handled by callback)
    this.upsertRemotePlayer(data.targetId, { health: data.health });
    this.onPlayerHit?.(data.shooterId, data.targetId, data.damage, data.health, data.armor);
  }

  private handlePlayerKill(data: Extract<ServerMessage, { type: 'playerKill' }>): void {
    // A kill IS the confirm — the fatal blow arrives as playerKill, not
    // playerHit, so the pending ledger would warn phantom otherwise.
    if (data.shooterId === this.localPlayerId) this.ledger.confirmHit(data.targetId);
    // Update REMOTE player state (local player death handled by callback)
    this.upsertRemotePlayer(data.targetId, { isDead: true, health: 0 });
    this.onPlayerKill?.(data.shooterId, data.targetId, data.weapon, data.air);
  }

  private handleCorrection(data: Extract<ServerMessage, { type: 'correction' }>): void {
    // Server rejected our position — snap to last valid state
    logger.warn(`Server correction at seq ${data.seq}: pos=(${data.position.x.toFixed(1)},${data.position.y.toFixed(1)},${data.position.z.toFixed(1)})`);
    this.pruneStateHistory(data.seq);
    this.onCorrection?.(data.seq, data.position, data.velocity, data.rotation, data.inputSeq, data.grounded);
  }

  private handleBinaryMessage(data: Uint8Array): void {
    this.lastRxAt = Date.now();
    this.rxBytes += data.length;
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
    const tick = decodeTickFrame(data, this.tickPool);
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
    this.sendBinary(encodePosition(position, rotation, velocity, seq, this.telemetry.ping, this.inputs.seq));

    // Send ping if interval elapsed
    if (now - this.lastPingSendTime >= this.PING_INTERVAL) {
      this.lastPingSendTime = now;
      this.send({ type: 'ping', timestamp: now });
    }

    // Client ops uplink ~0.1Hz — rides the position cadence so it only
    // ever fires while a game is actually streaming (no lobby noise).
    if (now - this.lastStatsSendTime >= NetworkManager.STATS_INTERVAL) {
      this.lastStatsSendTime = now;
      const s = this.statsSource?.() ?? { fps: 0, jsMs: 0 };
      this.send({
        type: 'clientStats',
        fps: s.fps, jsMs: s.jsMs,
        ping: this.telemetry.ping,
        loss: this.telemetry.packetLoss(now),
        jitter: this.telemetry.jitter(),
      });
    }
  }

  /** GameLoop feeds live perf numbers — the uplink above can't read
   *  the perf HUD itself without an import cycle the other direction. */
  statsSource: (() => { fps: number; jsMs: number }) | null = null;
  private lastStatsSendTime = 0;
  private static readonly STATS_INTERVAL = 10_000;

  /**
   * Send input move for client-side prediction.
   * Player calls this every frame — we only transmit on actual input change,
   * rate-limited to the position tick rate. Yaw/pitch already ride in the
   * binary position frame, so the rotation payload only matters when the
   * input bits themselves change.
   */
  sendInputMove(input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }, rotation: { yaw: number; pitch: number }): void {
    // Ungated sends during the connect window counted as drops — the
    // journal keeps the entry regardless, so skipping the fast path
    // loses nothing (inputSync re-requests on the server's word).
    if (!this.isConnected()) return;
    this.inputs.sendMove(input, rotation, (m) => this.send(m));
  }

  /** Journal entries with seq > `after` — what the server hadn't consumed
   *  when it issued a correction. Also prunes consumed entries. */
  inputsAfter(after: number): { t: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number } }[] {
    return this.inputs.inputsAfter(after);
  }

  /**
   * Get all REMOTE players (local player is never included)
   */
  getPlayers(): Map<string, RemotePlayerState> {
    return this.players;
  }

  /** Desync-checker heal: adopt the server's health for a remote roster
   *  entry. Routes through upsertRemotePlayer so the same field/defaults
   *  bookkeeping applies as a wire update. Health only — position stays
   *  correction-owned, isDead stays event-owned. */
  healRemoteHealth(playerId: string, health: number): void {
    // upsert would CREATE a stub for an unknown id — a heal must never
    // materialize a phantom roster row.
    if (!this.players.has(playerId)) return;
    this.upsertRemotePlayer(playerId, { health });
  }

  /** Desync-checker heal for LIVENESS: a killed/respawned event lost on
   *  the wire leaves the remote's isDead permanently wrong (roster health
   *  heals but the corpse flag is event-owned). The snapshot diff is the
   *  safety net — server isDead wins outright; the caller mirrors it into
   *  the RemotePlayer entity (respawn/playDeath visuals). Returns the
   *  flip direction so the caller knows which visual to run. */
  healRemoteLife(playerId: string, isDead: boolean, health: number, position?: { x: number; y: number; z: number }): 'revived' | 'killed' | null {
    const cur = this.players.get(playerId);
    if (!cur || cur.isDead === isDead) return null;
    // Server position is truth either way: a revive anchors at the
    // respawn point, a kill pins the corpse where the server saw it die.
    this.upsertRemotePlayer(playerId, {
      isDead, health,
      ...(position ? { position } : {}),
    });
    return isDead ? 'killed' : 'revived';
  }

  /**
   * Send shot event to server
   */
  sendShot(a: {
    targetId: string | null; position?: { x: number; y: number; z: number };
    velocity?: { x: number; y: number; z: number }; timestamp?: number;
    projectileId?: string | null; weaponType?: number; airtime?: number; shotId?: string;
  }): void {
    // Resync gap: until the replay lands our pos may be seconds of
    // prediction off server truth — every claim born here spawns
    // "implausible" and logs a reject. Drop it before the ledger sees
    // it; the returning gameState clears the window.
    if (performance.now() < this.resyncQuietUntil) { noteMutedClaim(); return; }
    // Pencil the prediction into the confirm ledger — a playerHit or
    // shotRejected clears it; silence past ~1.5s warns (see
    // sweepPendingHits).
    if (a.targetId && a.targetId !== 'local' && a.shotId) {
      this.ledger.noteShot(a.shotId, a.targetId, a.weaponType);
    }
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
    airtime?: number; power?: number; directHit?: boolean; shotId?: string;
  }): void {
    if (performance.now() < this.resyncQuietUntil) { noteMutedClaim(); return; } // same resync-gap mute as sendShot
    // Victim-named claims (beam tics, direct-hit blasts) ride the same
    // confirm ledger shots use — keyed per victim so a held beam is one
    // slot, not a map entry per tic. Splash claims with no named target
    // can't confirm by target and stay unledgered by design.
    if (a.excludeTargetId && a.excludeTargetId !== 'local') {
      this.ledger.noteShot(`aoe:${a.excludeTargetId}`, a.excludeTargetId, a.weaponType);
    }
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

  sendProjectileDestroy(projectileId: string, shotId?: string): void {
    this.send({ type: 'projectileDestroy', projectileId, shotId });
  }

  /** Deployable plant claim — sent when the pod lands and seats, so the
   *  position is the settled one the server will enforce caps/TTL on. */
  sendDeploy(kind: DeployKind, position: { x: number; y: number; z: number }): void {
    if (!this.connected) return;
    this.send({ type: 'deploy', kind, position, claimSeq: this.ledger.stamp('deploy') });
  }

  /** Repair claim — only the target id crosses the wire; the server
   *  re-derives range, LOS, team, heal amount, and pacing itself. */
  sendRepair(targetId: number): void {
    if (!this.connected) return;
    this.send({ type: 'repair', targetId, claimSeq: this.ledger.stamp('repair') });
  }

  /** Instant-skill ante mirror — skills.ts already spent the energy
   *  locally; the server applies the same drain to its shadow tank. */
  sendSkillUse(): void {
    if (!this.connected) return;
    this.send({ type: 'skillUse', claimSeq: this.ledger.stamp('skillUse') });
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

  /** Post-resync claim mute — see sendResync. */
  private resyncQuietUntil = 0;

  /** Offline authority — when there's no server, damage/heal claims apply
   *  locally through this hook instead of being dropped on the floor. */
  localAuthority: { envDamage(amount: number): void; heal(amount: number): void; respawn?(): void } | null = null;

  /** Deliberate respawn (K) — the server owns the kill; offline falls
   *  back to the local death path. */
  sendRespawn(): void {
    if (!this.connected) { this.localAuthority?.respawn?.(); return; }
    this.send({ type: 'respawn' });
  }

  /** Self-inflicted environment damage (crawler pounce, etc.) — the server
   *  clamps and applies it, then broadcasts the authoritative health. */
  sendEnvironmentDamage(amount: number, attacker?: string): void {
    if (!this.connected) { this.localAuthority?.envDamage(amount); return; }
    // Every self-reported damage claim logs — this channel carries blast
    // self-splash, creature bites, and bot melee, so the buffer answers
    // "did the client even claim it?" before any server-side question.
    logger.info(`envDamage claim: ${Math.round(amount * 10) / 10}`, { attacker });
    this.send({ type: 'environmentDamage', amount, attacker, claimSeq: this.ledger.stamp('environmentDamage') });
  }

  /** Client-claimed heal (nugget pickup) — keeps server health the truth. */
  sendHeal(amount: number): void {
    if (!this.connected) { this.localAuthority?.heal(amount); return; }
    this.send({ type: 'heal', amount, claimSeq: this.ledger.stamp('heal') });
  }

  /** Hit claim on a server-owned creature (netDriven ball). kx/ky/kz is the
   *  impulse the shot imparted — server clamps magnitude and rebroadcasts
   *  the new segment so every client sees the same shove. */
  sendCrawlerHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    this.send({ type: 'crawlerHit', id, damage, kx, ky, kz, claimSeq: this.ledger.stamp('crawlerHit', true) });
  }

  private creatureHitLogN = 0;
  sendCreatureHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    // Sampled claim log (1-in-16): chaingun-rate creature fire would flood
    // the buffer; a periodic line still proves claims are flowing and
    // carries the damage values being asserted.
    if ((this.creatureHitLogN++ & 15) === 0) {
      logger.info(`creatureHit claim x${this.creatureHitLogN}`, { id, damage });
    }
    this.send({ type: 'creatureHit', id, damage, kx, ky, kz, claimSeq: this.ledger.stamp('creatureHit', true) });
  }

  sendSnapshotRequest(): void {
    this.send({ type: 'snapshotRequest' });
  }

  /** Alt-tab catch-up: ask the server to replay the full world state
   *  (gameState + rosters) so the tab can snap to truth instead of
   *  rewinding the backgrounded interval. */
  sendResync(): void {
    // Position-dependent claims (shot/aoeShot) are muted until the
    // reply snaps us onto server truth — the cap is a fallback if the
    // replay never arrives.
    this.resyncQuietUntil = performance.now() + 5000;
    this.send({ type: 'resync' });
  }

  /** Discard the prediction journal — a correction arriving after this
   *  hard-snaps to the echoed state instead of replaying seconds of
   *  queued inputs at once (the "rewinding" storm after alt-tab). */
  dropInputJournal(): void {
    this.inputs.dropJournal();
  }

  sendChat(text: string, team = false, vgs?: string): void {
    this.send({ type: 'chat', text, team: team || undefined, vgs });
  }

  /** Mid-match room hop — the server re-seats this session and answers
   *  with a fresh gameState, which the normal (re)connect path rebuilds
   *  from. Returns false when there's no live socket (caller falls back
   *  to a reload join). */
  switchRoom(room: string, map?: string, bots?: number, mode?: string): boolean {
    if (!this.isConnected()) return false;
    this.send({ type: 'switchRoom', room, map, bots, mode });
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
  getTransportTier(): TransportKind | 'p2p' | 'host' | undefined {
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
