import { ChildLogger } from '../core/Logger.js';
import { encodePosition } from '../../../shared/wire.js';
import type { ClientMessage, ServerMessage, GameStatePlayer, LocalPlayerState, SnapshotPlayer, TransportKind } from '../../../shared/protocol.js';
import type { PickupKind } from '../../../shared/pickups.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { TieredTransport } from './tiers.js';
import type { GameTransport, TransportFactory } from './transport.js';
import { NetTelemetry } from './netTelemetry.js';
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';
import type { TeamId } from '../../../shared/teams.js';
import { ClaimLedger, noteMutedClaim } from './claimLedger.js';
import { InputStream } from './inputStream.js';
import { WireIn } from './wireIn.js';

const logger = new ChildLogger('NetworkManager');

// Roster upsert fields + fresh-player defaults (optional fields default undefined).
const ROSTER_FIELDS = ['internalId', 'name', 'position', 'rotation', 'velocity', 'isDead',
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
  /** Chosen display name (cosmetic — ids are still the identity). */
  name?: string;
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
  public onChat: ((playerId: string, text: string, team: boolean, vgs: string | undefined, muted: boolean) => void) | null = null;
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
  public onMapUpdate: ((map: { mapName?: string; silent?: boolean; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: import('../../../shared/mapSpec.js').StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number }; terrainTex?: string; sky?: string; interiors?: import('../../../shared/mapSpec.js').InteriorSpec[] }) => void) | null = null;
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
  public onStateHash: ((hash: string, tick: number, playerCount: number, timestamp: number, ballHash?: string, creatureHash?: string, deployHash?: string, flagHash?: string, pickupHash?: string, creatureFields?: [number, string, string, boolean, string | null][], deployFields?: [number, string, string, string][]) => void) | null = null;
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
  private stateHistory: Map<number, { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; rotation: { yaw: number; pitch: number } }> = new Map();
  private readonly STATE_HISTORY_MAX = 120; // ~6s at 20Hz
  /** Inbound dispatch — owns the handler table, wire-id roster, tick
   *  decode pool, and per-room seq watermarks (see wireIn.ts). */
  private readonly wireIn = new WireIn(this);

  // --- Ping measurement ---
  private lastPingSendTime: number = 0;
  private readonly PING_INTERVAL = 2000; // Send ping every 2 seconds

  constructor() {
    // Player ID + token persist in localStorage — a claimed identity
    // survives F5, browser restarts, and (with FPS_SECRET) server restarts.
    const stored = settings.get('fps-player-id');
    if (stored) {
      this.localPlayerId = stored;
    } else {
      this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
      settings.set('fps-player-id', this.localPlayerId);
    }
    // Session token issued by the server on first join — required to
    // reclaim a grace-period slot after F5/reconnect
    this.sessionToken = settings.get('fps-session-token') || null;
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
              name: settings.get('fps-name').trim() || undefined,
              token: this.sessionToken ?? undefined,
              // Offset cursor — a reclaim carries the last reliable ev we
              // saw so the server replays only the missed frames.
              resumeSeq: this.sessionToken ? this.wireIn.evWatermark : undefined,
              room: urlParams.room ?? undefined,
              mode: urlParams.mode ?? undefined,
              map: urlParams.map ?? undefined,
              bots: urlParams.bots,
              unlisted: urlParams.unlisted || undefined,
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
            this.wireIn.resetForReconnect(); // a reconnect starts fresh seq spaces
            // Claims sent on the dead lane are void — the server replays
            // in-flight hits, not lost ones; stamped claims classify as
            // transport-lost, not unconfirmed.
            this.ledger.dropAll(true);
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
          onMessage: (data) => this.wireIn.message(data),
          onBinaryMessage: (data) => this.wireIn.binary(data),
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
    settings.remove('fps-player-id');
    settings.remove('fps-session-token');
    this.sessionToken = null;
    this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
    settings.set('fps-player-id', this.localPlayerId);
    logger.info(`Session rejected (${reason}) — rejoining as ${this.localPlayerId}`);
  }

  disconnect(): void {
    this.onlineExpected = false;
    this.lastRxAt = 0;
    // The watchdog has nothing to watch while deliberately offline —
    // reconnect re-arms it via the ??= in connect().
    if (this.stallTimer !== null) { clearInterval(this.stallTimer); this.stallTimer = null; }
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
    'chat', 'deploy', 'classUpdate', 'perkUpdate', 'respawn', 'throwFlag',
    'switchRoom', 'resync', 'snapshotRequest',
  ]);
  private pendingCmds: ClientMessage[] = [];
  private static readonly MAX_PENDING_CMDS = 16;

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
  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.wireIn.recentEvents();
  }

  // ---- WireIn host surface — the whole back-channel the dispatcher
  // needs (roster store, ledgers/journal, telemetry, session state).

  /** Any inbound frame proves liveness + feeds the byte counter. */
  noteRx(bytes: number): void {
    this.lastRxAt = Date.now();
    this.rxBytes += bytes;
  }

  /** Tick-arrival cadence — host loopback delivers ticks in per-frame
   *  bursts, which would read as fake packet loss in the gap tracker. */
  tickArrived(): void {
    if (this.ws?.tier !== 'host') this.telemetry.onTickArrival(Date.now());
  }

  pongReceived(timestamp: number): void {
    this.telemetry.onPong(timestamp, Date.now());
  }

  resendInputs(lastSeq: number): void {
    this.inputs.resend(lastSeq, (m) => this.send(m), this.isConnected());
  }

  ackInputs(inputAck: number): void {
    this.inputs.inputsAfter(inputAck);
  }

  ackPositionSeq(seq: number): void {
    this.pruneStateHistory(seq);
  }

  confirmClaimHit(targetId: string, shotId?: string): void {
    this.ledger.confirmHit(targetId, shotId);
  }

  ackClaim(msg: Parameters<ClaimLedger['ack']>[0]): void {
    this.ledger.ack(msg);
  }

  dropClaims(transportLost: boolean): void {
    this.ledger.dropAll(transportLost);
  }

  clearResyncQuiet(): void {
    this.resyncQuietUntil = 0;
  }

  /** Server-issued session token — persisted so a reconnect can reclaim
   *  the grace-period seat. */
  acceptSessionToken(token: string): void {
    this.sessionToken = token;
    settings.set('fps-session-token', token);
  }

  rejectSession(reason?: string): void {
    this.resetIdentity(reason);
  }

  /** gameState's authoritative roster — replaces, never merges (v3 ids
   *  and per-room state would alias across a merge). */
  remoteReset(players: GameStatePlayer[] | undefined): void {
    this.players.clear();
    if (players) for (const p of players) {
      if (p.id === this.localPlayerId) continue;
      this.players.set(p.id, p);
    }
  }

  remoteHas(playerId: string): boolean { return this.players.has(playerId); }
  remoteDelete(playerId: string): void { this.players.delete(playerId); }

  // Upsert a remote player's roster entry, preserving fields the message
  // doesn't carry: merge order is patch → existing → default, so partial
  // updates (hit = health only) never stomp unrelated roster state.
  upsertRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): void {
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

  /** Wire-feed seam for recorded streams (.rec): pushes one message
   *  through the exact live dispatch path — handlers can't tell the
   *  difference between a capture and a socket. Dev replay only. */
  replayWireMessage(data: ServerMessage | Uint8Array): void {
    this.wireIn.dispatch(data);
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
  inputsAfter(after: number, gapMs = 0): { t: number; input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number } }[] {
    return this.inputs.inputsAfter(after, gapMs);
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
   *  back to the local death path. `hold` (the L bind) parks the corpse:
   *  no auto-respawn until a plain dead-state press releases it. */
  sendRespawn(hold = false): void {
    if (!this.connected) { this.localAuthority?.respawn?.(); return; }
    this.send({ type: 'respawn', hold: hold || undefined });
  }

  /** Flag toss claim (G) — server resolves the arc. Offline the caller
   *  routes to the local flag sims (FlagRunBridge/CtfFlags) instead. */
  sendThrowFlag(): void {
    if (!this.connected) {return;}
    this.send({ type: 'throwFlag' });
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
  switchRoom(room: string, map?: string, bots?: number, mode?: string, unlisted?: boolean): boolean {
    if (!this.isConnected()) return false;
    this.send({ type: 'switchRoom', room, map, bots, mode, unlisted: unlisted || undefined });
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

  private pruneStateHistory(ackSeq: number): void {
    // Map iterates in insertion order and seqs increase monotonically —
    // stop at the first unacked entry instead of scanning the whole map.
    for (const seq of this.stateHistory.keys()) {
      if (seq > ackSeq) break;
      this.stateHistory.delete(seq);
    }
  }
}
