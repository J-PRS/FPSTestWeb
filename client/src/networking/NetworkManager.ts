import { ChildLogger } from '../core/Logger.js';
import { encodePosition, encodeInputMove, encodeWireJson, encodePosClaim, encodeShot, WIRE_JUMP, WIRE_JETPACK, WIRE_JSON } from '../../../shared/wire.js';
import type { ClientMessage, ServerMessage, GameStatePlayer, IntelContact, LocalPlayerState, SnapshotPlayer, TransportKind } from '../../../shared/protocol.js';
import type { PickupKind } from '../../../shared/pickups.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { TieredTransport, benchTier, rewardTier } from './tiers.js';
import { WorkerTransport } from './WorkerTransport.js';
import type { GameTransport, TransportFactory } from './transport.js';
import { NetTelemetry } from './netTelemetry.js';
import { urlParams, readJoinSpec } from '../core/params.js';
import { settings } from '../core/settings.js';
import type { TeamId } from '../../../shared/teams.js';
import { ClaimLedger, noteMutedClaim } from './claimLedger.js';
import { confirmDamageEcho, sweepDamageEchoes } from '../game/parity.js';
import { InputStream } from './inputStream.js';
import { WireIn } from './wireIn.js';
import { WORLD_MODEL, declaredFieldNames, checkIntent } from '../../../shared/worldModel.js';
import { armLoafDiag } from './loafDiag.js';
import { recWireOut } from '../core/telemetry.js';
import type { SpawnPoint,StructureSpec,InteriorSpec,WeatherSpec,AtmosphereSpec,WaterSpec } from '../../../shared/mapSpec.js';
import type { ResultToken } from '../../../shared/resultToken.js';
import { UdpLane } from './udpLane.js';

const logger = new ChildLogger('NetworkManager');

// Roster upsert fields + fresh-player defaults (optional fields default
// undefined). The field list comes from the player kind's wire declaration -
// every field the roster can carry is exactly spawn ∪ update ∪ roster, so a
// new declared field patches through here without a second list to update.
const ROSTER_FIELDS = declaredFieldNames(WORLD_MODEL['player']!, 'spawnFields', 'updateFields', 'rosterFields');
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
  /** Chosen display name (cosmetic - ids are still the identity). */
  name?: string;
  internalId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  velocity: { x: number; y: number; z: number };
  isDead: boolean;
  health: number;
  ping?: number;
  ski?: number;
  /** Held jet input from the tick frame - remote DR burns thrust on it. */
  jet?: number;
  /** Status bitmask - STATUS_* bits (shared/status.ts). */
  status?: number;
  team?: TeamId;
  /** Server-reported connect tier (join transport claim) - scoreboard NET.
   *  'ws+udp' composite when that session's udp lane is live. */
  transport?: string;
  /** Armor tier from playerJoined/gameState - remote model scale cue. */
  armorClass?: string;
  /** Server-known current weapon - draw the real gun before a shot edge. */
  weapon?: number;
  /** Server-side sheep meter (bots only) - how pedestrian this bot is. */
  sheep?: number;
  /** Wall-clock the position field last changed on the wire - the
   *  stateHash [sim]-pos audit gates on it: a stale record vs a fresh
   *  snapshot is wire starvation, not replica divergence. */
  posAt?: number;
  /** Headhunt held-token count - arrives via gameState row + playerHeld
   *  edges; undefined outside headhunt (no badge drawn). */
  held?: number;
}

/**
 * Network manager - owns the transport (WebSocketConnection) directly.
 * One transport, one protocol layer; the binary codec lives in shared/wire.ts.
 */
export class NetworkManager {
  private ws: GameTransport | null = null;
  private localPlayerId: string;
  private sessionToken: string | null;
  private connected = false;
  /** performance.now() at the live-join ack - parity counters need it to
   *  skip join-race echoes (events that happened before prediction
   *  existed can't be "unpredicted"). */
  private connectedAtMs = 0;
  private tierRewarded = false;
  msSinceConnect(): number { return Date.now() - this.connectedAtMs; }
  /** ms since the last non-inputSync inbound - wire starvation clock.
   *  Stamps/expiry horizons that outlive a silent wire must not expire
   *  mid-stall: the echo was delayed, not refused. */
  msSinceLiveRx(): number { return this.wireIn.lastLiveRxAt > 0 ? Date.now() - this.wireIn.lastLiveRxAt : Infinity; }
  /** Loadout perk, announced at join so the server can enforce resist/heal. */
  joinPerk: (() => string) | null = null;
  joinClass: (() => string) | null = null;
  joinSkill: (() => string) | null = null;
  /** REMOTE players only - local player is never stored here */
  private players: Map<string, RemotePlayerState> = new Map();
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number, health: number, armor?: number, predicted?: boolean) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string, weapon?: number, air?: number, steal?: boolean) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, armorClass?: string) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number, shotId?: string, pellet?: number, age?: number, t?: number) => void) | null = null;
  /** Server refused a claim - `health` is the authoritative resync value
   *  (rejected predicted self-splash leaves client health divergent). */
  public onShotRejected: ((reason: string, targetId: string | undefined, weaponType: number | undefined, health: number | undefined, shotId?: string) => void) | null = null;
  public onPlayerShot: ((id: string, weaponType: number | undefined, pos: { x: number; y: number; z: number } | undefined, dir: { x: number; y: number; z: number } | undefined) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string, shotId?: string, position?: { x: number; y: number; z: number }, age?: number) => void) | null = null;
  /** Belt-sticky combo - rider server id glued dead-center onto host id. */
  public onProjRide: ((riderId: string, hostId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  /** Headhunt held-count edge - roster patch already landed; this is the
   *  local-player + HUD notification half (locals aren't in the map). */
  public onPlayerHeld: ((playerId: string, n: number) => void) | null = null;
  public onKnockback: ((position: { x: number; y: number; z: number }, force: number, pull?: boolean, yank?: boolean) => void) | null = null;
  public onChat: ((playerId: string, text: string, team: boolean, vgs: string | undefined, muted: boolean) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number, velocity?: { x: number; y: number; z: number }) => void) | null = null;
  public onGameState: ((players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; instagib?: boolean; gungame?: boolean; igun?: boolean; mapName?: string; team?: TeamId; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number>; pickups?: { id: number; pos: { x: number; y: number; z: number }; kind?: PickupKind; val?: number }[]; flags?: { team: TeamId; pos: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]; matchEndsAt?: number; respawnMs?: number; deployables?: { id: number; owner: string; kind: DeployKind; pos: { x: number; y: number; z: number }; team?: string }[]; map?: { mode?: string; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number }; ambient?: Record<string, number>; terrain?: string; spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] }; terrainTex?: string; terrainPreset?: number; sky?: string; weather?: WeatherSpec; atmosphere?: AtmosphereSpec } }) => void) | null = null;
  public onTeamScore: ((scores: { alpha: number; bravo: number }, winAt: number) => void) | null = null;
  public onMatchEnd: ((winner: TeamId | 'draw', scores: { alpha: number; bravo: number }) => void) | null = null;
  public onMatchStart: ((mode: string, scores: { alpha: number; bravo: number }) => void) | null = null;
  /** Signed match receipt - pairs with a demo for leaderboard submissions. */
  public onMatchToken: ((token: ResultToken) => void) | null = null;
  /** Server-owned flag state (CTF rooms) - pos/state/carrier per team. */
  public onFlagUpdate: ((flags: { team: TeamId; pos: { x: number; y: number; z: number }; home?: { x: number; y: number; z: number }; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[]) => void) | null = null;
  /** Conquest lattice roster - owner/build/hp/core per node, whole grid. */
  public onNodeUpdate: ((nodes: { id: number; gx: number; gz: number; pos: { x: number; y: number; z: number }; owner: 'alpha' | 'bravo' | 'neutral'; hp: number; maxHp: number; build: number; core: boolean }[]) => void) | null = null;
  public onMatchNotice: ((text: string, meta?: { multi?: number; actor?: string; ann?: string }) => void) | null = null;
  /** Server anti-cheat flag - renders as a banner, not a disconnect. */
  public onServerWarn: ((text: string) => void) | null = null;
  public onPickupSpawn: ((id: number, pos: { x: number; y: number; z: number }, kind?: PickupKind, val?: number, vel?: { x: number; y: number; z: number }) => void) | null = null;
  /** Powerup applied to US - server-owned buffs (armor/heal/timed). */
  public onBuff: ((msg: { kind: 'heal' | 'armor' | 'regen' | 'dd' | 'shield'; armor?: number; health?: number; until?: number }) => void) | null = null;
  /** Server-owned heal echo (regen/mend/powerup tick in the sim) - keeps
   *  local hp converged between discrete hit events. */
  public onYourHealth: ((health: number, armor?: number) => void) | null = null;
  /** Wall time of the last event-driven health write (playerHit or
   *  yourHealth). The stateHash-diff heal defers to it - its snapshot is
   *  a tick-interval stale and must not resurrect an older hp over a
   *  fresher event (the 'hp drop' ping-pong that warns). */
  public lastHealthEventAt = 0;
  public onYourCharge: ((charge: number) => void) | null = null;
  /** Server pool-ammo echo ([weaponType, rounds]) - snaps the predicted
   *  pool back to truth after rejects/accrual drift, ~2Hz while below cap. */
  public onYourAmmo: ((ammo: [number, number][]) => void) | null = null;
  public onGunRung: ((rung: number, wt?: number) => void) | null = null;
  public onPickupGone: ((id: number, by: string | null) => void) | null = null;
  public onFfaScore: ((scores: Record<string, number> | undefined, winAt: number, deltaId?: string, deltaScore?: number, rm?: boolean) => void) | null = null;
  public onFfaMatchEnd: ((winner: string, scores: Record<string, number>) => void) | null = null;
  /** Admin hot-reload - structures/arena changed mid-match; rebuild them. */
  public onMapUpdate: ((map: { mapName?: string; silent?: boolean; bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } }; structures?: StructureSpec[]; arena?: { x: number; z: number; radius: number } | null; killY?: number; terrain?: string; heightScale?: number; tileSize?: number; fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] }; water?: WaterSpec; spawns?: SpawnPoint[]; teamSpawns?: { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] }; terrainTex?: string; terrainPreset?: number; sky?: string; weather?: WeatherSpec; atmosphere?: AtmosphereSpec; interiors?: InteriorSpec[] }) => void) | null = null;
  // Server-owned deployables - rendered as dumb visuals client-side;
  // the sim (firing/damage) stays authoritative on the server.
  public onDeploySpawn: ((id: number, owner: string, kind: DeployKind, pos: { x: number; y: number; z: number }, team?: TeamId) => void) | null = null;
  public onDeployGone: ((id: number) => void) | null = null;
  /** Base asset shelled into a hulk / stood back up - wreck↔live visuals. */
  public onDeployDown: ((id: number, kind: DeployKind, team: string | undefined, respawnS: number) => void) | null = null;
  public onDeployUp: ((id: number) => void) | null = null;
  /** Base sensor sweep - hostiles inside a mast's radius, relayed to its team. */
  public onSensorPing: ((id: number, team: string | undefined, targets: { id: string; x: number; y: number; z: number }[]) => void) | null = null;
  /** Server-truth IFF contacts - the ONLY thing allowed to un-hide an
   *  enemy marker. seen = live this sweep; mem = lingering last-known. */
  public onIntel: ((seen: IntelContact[], mem: IntelContact[]) => void) | null = null;
  /** Server sim fired a remote sentry - paint the rocket at the deployable. */
  public onTurretShot: ((id: number, owner: string, targetId: string) => void) | null = null;
  public onSentryShot: ((id: number, owner: string, x: number, y: number, z: number) => void) | null = null;
  public onMortarShot: ((id: number, owner: string, vx: number, vy: number, vz: number) => void) | null = null;
  /** Server-owned mine exploded - explosion FX only; damage flows via the
   *  normal playerHit/knockback channel. */
  public onMineBoom: ((id: number, pos: { x: number; y: number; z: number }) => void) | null = null;
  /** Server's jump pad discharged - launch FX only; the body's new
   *  velocity arrives through the normal sim/impulse channel. */
  public onPadBoing: ((id: number, pos: { x: number; y: number; z: number }, n: { x: number; y: number; z: number }) => void) | null = null;
  public onLoiterDive: ((id: number, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }) => void) | null = null;
  /** Server measured a hard landing on a shadow - remote slam dressing
   *  (thud + dust); the owner already predicted theirs locally. */
  public onLanded: ((playerId: string, pos: { x: number; y: number; z: number }, impact: number) => void) | null = null;
  /** Server's vitals table for a deployable - repair heals echo back
   *  through this; armor is the repair-tool overheal pool. */
  public onDeployHp: ((id: number, hp: number, armor: number, src?: string) => void) | null = null;
  public onSnapshot: ((players: SnapshotPlayer[], timestamp: number) => void) | null = null;
  public onStateHash: ((hash: string, tick: number, playerCount: number, timestamp: number, replica?: Record<string, { hash: string; fields?: unknown[][] } | undefined>) => void) | null = null;
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
  public lastPositionSendTime = 0;
  private readonly POSITION_SEND_INTERVAL = 50; // 20Hz - extrapolation covers the gap
  private readonly STILL_SEND_INTERVAL = 250; // 4Hz parked heartbeat - server sees identical truth
  private lastSentState?: { px: number; py: number; pz: number; yaw: number; pitch: number };
  // Tick ARRIVAL cadence is the server loop's 50ms interval (20Hz).
  private readonly telemetry = new NetTelemetry(50);
  private hasLoggedConnectionError = false;

  // --- Client-side prediction: sequence tracking + state history ---
  private sequenceCounter = 0;
  // (The old stateHistory map was deleted: written and pruned on ack but
  // never read - reconciliation replays the input journal, not stored
  // snapshots.)
  /** Inbound dispatch - owns the handler table, wire-id roster, tick
   *  decode pool, and per-room seq watermarks (see wireIn.ts). */
  private readonly wireIn = new WireIn(this);
  /** Highest server tick applied - e2e probes wait on it to prove the
   *  binary lane flows. Lives in wireIn after the dispatch extraction. */
  get lastTickSeq(): number { return this.wireIn.tickSeq; }
  /** Contained wire-handler throws - the Alt+Q census reads it. */
  get handlerThrows(): number { return this.wireIn.handlerThrows; }
  /** Boot only: queue inbound until wireNetworkHandlers binds the deps -
   *  lets the socket fly during init without dropping world-bearing
   *  messages on unbound hooks. markWireReady flushes in order. */
  armWireQueue(): void { this.wireIn.armEarlyQueue(); }
  markWireReady(): void { this.wireIn.markReady(); }
  /** Reset the JSON-lane reconnect counter when the lane recovers. */
  resetJsonLaneCounter(): void { this.jsonLaneReconnects = 0; }
  /** Server position correction - the dispatch lives in wireIn but is
   *  routed through here so tests can wrap/count it. */
  handleCorrection(data: Parameters<WireIn['handleCorrection']>[0]): void {
    this.wireIn.handleCorrection(data);
  }

  // --- Ping measurement ---
  private lastPingSendTime = 0;
  private readonly PING_INTERVAL = 2000; // Send ping every 2 seconds

  constructor() {
    armLoafDiag();
    // Player ID + token persist in localStorage - a claimed identity
    // survives F5, browser restarts, and (with FPS_SECRET) server restarts.
    const stored = settings.get('fps-player-id');
    if (stored) {
      this.localPlayerId = stored;
    } else {
      this.localPlayerId = `player_${Math.random().toString(36).slice(2, 11)}`;
      settings.set('fps-player-id', this.localPlayerId);
    }
    // Session token issued by the server on first join - required to
    // reclaim a grace-period slot after F5/reconnect
    this.sessionToken = settings.get('fps-session-token') || null;
  }

  setPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  /** `makeTransport` swaps the wire: P2P passes a factory that builds a
   *  LoopbackTransport (host) or DataChannelTransport (guest) instead of
   *  a real WebSocket. Same callbacks, same protocol, different pipe. */
  // True once connect() has been asked for a session - distinguishes
  // 'never went online' (offline mode) from 'online and currently down'
  // so the HUD can warn only in the second case.
  private onlineExpected = false;
  // Silence watchdog - a black-holed socket (dead tunnel/proxy, half-open
  // TCP) keeps readyState OPEN and never fires close: no banner, no
  // reconnect, frozen game. Any inbound frame proves liveness; >STALL_MS
  // of nothing while "connected" forces a teardown + re-probe.
  private lastRxAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Outer-reconnect backoff - a transport-level connect failure (dead
   *  worker spawn, dead endpoint) must not hot-loop a 1Hz retry. */
  private retryAt = 0;
  private retryStreak = 0;
  private workerCrashStreak = 0;
  private crashWarned = false;
  /** Set when isConnected() first reads false - the 10s arm before the
   *  outer respawn so an inner lane's own reconnect always wins. */
  private deadSince: number | null = null;
  private jsonLaneReconnects = 0;
  private static readonly STALL_MS = 4000;
  /** JSON events (ping/stateHash/hits/spawns) land several times a second
   *  in any live room - 10s of silence while ticks flow is a dead lane,
   *  never a quiet match. */
  private static readonly JSON_STALL_MS = 10_000;
  private lastUrl: string | null = null;
  private lastFactory: TransportFactory | undefined;
  private lastResolveUrl: (() => Promise<string | null>) | undefined;

  /** Admission gate - invoked before EVERY dial (initial join + the
   *  stall loop's retries). Deploy-check hook: a version bump at the
   *  connect boundary reloads before this client gets admitted. */
  public onPreConnect: (() => Promise<unknown> | unknown) | null = null;

  connect(url: string, makeTransport?: TransportFactory, resolveUrl?: () => Promise<string | null>): Promise<void> {
    this.onlineExpected = true;
    this.lastUrl = url;
    this.lastFactory = makeTransport;
    this.lastResolveUrl = resolveUrl;
    this.lastRxAt = Date.now();
    this.stallTimer ??= setInterval((): void => this.checkStall(), 1000);
    const dial = (): Promise<void> => new Promise((resolve, reject): void => {
      try {
        // Default: the whole transport stack runs on the net worker -
        // Blink starves ws dispatch under input/render load, so the wire
        // lives on its own event loop. Tests/node have no Worker.
        const factory = makeTransport ?? ((cfg): TieredTransport | WorkerTransport => typeof Worker === 'undefined' ? new TieredTransport(cfg) : new WorkerTransport(cfg));
        this.ws = factory({
          url,
          resolveUrl,
          onConnect: (): void => {
            this.connected = true;
            this.connectedAtMs = Date.now();
            this.tierRewarded = false;
            // A fresh socket counts as alive until proven silent - the
            // inner transport's own reconnect doesn't re-stamp this, so
            // without it the stall watchdog inherited the DEAD lane's
            // silence window and reaped a healthy reseat seconds after
            // its onConnect.
            this.lastRxAt = Date.now();
            this.retryStreak = 0;
            this.workerCrashStreak = 0;
            this.crashWarned = false;
            this.hasLoggedConnectionError = false;
            logger.info(`Connected as ${this.localPlayerId}`);
            this.lastDownReason = null;
            // Queued reliable commands ride the live lane after the join
            // (bounded 16 - a dead lane never earns an unbounded backlog).
            for (const q of this.pendingCmds) {this.send(q);}
            this.pendingCmds = [];
            resolve();
          },
          onDisconnect: (code, reason): void => {
            // 1008 = server rejected our session - drop stored identity so
            // auto-reconnect joins fresh instead of looping on bad creds
            if (code === 1008) {this.resetIdentity(reason);}
            // A reasoned close ('server restarting', 'kicked') reads
            // differently than a dead pipe - the banner names it.
            this.lastDownReason = code !== undefined && code >= 1000 && reason ? reason : null;
            logger.info('Disconnected', { code, reason });
            // Module-load failures (dead vite serving the page) fire a
            // blank worker 'error' before any worker code runs - every
            // outer reconnect spawns another doomed worker forever.
            this.workerCrashStreak = reason === 'net worker crashed' ? this.workerCrashStreak + 1 : 0;
            this.connected = false;
            this.wireIn.resetForReconnect(); // a reconnect starts fresh seq spaces
            this.inputs.reset(); // journaled inputs + change-only edge state die with the lane
            // Claims sent on the dead lane are void - the server replays
            // in-flight hits, not lost ones; stamped claims classify as
            // transport-lost, not unconfirmed.
            this.ledger.dropAll(true);
            // Same for the cadence metric - else the dead period counts as
            // missed ticks and loss reads ~100% right after rejoining.
            this.telemetry.reset();
            // Drop the wire roster - kept entries pass the liveness gate
            // on their stale ping, so their bodies freeze at the last
            // snapshot for the whole 60s stale window and their HUD dots
            // freeze with them. gameState re-seeds the map on reconnect.
            this.players.clear();
          },
          onError: (error): void => {
            if (!this.hasLoggedConnectionError) {
              logger.error('Connection error', error);
              this.hasLoggedConnectionError = true;
            }
            reject(error);
          },
          onMessage: (data): void => this.wireIn.message(data),
          onBinaryMessage: (data): void => this.wireIn.binary(data),
          // Worker-measured RTT - wire-honest (no main-loop queue delay).
          onRtt: (rtt): void => this.telemetry.onPong(Date.now() - rtt, Date.now()),
        });
        this.ws.connect(url);
        // The join posts NOW - it parks in the tier transport's pending
        // queue and rides out AT connect instead of paying a starved
        // main-thread 'up' hop (~1.5-2.5s while the GLB parse owns main).
        // Ordering is preserved: join is the first frame queued, the
        // pendingCmds flush lands behind it. 'transport' is stamped by the
        // tier at flush - the probe hasn't picked a lane yet.
        this.ws.send(JSON.stringify(this.joinMsg()));
      } catch (error) {
        reject(error);
      }
    });
    // Sync path when no gate is wired - a gate hook defers the dial by
    // a microtask, and the stall-loop tests assert transports exist
    // synchronously.
    const pre = this.onPreConnect;
    return pre ? Promise.resolve(pre()).then(dial) : dial();
  }

  /** Server says our stored identity is no good - burn id+token so the
   *  next connect joins fresh. Reached via close(1008) on WS and via the
   *  `sessionRejected` message on WT/RTC, where the close code is lost. */
  private resetIdentity(reason?: string): void {
    settings.remove('fps-player-id');
    settings.remove('fps-session-token');
    this.sessionToken = null;
    this.localPlayerId = `player_${Math.random().toString(36).slice(2, 11)}`;
    settings.set('fps-player-id', this.localPlayerId);
    logger.info(`Session rejected (${reason}) - rejoining as ${this.localPlayerId}`);
  }

  disconnect(): void {
    this.onlineExpected = false;
    this.lastRxAt = 0;
    // The watchdog has nothing to watch while deliberately offline -
    // reconnect re-arms it via the ??= in connect().
    if (this.stallTimer !== null) { clearInterval(this.stallTimer); this.stallTimer = null; }
    this.ws?.disconnect();
    this.ws = null;
    this.connected = false;
    this.udpLane.close();
  }

  private checkStall(): void {
    // Outer reconnect driver: when the transport-level connect() fails
    // outright - crashed/blocked worker spawn, a dead endpoint - nothing
    // else retries (the inner lanes' own loops never started). Without
    // this, one watchdog tick converts a transient failure into a
    // permanently dead session (observed: offline emulation killed the
    // worker module fetch, connect rejected, 30s+ dead). The 10s arm
    // keeps it BEHIND the inner lane's own reconnect loop (~3-4s per
    // attempt): a live transport re-seating itself must never race a
    // fresh outer connect (the parallel-join flood).
    if (!this.isConnected() && this.onlineExpected && this.lastUrl) {
      this.outerReconnect();
      return;
    }
    this.deadSince = null;
    if (!this.isConnected() || !this.lastUrl) {return;}
    // Hidden tabs throttle this interval AND starve the network pump -
    // the "silent" window is throttling, not a dead socket. A real death
    // still trips wt.closed/the pumps, and the visibility resync covers
    // whatever's left on regain.
    if (document.hidden) {
      this.hiddenKeepalive();
      return;
    }
    const stall = this.laneStall();
    if (!stall.laneDead && (stall.lastRx === 0 || stall.silent < NetworkManager.STALL_MS)) {
      this.noteHealthyTier();
      return;
    }
    this.escalateLane(stall);
  }

  /** Transport-level reconnect for a session whose connect() never
   *  produced a live lane. Backoff is exponential to 15s; a worker that
   *  never reports 'up' means the page backend is gone - stop spawning
   *  doomed workers and say so once. */
  private outerReconnect(): void {
    if (this.workerCrashStreak >= 3) {
      if (!this.crashWarned) {
        this.crashWarned = true;
        logger.error('net worker failed to spawn 3× - the page backend (vite) is unreachable; reload the tab to retry');
      }
      return;
    }
    this.deadSince ??= Date.now();
    const now = Date.now();
    if (now - this.deadSince < 10_000 || now < this.retryAt) {return;}
    this.retryAt = now + Math.min(1000 * 2 ** this.retryStreak, 15_000);
    this.retryStreak += 1;
    logger.info(`outer reconnect (transport dead ${Math.round((now - this.deadSince) / 1000)}s) - attempt ${this.retryStreak}`);
    const url = this.lastUrl!;
    // Kill the old transport before replacing it - an abandoned lane
    // keeps auto-reconnecting with these callbacks still bound: its
    // joins fight the live session for the seat and its close events
    // tear down roster/ledger state (the join-timeout flap loop).
    this.ws?.disconnect();
    this.ws = null;
    this.connect(url, this.lastFactory, this.lastResolveUrl).catch((): void => { /* the stall loop owns retries */ });
  }

  /** Hidden-tab liveness: the position pump carries our ping and stops
   *  with rAF, so a hidden tab reads as 60s of silence and gets
   *  idle-reaped. Timers still fire (≥1Hz throttled) - keep the
   *  app-level ping alive from here instead. If intensive throttling
   *  suspends timers entirely the silence is real and the reap is right. */
  private hiddenKeepalive(): void {
    if (!this.isConnected() || this.ws?.ownsPing) {return;}
    const now = Date.now();
    if (now - this.lastPingSendTime >= this.PING_INTERVAL) {
      this.lastPingSendTime = now;
      this.send({ type: 'ping', timestamp: now });
    }
  }

  /** Silence + lane-dead measurement. Worker transports stamp liveness
   *  at the receive edge - a main-loop stall delays DRAIN, not arrival,
   *  and must not read as socket silence.
   *
   *  Zombie-seat death: inbound reduced to a trickle of inputSync - the
   *  server's starvation signal, not proof of life. A seat that only
   *  ever sees inputSync is blind (no ticks, events, or keepalives) and
   *  its shotFired intents died too - yet it kept the plain-silence
   *  watchdog quiet. lastLiveRxAt excludes inputSync precisely so this
   *  symptom trips instead of masking the dead lane.
   *  Two cases: (a) lastLiveRxAt > 0 but stale > JSON_STALL_MS (lane
   *  went dark after initially working), (b) lastLiveRxAt === 0 but
   *  ticks are flowing (JSON lane never opened after join - the
   *  reconnect/reseat edge). Both force a clean full reconnect. */
  private laneStall(): { laneDead: boolean; liveSilent: number; silent: number; lastRx: number } {
    const lastRx = Math.max(this.lastRxAt, this.ws?.probe?.lastRxAt ?? 0);
    const now = Date.now();
    const silent = now - lastRx;
    const liveSilent = this.wireIn.lastLiveRxAt > 0 ? now - this.wireIn.lastLiveRxAt : 0;
    const ticksFlowing = (now - lastRx) < NetworkManager.STALL_MS;
    const laneNeverOpened = this.wireIn.lastLiveRxAt === 0 && ticksFlowing && this.connectedAtMs > 0 && (now - this.connectedAtMs) > NetworkManager.JSON_STALL_MS;
    return { laneDead: liveSilent > NetworkManager.JSON_STALL_MS || laneNeverOpened, liveSilent, silent, lastRx };
  }

  /** Healthy session proved itself past the warmup - decay the tier's
   *  bench streak once per connect so a later spurious flap doesn't
   *  inherit punishment for sessions that were fine. */
  private noteHealthyTier(): void {
    const t = this.ws?.tier;
    if (!this.tierRewarded && (t === 'wt' || t === 'rtc') && this.msSinceConnect() > 30_000) {
      this.tierRewarded = true;
      rewardTier(t);
    }
  }

  /** Stall escalation: warn with the right symptom, bench a dead wt/rtc
   *  lane (a zombie WT session never fires onDisconnect, so the tier
   *  flap breaker can't see it), count JSON-lane reconnects toward a
   *  full reload, then rebuild the transport through connect() -
   *  TieredTransport is one-shot after disconnect() (closed flag). */
  private escalateLane(stall: { laneDead: boolean; liveSilent: number; silent: number; lastRx: number }): void {
    logger.warn(stall.laneDead
      ? `inbound lane dead ${Math.round(stall.liveSilent)}ms - only inputSync trickles, reprobing`
      : `no server traffic in ${Math.round(stall.silent)}ms - socket silent, reprobing`, { tier: this.ws?.tier });
    if (stall.laneDead) {
      if (this.ws?.tier === 'wt' || this.ws?.tier === 'rtc') {benchTier(this.ws.tier);}
      this.jsonLaneReconnects += 1;
      if (this.jsonLaneReconnects >= 3) {
        logger.error('JSON lane still dark after 3 reconnects - forcing full reload');
        window.location.reload();
        return;
      }
    }
    const url = this.lastUrl!;
    this.ws?.disconnect();
    this.ws = null;
    this.connected = false;
    this.connect(url, this.lastFactory, this.lastResolveUrl).catch((): void => { /* probe errors are already logged */ });
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

  /** Sends that never left the pipe - connected() false or the inner
   *  lane dropped the frame. Sampled warn keeps Alt+Q honest about
   *  "I shot but nothing happened" windows (RTC flap, probe racing). */
  private sendDrops = 0;

  /** Commands worth surviving a dead lane - time-critical claims (shots,
   *  hits, inputMove) are dropped as before; replaying a 30s-old hit is a
   *  stale-claim bug, not a recovery. Bounded like Colyseus
   *  maxEnqueuedMessages so a dead lane can't queue forever. */
  private static readonly QUEUEABLE = new Set([
    // respawn/throwFlag/switchRoom are deliberately NOT here - a queued
    // suicide or room-hop firing seconds later on the next connect is
    // worse than losing the intent.
    'chat', 'deploy', 'classUpdate', 'perkUpdate', 'resync', 'snapshotRequest',
  ]);
  private pendingCmds: ClientMessage[] = [];
  private static readonly MAX_PENDING_CMDS = 16;

  /** The join handshake payload - everything but 'transport', which the
   *  tier stamps at pending-flush once the probe picks a lane. */
  private joinMsg(): ClientMessage {
    return {
      type: 'join',
      playerId: this.localPlayerId,
      name: settings.get('fps-name').trim() || undefined,
      token: this.sessionToken ?? undefined,
      // Offset cursor - a reclaim carries the last reliable ev we
      // saw so the server replays only the missed frames.
      resumeSeq: this.sessionToken ? this.wireIn.evWatermark : undefined,
      // We own a session veil - hold the body off-spawn until the
      // veil-drop sends 'ready' (or the 8s force timer).
      spawnHold: true,
      room: urlParams.room ?? undefined,
      // Creation hints: explicit ?mode wins, then the persisted
      // join-spec - NOT fps-mode, which is the solo tab's pick
      // and mustn't leak into room mints (lobby ANY bug).
      mode: urlParams.get('mode') ?? readJoinSpec().mode,
      map: urlParams.map ?? readJoinSpec().map,
      bots: urlParams.bots ?? readJoinSpec().bots,
      unlisted: urlParams.unlisted || undefined,
      noCreatures: urlParams.noCreatures || undefined,
      noBalls: urlParams.noBalls || undefined,
      instagib: urlParams.instagib || readJoinSpec().instagib || undefined,
      gungame: urlParams.gungame || readJoinSpec().gungame || undefined,
      igun: urlParams.igun || readJoinSpec().igun || undefined,
      // Instagib defaults ride the server's seat() when the joiner never
      // persisted a skill/perk pick - settings.get can't tell unset from
      // default ('dash'/'jumpstart' always answer truthy), so has() is
      // the explicit-pick test. An explicit fps-skill/fps-perk still wins.
      perk: urlParams.instagib || readJoinSpec().instagib ? (settings.has('fps-perk') ? this.joinPerk?.() : undefined) : this.joinPerk?.(),
      armorClass: this.joinClass?.(),
      skill: urlParams.instagib || readJoinSpec().instagib ? (settings.has('fps-skill') ? this.joinSkill?.() : undefined) : this.joinSkill?.(),
    };
  }

  /** Outbound JSON event - typed against the shared protocol union. */
  private send(msg: ClientMessage): void {
    if (!this.ws?.connected()) {
      if (this.onlineExpected && NetworkManager.QUEUEABLE.has(msg.type)) {
        this.pendingCmds.push(msg);
        if (this.pendingCmds.length > NetworkManager.MAX_PENDING_CMDS) {this.pendingCmds.shift();}
        return;
      }
      this.noteDrop(msg.type);
      return;
    }
    if (NetworkManager.FAST_LANE.has(msg.type)) {this.sendFast(msg); return;}
    // Symmetric send-side check: the server checkIntent-warns a drifted
    // intent AFTER it crossed the wire - running the same check here
    // catches the omit at the call site instead.
    checkIntent(msg.type, msg as unknown as Record<string, unknown>);
    const s = JSON.stringify(msg);
    this.txBytes += s.length;
    recWireOut(msg.type);
    if (this.ws.send(s) === false) {this.noteDrop(msg.type);}
  }

  /** wireIn hook: a tickSeq gap on the datagram lane - ask the server for
   *  a full-record window instead of waiting out the ~750ms staggered
   *  full cadence. Throttled: a torn link nacks every frame otherwise. */
  private lastNackAt = 0;
  public onTickGap(skipped: number): void {
    const now = Date.now();
    this.telemetry.onSeqGap(now, skipped);
    if (now - this.lastNackAt < 250) {return;}
    this.lastNackAt = now;
    this.send({ type: 'tickNack' });
  }

  /** wireIn hook: a counted-miss seq arrived late - cancel the loss. */
  public onSeqReorder(count: number): void {
    this.telemetry.onSeqReorder(Date.now(), count);
  }

  private noteDrop(type: string): void {
    // Contract scream: a transport that flips connected()→false without
    // first firing onDisconnect leaves the tier manager blind (the WT
    // 64KB-carry bug). If we still believe we're online while the lane
    // reports dead, the transport violated the contract - say so loudly.
    if (this.connected && this.ws && !this.ws.connected()) {
      logger.error(`lane went dead with NO disconnect event - transport contract violation`, { tier: this.ws.tier });
      this.connected = false; // let the HUD stall-watchdog see the drop
    }
this.sendDrops += 1;
    // Offline solo has no lane by design — jetpack/pos sends drop on the
    // floor legitimately, so only warn when a lane was ever believed live.
    if (this.connected && (this.sendDrops === 1 || (this.sendDrops & 31) === 0)) {
      logger.warn(`send dropped x${this.sendDrops} - no live lane`, { lastType: type });
    }
  }

  /** inputMove goes binary on the same lane as position reports - the
   *  edge journal lands ~50ms fresher than the JSON stream (edge timing
   *  is replay fidelity for the server shadow). */
  private sendInputMsg(m: ClientMessage): void {
    if (m.type === 'inputMove' && m.input) {
      this.sendBinary(encodeInputMove(m.seq ?? 0, m.input, m.prev, m.ageMs ?? 0));
      return;
    }
    this.send(m);
  }

  /** Claim/intent types that gain real latency by riding the binary
   *  lane (stream-2/datagram on WT) instead of the JSON stream - the
   *  position lane's transit, ~50ms earlier arrival. They stay inside
   *  the same ordered lane as each other, so intra-lane order is
   *  preserved; control/chat/room-hops keep the JSON stream. */
  private static readonly FAST_LANE = new Set([
    'shotFired', 'aoeShot', 'projectileDestroy', 'deploy', 'skillUse',
    'repair', 'creatureHit', 'crawlerHit', 'environmentDamage', 'heal',
    'throwFlag', 'jump', 'jetpack', 'teleport', 'skillFire',
  ]);

  /** A claim that wants the fast lane: JSON-over-binary on the same
   *  lane as position reports - the WIRE_JSON frame decodes into the
   *  ordinary text path server-side. */
  private sendFast(msg: ClientMessage): void {
    if (!this.ws?.connected()) { this.noteDrop(msg.type); return; }
    checkIntent(msg.type, msg as unknown as Record<string, unknown>);
    // Native binary claims skip the JSON text entirely - bounded-read
    // decoders server-side double as validation, so this lane lands in
    // the same trusted dispatch as position frames.
    if (msg.type === 'shotFired') {
      this.txBytes += 45;
      recWireOut('bin:16');
      // Field ABSENCE is semantic (a bare intent's missing dir must not
      // spawn) - pass through untouched, flags carry presence.
      this.sendBinary(encodeShot({ weaponType: msg.weaponType ?? 0, pos: msg.pos, dir: msg.dir, shotId: msg.shotId, fireAt: msg.fireAt }));
      return;
    }
    if (msg.type === 'jump' || msg.type === 'jetpack') {
      this.txBytes += 14;
      recWireOut(msg.type === 'jump' ? 'bin:14' : 'bin:15');
      this.sendBinary(encodePosClaim(msg.type === 'jump' ? WIRE_JUMP : WIRE_JETPACK, msg.position));
      return;
    }
    const s = JSON.stringify(msg);
    this.txBytes += s.length + 2;
    recWireOut(`j:${msg.type}`);
    this.sendBinary(encodeWireJson(s));
  }

  /** Outbound binary frame - pre-encoded by shared/wire.ts. On RTC this
   *  rides the 'game' lane (unordered, maxRetransmits:2): bounded retries
   *  cover jitter without head-of-line stalling the association - the
   *  reliable lane's retransmit queue was the recurring 4-5s silence.
   *  A rare real loss just widens the judge's time-gap tolerance; stale
   *  frames self-reject by seq, so disorder is free. WS/WT unchanged. */
  private sendBinary(data: Uint8Array): void {
    // Native-shell UDP lane: volatile frames ride the loopback shim →
    // raw datagrams. WIRE_JSON is reliable traffic in binary clothing -
    // the server drops it on the datagram lane, so it must stay on ws.
    if (data[1] !== WIRE_JSON && this.udpLane.send(data)) {
      this.txBytes += data.length;
      recWireOut(`bin:${data[0] ?? -1}`);
      return;
    }
    if (!this.ws?.connected()) { this.noteDrop('bin'); return; }
    this.txBytes += data.length;
    recWireOut(`bin:${data[0] ?? -1}`);
    this.ws.send(data);
  }

  /** Byte counters → smoothed B/s pair, read by the backquote perf HUD.
   *  tx is exact (we build the buffers); rx counts binary exactly and
   *  approximates JSON events by re-stringify - they're sparse, so the
   *  cost is nothing and the number is close enough for a debug readout. */
  private txBytes = 0;
  private rxBytes = 0;
  private bwT = 0;
  private bwLastTx = 0;
  private bwLastRx = 0;
  private bwUp = 0;
  private bwDown = 0;
  private ledger = new ClaimLedger();
  /** Native-shell volatile lane - adopted when gameState carries udp. */
  private readonly udpLane = new UdpLane();
  private inputs = new InputStream();

  bandwidth(): { up: number; down: number } {
    const now = performance.now();
    this.sweepLedgers(now);
    if (this.bwT === 0) {
      // First read ever. The per-frame poll lives in the perf HUD's counts
      // callback, which early-returns while that panel is hidden - so the
      // Alt+Q dump is usually the first caller and was showing 0.0/0.0 on
      // a live link. Report the session average instead.
      this.bwT = now;
      this.bwLastTx = this.txBytes;
      this.bwLastRx = this.rxBytes;
      const dt0 = Math.max(0.5, (Date.now() - (this.connectedAtMs || Date.now())) / 1000);
      return { up: this.txBytes / dt0, down: this.rxBytes / dt0 };
    }
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

  /** Expire stale claim/damage-echo ledger entries. The HUD's bandwidth
   *  call used to be the only driver - hidden HUD meant no sweeps, so
   *  "unconfirmed" desync telemetry was inert in normal play. sendPosition
   *  now drives it at ~1Hz instead. */
  private lastLedgerSweep = 0;
  private sweepLedgers(now: number): void {
    // Resend rides send() so FAST_LANE kinds re-take the datagram lane;
    // the verbatim claimSeq makes the server's verdict replay the retry.
    this.ledger.sweep(now, { pingMs: this.telemetry.ping, tier: this.ws?.tier,
      resend: (m): void => { if (this.isConnected()) { this.send(m as ClientMessage); } } });
    sweepDamageEchoes(now, Math.min(Math.max(0, this.msSinceLiveRx() - 100), 2000));
    // shotFired carries no claimSeq - its dedupe is shotId - so the claim
    // ledger can't resend it. A datagram-dropped fire intent leaves the
    // predicted shell unborn (parity 'srvAt:none') with only reconnect
    // replay to recover it; one in-session resend past ~2×RTT closes that
    // hole. Server seenShots makes the retry free when the original landed.
    if (this.isConnected()) {
      const resendMs = Math.min(Math.max((this.telemetry.ping || 60) * 2, 150), 450);
      for (const e of this.claimIntents) {
        if (e.resent || now - e.t < resendMs || now - e.t >= NetworkManager.FIRE_REPLAY_MS) {continue;}
        if ((e.msg as { shotId?: string }).shotId === undefined) {continue;}
        e.resent = true;
        this.intentResends += 1;
        this.send(e.msg);
      }
    }
  }

  /** Probe counter - soaks count in-session fire-intent resends (distinct
   *  from intentReplays, which only fires on reclaim). */
  intentResends = 0;

  /** Ring of recent health-affecting events - read by the desync dump so a
   *  hash mismatch says WHICH event diverged, not just that one did. */
  recentEvents(): readonly { type: string; t: number; detail: string }[] {
    return this.wireIn.recentEvents();
  }

  // ---- WireIn host surface - the whole back-channel the dispatcher
  // needs (roster store, ledgers/journal, telemetry, session state).

  /** Any inbound frame proves liveness + feeds the byte counter. */
  noteRx(bytes: number): void {
    this.lastRxAt = Date.now();
    this.rxBytes += bytes;
  }

  /** Tick-arrival cadence - host loopback delivers ticks in per-frame
   *  bursts, which would read as fake packet loss in the gap tracker. */
  tickArrived(): void {
    if (this.ws?.tier !== 'host') {this.telemetry.onTickArrival(Date.now());}
  }

  pongReceived(timestamp: number): void {
    this.telemetry.onPong(timestamp, Date.now());
  }

  /** Server-clock offset estimate - the 'ping' probe's timestamp is the
   *  server's wall clock, so stamp + rtt/2 approximates server-now.
   *  fireAt claims ride on this: the server measures (arrival − fireAt)
   *  as the claim's true uplink transit instead of an EMA guess. */
  private clockOffset = 0;
  private clockSynced = false;

  /** Server-side RTT probe - echo verbatim; the timestamp is the
   *  server's clock, not ours. */
  pingReceived(timestamp: number): void {
    this.send({ type: 'pong', timestamp });
    const sample = timestamp + this.telemetry.ping / 2 - Date.now();
    // Big jumps re-seat outright (clock step / reconnect); small ones
    // EMA so jitter doesn't wander the offset around.
    if (!this.clockSynced || Math.abs(sample - this.clockOffset) > 200) {
      this.clockOffset = sample;
      this.clockSynced = true;
    } else {
      this.clockOffset += (sample - this.clockOffset) * 0.2;
    }
  }

  /** Estimated server wall-clock right now - undefined until the first
   *  probe lands (claims simply omit fireAt before that). */
  serverNowMs(): number | undefined {
    return this.clockSynced ? Date.now() + this.clockOffset : undefined;
  }

  resendInputs(lastSeq: number): void {
    this.inputs.resend(lastSeq, (m): void => this.sendInputMsg(m), this.isConnected());
  }

  ackInputs(inputAck: number): void {
    this.inputs.inputsAfter(inputAck);
  }

  ackPositionSeq(_seq: number): void {
    // No-op: position history was dead bookkeeping (see note at field
    // site). Kept as the wire seam - wireIn calls it on every ack frame.
  }

  confirmClaimHit(targetId: string, shotId?: string): void {
    this.ledger.confirmHit(targetId, shotId);
    confirmDamageEcho(targetId, shotId);
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

  /** Re-seat after an AFK demotion: the server stripped our player on
   *  the 90s claims sweep and answered resync with the bare spectator
   *  gameState — the same join handshake re-seats us (sessionToken rides
   *  the reclaim path). Called from wireIn when a gameState that should
   *  carry localPlayerState doesn't. */
  reseat(): void {
    if (!this.isConnected()) {return;}
    this.send(this.joinMsg());
  }

  /** Server-issued session token - persisted so a reconnect can reclaim
   *  the grace-period seat. */
  acceptSessionToken(token: string): void {
    this.sessionToken = token;
    settings.set('fps-session-token', token);
  }

  rejectSession(reason?: string): void {
    this.resetIdentity(reason);
  }

  /** gameState's authoritative roster - replaces, never merges (v3 ids
   *  and per-room state would alias across a merge). */
  remoteReset(players: GameStatePlayer[] | undefined): void {
    this.players.clear();
    if (players) {for (const p of players) {
      if (p.id === this.localPlayerId) {continue;}
      this.players.set(p.id, p);
    }}
  }

  remoteHas(playerId: string): boolean { return this.players.has(playerId); }
  remoteDelete(playerId: string): void { this.players.delete(playerId); }

  // Upsert a remote player's roster entry, preserving fields the message
  // doesn't carry: merge order is patch → existing → default, so partial
  // updates (hit = health only) never stomp unrelated roster state.
  //
  // Owns CREATE too - call only from membership feeds (tickUpdate, joined,
  // respawn, roster/snapshot heal). One-off edges (hit, kill, teamUpdate)
  // must use patchRemotePlayer: minting on an edge leaves phantom roster
  // entries when the edge outlives its member (§2.165/§2.168).
  upsertRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): void {
    if (!playerId || playerId === this.localPlayerId) {return;}
    const existing = this.players.get(playerId);
    // Mutate in place: a fresh object per player per tick was the
    // biggest steady-state allocation on the 20Hz wire path. Merge
    // order is unchanged - patch → existing → default.
    const next = existing ?? ({ id: playerId } as RemotePlayerState);
    if (!existing) {
      // Vec defaults are shared literals - clone or the first in-place
      // update corrupts every roster entry built after this one.
      next.position = Object.assign({}, ROSTER_DEFAULTS.position!);
      next.rotation = Object.assign({}, ROSTER_DEFAULTS.rotation!);
      next.velocity = Object.assign({}, ROSTER_DEFAULTS.velocity!);
    }
    for (const k of ROSTER_FIELDS) {
      // Vec fields are handled below - storing the patch ref would alias
      // the decode pool (a pooled slot tracks whichever player decoded
      // LAST), so they fill the entry's own sub-objects instead.
      if (k === 'position' || k === 'rotation' || k === 'velocity') {continue;}
      const key = k as keyof RemotePlayerState;
      (next as unknown as Record<string, unknown>)[k] = patch[key] ?? next[key] ?? ROSTER_DEFAULTS[key];
    }
    this.mergeVecPatch(next, patch);
    if (!existing) {this.players.set(playerId, next);}
  }

  // Vec fields merge component-wise — a NaN component from any edge
  // (join/respawn/roster heal) would poison the stored row forever, so
  // the whole vec drops rather than the player.
  private mergeVecPatch(next: RemotePlayerState, patch: Partial<RemotePlayerState>): void {
    if (patch.position && Number.isFinite(patch.position.x + patch.position.y + patch.position.z)) { next.position.x = patch.position.x; next.position.y = patch.position.y; next.position.z = patch.position.z; next.posAt = Date.now(); }
    if (patch.rotation && Number.isFinite(patch.rotation.yaw + patch.rotation.pitch)) { next.rotation.yaw = patch.rotation.yaw; next.rotation.pitch = patch.rotation.pitch; }
    if (patch.velocity && Number.isFinite(patch.velocity.x + patch.velocity.y + patch.velocity.z)) { next.velocity.x = patch.velocity.x; next.velocity.y = patch.velocity.y; next.velocity.z = patch.velocity.z; }
  }

  // Patch-in-place-or-drop for one-off edges - returns false when the
  // roster holds no such member (edge for a departed/never-joined player),
  // so callers can't manufacture phantom entries by accident.
  patchRemotePlayer(playerId: string, patch: Partial<RemotePlayerState>): boolean {
    if (!this.players.has(playerId)) {return false;}
    this.upsertRemotePlayer(playerId, patch);
    return true;
  }

  /** Wire-feed seam for recorded streams (.rec): pushes one message
   *  through the exact live dispatch path - handlers can't tell the
   *  difference between a capture and a socket. Dev replay only. */
  replayWireMessage(data: ServerMessage | Uint8Array): void {
    this.wireIn.dispatch(data);
  }


  /**
   * Send player position to server with rate limiting (20Hz binary frame)
   */
  /**
   * Declared discontinuity - the position jump (warp, respawn) is
   * intentional. Server reseats its plausibility anchor instead of
   * rejecting the move and rubber-banding us.
   */
  sendTeleport(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) {return;}
    this.send({ type: 'teleport', position, rotation, velocity });
  }

  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) {return;}

    const now = Date.now();

    // Still-throttle: a truly parked player (no pos/vel/aim change) earns
    // a 4Hz heartbeat instead of 20Hz - identical truth, ~5x less server
    // reconcile/rewind work per idle player. Any wiggle (incl. aim -
    // standing snipers still aim) returns to full rate instantly.
    if (now - this.lastPositionSendTime < (this.isStill(position, rotation, velocity) ? this.STILL_SEND_INTERVAL : this.POSITION_SEND_INTERVAL)) {
      return;
    }

    this.lastPositionSendTime = now;
    this.lastSentState ??= { px: 0, py: 0, pz: 0, yaw: 0, pitch: 0 };
    this.lastSentState.px = position.x; this.lastSentState.py = position.y; this.lastSentState.pz = position.z;
    this.lastSentState.yaw = rotation.yaw; this.lastSentState.pitch = rotation.pitch;

    const nowMs = performance.now();
    if (nowMs - this.lastLedgerSweep >= 1000) {
      this.lastLedgerSweep = nowMs;
      this.sweepLedgers(nowMs);
    }

    // Sequence number rides the wire so the server can order reports
    // (and echoes it back in corrections).
    this.sequenceCounter += 1;
    const seq = this.sequenceCounter;

    // Binary frame: 30B instead of ~140B JSON. Server decodes on the wire
    // hot path; the message still passes through the same validation.
    const held = this.inputs.held();
    this.sendBinary(encodePosition(position, rotation, velocity, seq, this.telemetry.ping, this.inputs.seq,
      held ? { forward: held.forward, right: held.right, jump: held.jump, ski: held.ski, jet: held.jet ?? 0 } : undefined));

    this.sendSideChannels(now);
  }

  /** Parked-player test for the still-throttle: pos drift <5cm, speed
   *  <0.5, aim drift <0.01 rad on both axes vs the last SENT state. */
  private isStill(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): boolean {
    const s = this.lastSentState;
    return s !== undefined
      && Math.hypot(position.x - s.px, position.y - s.py, position.z - s.pz) < 0.05
      && Math.hypot(velocity.x, velocity.y, velocity.z) < 0.5
      && Math.abs(rotation.yaw - s.yaw) < 0.01
      && Math.abs(rotation.pitch - s.pitch) < 0.01;
  }

  /** Interval side-channels that ride the position cadence: ping probe
   *  (worker transports own their own) and the ~0.1Hz client ops uplink. */
  private sendSideChannels(now: number): void {
    if (!this.ws?.ownsPing && now - this.lastPingSendTime >= this.PING_INTERVAL) {
      this.lastPingSendTime = now;
      this.send({ type: 'ping', timestamp: now });
    }

    // Client ops uplink ~0.1Hz - rides the position cadence so it only
    // ever fires while a game is actually streaming (no lobby noise).
    if (now - this.lastStatsSendTime >= NetworkManager.STATS_INTERVAL) {
      this.lastStatsSendTime = now;
      const s = this.statsSource?.() ?? { fps: 0, jsMs: 0 };
      this.send({
        type: 'clientStats',
        fps: s.fps, jsMs: s.jsMs,
        ping: this.telemetry.ping,
        loss: this.telemetry.packetLoss(now),
        gap: this.telemetry.deliveryGap(now),
        jitter: this.telemetry.jitter(),
        renderLagMs: s.renderLagMs,
        renderLag: s.renderLag,
        starve: s.starve,
        starveMs: s.starveMs,
        drainMsMax: this.ws?.probe?.drainMsMax,
      });
    }
  }

  /** GameLoop feeds live perf numbers - the uplink above can't read
   *  the perf HUD itself without an import cycle the other direction. */
  statsSource: (() => { fps: number; jsMs: number; renderLagMs?: number; renderLag?: Record<string, number>; starve?: number; starveMs?: number }) | null = null;
  private lastStatsSendTime = 0;
  private static readonly STATS_INTERVAL = 10_000;

  /**
   * Send input move for client-side prediction.
   * Player calls this every frame - we only transmit on actual input change,
   * rate-limited to the position tick rate. Yaw/pitch already ride in the
   * binary position frame, so the rotation payload only matters when the
   * input bits themselves change.
   */
  sendInputMove(input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }, rotation: { yaw: number; pitch: number }): void {
    // Ungated sends during the connect window counted as drops - the
    // journal keeps the entry regardless, so skipping the fast path
    // loses nothing (inputSync re-requests on the server's word).
    if (!this.isConnected()) {return;}
    this.inputs.sendMove(input, rotation, (m): void => this.sendInputMsg(m));
  }

  /** Journal entries with seq > `after` - what the server hadn't consumed
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
   *  bookkeeping applies as a wire update. Health only - position stays
   *  correction-owned, isDead stays event-owned. */
  healRemoteHealth(playerId: string, health: number): void {
    // upsert would CREATE a stub for an unknown id - a heal must never
    // materialize a phantom roster row.
    if (!this.players.has(playerId)) {return;}
    this.upsertRemotePlayer(playerId, { health });
  }

  /** Desync-checker heal for LIVENESS: a killed/respawned event lost on
   *  the wire leaves the remote's isDead permanently wrong (roster health
   *  heals but the corpse flag is event-owned). The snapshot diff is the
   *  safety net - server isDead wins outright; the caller mirrors it into
   *  the RemotePlayer entity (respawn/playDeath visuals). Returns the
   *  flip direction so the caller knows which visual to run. */
  healRemoteLife(playerId: string, isDead: boolean, health: number, position?: { x: number; y: number; z: number }): 'revived' | 'killed' | null {
    const cur = this.players.get(playerId);
    if (!cur || cur.isDead === isDead) {return null;}
    // Server position is truth either way: a revive anchors at the
    // respawn point, a kill pins the corpse where the server saw it die.
    this.upsertRemotePlayer(playerId, Object.assign({}, {isDead,health}, (position ? { position } : {})));
    return isDead ? 'killed' : 'revived';
  }

  /** Single AOE message - weaponType resolves server-side via the shared
   *  weapon table (WEAPONS in shared/weapons.ts). projectileId/airtime bind
   *  the blast to a tracked projectile so the server can validate the
   *  trajectory - skill AOEs (slam) send neither and are position-checked
   *  against the player instead. */
  sendAOEShot(a: {
    position: { x: number; y: number; z: number }; weaponType: number;
    excludeTargetId?: string | null; projectileId?: string | null;
    airtime?: number; power?: number; directHit?: boolean; shotId?: string;
  }): void {
    if (this.authoritySims()) { return; } // dedicated sims outcomes - the claim would only earn a refused ack
    if (performance.now() < this.resyncQuietUntil) { noteMutedClaim(); return; } // same resync-gap mute as sendShot
    if (!this.isConnected()) {return;} // dead lane - a stamp here mints a phantom ledger entry
    // Victim-named claims (beam tics, direct-hit blasts) ride the same
    // confirm ledger shots use - keyed per victim so a held beam is one
    // slot, not a map entry per tic. Splash claims with no named target
    // can't confirm by target and stay unledgered by design.
    if (a.excludeTargetId && a.excludeTargetId !== 'local') {
      this.ledger.noteShot(`aoe:${a.excludeTargetId}`, a.excludeTargetId, a.weaponType);
    }
    this.send(Object.assign({}, a, {excludeTargetId: a.excludeTargetId ?? null,projectileId: a.projectileId ?? undefined,fireAt: this.serverNowMs(),type: 'aoeShot' as const}));
  }

  /** Slam landing intent - the server derives blast power from its own
   *  velocity shadow; only the landing spot crosses the wire. */
  sendSlam(position: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) {return;}
    const msg = Object.assign({}, { type: 'slam' as const, position }) as ClientMessage & { claimSeq?: number };
    msg.claimSeq = this.ledger.stamp('slam', false, msg);
    this.send(msg);
    this.claimIntents.push({ msg, t: performance.now(), room: this.netRoom });
    if (this.claimIntents.length > 16) {this.claimIntents.shift();}
  }

  sendJump(position: { x: number; y: number; z: number }): void {
    this.send({ type: 'jump', position });
  }

  sendJetpack(position: { x: number; y: number; z: number }): void {
    this.send({ type: 'jetpack', position });
  }

  /** Cosmetic fire relay - hitscan kinds (fan/beam) leave no projectile,
   *  so this tells the server to paint muzzle audio/visual on observers.
   *  For SERVER_SIMMED_WEAPONS it's the fire intent - pos/shotId help the
   *  spawn hint + echo binding; the server derives truth itself. */
  sendShotFired(a: { weaponType?: number; dir?: { x: number; y: number; z: number }; pos?: { x: number; y: number; z: number }; vel?: { x: number; y: number; z: number }; shotId?: string }): void {
    if (!this.connected) {return;}
    const msg = Object.assign({}, {type: 'shotFired' as const}, a, {fireAt: this.serverNowMs()});
    this.send(msg);
    // Journal for the post-reclaim replay: a socket that dies while the
    // intent is in flight leaves a predicted shell the server never
    // spawned - local hit prediction with no adjudication. ~3s window,
    // server dedupes by shotId, room-scoped so a hop can't replay a
    // stale shell into the wrong room.
    this.claimIntents.push({ msg, t: performance.now(), room: this.netRoom });
    if (this.claimIntents.length > 16) {this.claimIntents.shift();}
  }

  /** Recent predicted intents eligible for post-reclaim replay
   *  (shotFired/deploy/slam - the claims the client already acted on
   *  locally). Bounded - a dead lane never earns an unbounded intent
   *  backlog either. Replays are safe because the server dedupes by
   *  shotId (shots) or (type,claimSeq) (stamped claims). */
  private claimIntents: { msg: ClientMessage; t: number; room?: string; resent?: boolean }[] = [];
  /** Room the last gameState seated us in - journal entries fire under it. */
  private netRoom: string | undefined;
  /** Replay window must cover the real reclaim path: socket-death
   *  detection + grace + rejoin roundtrip routinely runs past 3s -
   *  a window shorter than the reclaim never actually replays. */
  private static readonly FIRE_REPLAY_MS = 10_000;

  /** Called by wireIn's gameState handler - the seat is (re)established.
   *  Resends fire intents the dead lane may have lost; entries from a
   *  different room (a hop) or older than the window are dropped. */
  replayFireIntents(room?: string, udp?: { token: string; port: number }): void {
    this.netRoom = room;
    // A native-shell server offered the volatile lane - adopt it. ws
    // stays the control lane; only volatile binary reroutes.
    if (udp) {this.udpLane.adopt(udp, (b): void => this.wireIn.binary(b));}
    const entries = this.claimIntents;
    this.claimIntents = [];
    const now = performance.now();
    for (const e of entries) {
      if (e.room !== room || now - e.t >= NetworkManager.FIRE_REPLAY_MS) {continue;}
      this.intentReplays += 1;
      this.send(e.msg);
    }
  }

  /** Probe counter - soaks assert the reclaim replay actually fired
   *  (a pass reading only shell fates can't tell replay from luck). */
  intentReplays = 0;

  sendProjectileDestroy(projectileId: string, shotId?: string): void {
    if (this.authoritySims()) { return; }
    this.send({ type: 'projectileDestroy', projectileId, shotId });
  }

  /** Deployable plant claim - sent when the pod lands and seats, so the
   *  position is the settled one the server will enforce caps/TTL on. */
  sendDeploy(kind: DeployKind, position: { x: number; y: number; z: number }, vel?: { x: number; y: number; z: number }): void {
    if (!this.isConnected()) {return;}
    const msg = Object.assign({}, { type: 'deploy' as const, kind, position }, vel ? { vel } : {}) as ClientMessage & { claimSeq?: number };
    msg.claimSeq = this.ledger.stamp('deploy', false, msg);
    this.send(msg);
    this.claimIntents.push({ msg, t: performance.now(), room: this.netRoom });
    if (this.claimIntents.length > 16) {this.claimIntents.shift();}
  }

  /** Repair claim - only the target id crosses the wire; the server
   *  re-derives range, LOS, team, heal amount, and pacing itself. */
  sendRepair(targetId: number): void {
    if (!this.isConnected() || this.authoritySims()) { return; }
    const msg = { type: 'repair' as const, targetId, claimSeq: undefined as number | undefined };
    msg.claimSeq = this.ledger.stamp('repair', false, msg);
    this.send(msg);
  }

  /** Instant-skill ante mirror - skills.ts already spent the energy
   *  locally; the server applies the same drain to its shadow tank. */
  sendSkillUse(skill: string): void {
    if (!this.isConnected()) {return;}
    const msg = { type: 'skillUse' as const, claimSeq: undefined as number | undefined, skill };
    msg.claimSeq = this.ledger.stamp('skillUse', false, msg);
    this.send(msg);
  }

  /** Loadout class pick mid-match - the server banks it for the next
   *  respawn (same rule the client applies locally). */
  sendClassUpdate(armorClass: string): void {
    if (!this.connected) {return;}
    this.send({ type: 'classUpdate', armorClass });
  }

  /** Perk pick mid-match - same respawn-bank rule as the class pick. */
  sendPerkUpdate(perk: string): void {
    if (!this.connected) {return;}
    this.send({ type: 'perkUpdate', perk });
  }

  /** Post-resync claim mute - see sendResync. */
  private resyncQuietUntil = 0;

  /** Offline authority - when there's no server, damage/heal claims apply
   *  locally through this hook instead of being dropped on the floor. */
  localAuthority: { envDamage(amount: number): void; heal(amount: number): void; respawn?(): void } | null = null;

  /** Deliberate respawn (K) - the server owns the kill; offline falls
   *  back to the local death path. `hold` (the L bind) parks the corpse:
   *  no auto-respawn until a plain dead-state press releases it. */
  sendRespawn(hold = false): void {
    if (!this.connected) { this.localAuthority?.respawn?.(); return; }
    this.send({ type: 'respawn', hold: hold || undefined });
  }

  /** Flag toss claim (G) - server resolves the arc. Offline the caller
   *  routes to the local flag sims (FlagRunBridge/CtfFlags) instead. */
  sendThrowFlag(): void {
    if (!this.connected) {return;}
    this.send({ type: 'throwFlag' });
  }

  /** Self-inflicted environment damage (crawler pounce, etc.) - the server
   *  clamps and applies it, then broadcasts the authoritative health. */
  sendEnvironmentDamage(amount: number, attacker?: string): void {
    if (!this.connected) { this.localAuthority?.envDamage(amount); return; }
    // Every self-reported damage claim logs - this channel carries blast
    // self-splash, creature bites, and bot melee, so the buffer answers
    // "did the client even claim it?" before any server-side question.
    if (!this.isConnected()) {return;} // lane dead - don't mint a phantom stamp
    logger.info(`envDamage claim: ${Math.round(amount * 10) / 10}`, { attacker });
    const msg = { type: 'environmentDamage' as const, amount, attacker, claimSeq: undefined as number | undefined };
    msg.claimSeq = this.ledger.stamp('environmentDamage', false, msg);
    this.send(msg);
  }

  /** Client-claimed heal (nugget pickup) - keeps server health the truth. */
  sendHeal(amount: number): void {
    if (!this.connected) { this.localAuthority?.heal(amount); return; }
    if (!this.isConnected()) {return;}
    const msg = { type: 'heal' as const, amount, claimSeq: undefined as number | undefined };
    msg.claimSeq = this.ledger.stamp('heal', false, msg);
    this.send(msg);
  }

  /** Hit claim on a server-owned creature (netDriven ball). kx/ky/kz is the
   *  impulse the shot imparted - server clamps magnitude and rebroadcasts
   *  the new segment so every client sees the same shove. */
  sendCrawlerHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    if (this.authoritySims() || !this.isConnected()) { return; }
    const msg = { type: 'crawlerHit' as const, id, damage, kx, ky, kz, claimSeq: undefined as number | undefined };
    msg.claimSeq = this.ledger.stamp('crawlerHit', true, msg);
    this.send(msg);
  }

  private creatureHitLogN = 0;
  sendCreatureHit(id: number, damage: number, kx?: number, ky?: number, kz?: number): void {
    if (this.authoritySims() || !this.isConnected()) { return; }
    // Sampled claim log (1-in-16): chaingun-rate creature fire would flood
    // the buffer; a periodic line still proves claims are flowing and
    // carries the damage values being asserted.
    if ((((this.creatureHitLogN += 1) - 1) & 15) === 0) {
      logger.info(`creatureHit claim x${this.creatureHitLogN}`, { id, damage });
    }
    const msg = { type: 'creatureHit' as const, id, damage, kx, ky, kz, claimSeq: undefined as number | undefined };
    msg.claimSeq = this.ledger.stamp('creatureHit', true, msg);
    this.send(msg);
  }

  sendSnapshotRequest(): void {
    this.send({ type: 'snapshotRequest' });
  }

  /** Spawn gate: the server holds the body off-world until this lands -
   *  fires at session-veil drop (stable frames or the 8s force timer). */
  sendReady(): void {
    this.send({ type: 'ready' });
  }

  /** Alt-tab catch-up: ask the server to replay the full world state
   *  (gameState + rosters) so the tab can snap to truth instead of
   *  rewinding the backgrounded interval. */
  sendResync(): void {
    // Position-dependent claims (shot/aoeShot) are muted until the
    // reply snaps us onto server truth - the cap is a fallback if the
    // replay never arrives.
    this.resyncQuietUntil = performance.now() + 5000;
    this.send({ type: 'resync' });
  }

  /** Discard the prediction journal - a correction arriving after this
   *  hard-snaps to the echoed state instead of replaying seconds of
   *  queued inputs at once (the "rewinding" storm after alt-tab). */
  dropInputJournal(): void {
    this.inputs.dropJournal();
  }

  sendChat(text: string, team = false, vgs?: string): void {
    this.send({ type: 'chat', text, team: team || undefined, vgs });
  }

  /** Mid-match room hop - the server re-seats this session and answers
   *  with a fresh gameState, which the normal (re)connect path rebuilds
   *  from. Returns false when there's no live socket (caller falls back
   *  to a reload join). */
  switchRoom(room: string, map?: string, bots?: number, mode?: string, unlisted?: boolean, noCreatures?: boolean, noBalls?: boolean, instagib?: boolean, gungame?: boolean, igun?: boolean): boolean {
    if (!this.isConnected()) {return false;}
    this.send({ type: 'switchRoom', room, map, bots, mode, unlisted: unlisted || undefined, noCreatures: noCreatures || undefined, noBalls: noBalls || undefined, instagib: instagib || undefined, gungame: gungame || undefined, igun: igun || undefined });
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

  /**
   * The authority runs the shared sims (RoomProjectiles/creature sims) -
   * claims/intents only make sense against it. A P2P host embeds the
   * same server modules but deliberately carries no roster sims, so
   * peers fall back to the claim lanes the host can still adjudicate
   * (blasts via aoeShot, melee via the swing intent) instead of
   * suppressing them.
   */
  authoritySims(): boolean {
    return this.isConnected() && this.ws?.tier !== 'p2p' && this.ws?.tier !== 'host';
  }

  /**
   * Narrower than authoritySims: the authority runs the WEAPON sims
   * (RoomProjectiles + beamSweep). P2P hosts qualify - a guest's simmed
   * shot/beam sends intents only and receives projectileCreated echoes,
   * while creature/deploy/repair claims keep running the claim lanes.
   */
  authorityShells(): boolean {
    return this.isConnected();
  }

  getPing(): number {
    // Worker transports measure rtt off-main (probe.rttMs) and consume
    // their own pongs - telemetry.ping can read 0 while a session is
    // otherwise fine; prefer the populated probe over a zero.
    const probe = this.ws?.probe?.rttMs;
    return this.telemetry.ping > 0 ? this.telemetry.ping : (probe ?? this.telemetry.ping);
  }

  /** Server-measured RTT echoed back on each pong - the same wire the
   *  client ping rides, minus our own event-loop stall. null until the
   *  first echo lands (or on transports without the probe). */
  serverPingMs: number | null = null;

  /** Transit-symmetry probe (netcode-gap item): srvPing measures the
   *  reliable-lane RTT while `ping` measures the datagram lane - a
   *  persistent gap is the lane asymmetry, not noise, and it widens the
   *  server's rewind window by that much. EMA + an outlier count land in
   *  the Alt+Q dump so the 7ms/61ms reading answers "is it systematic". */
  srvAsymMs = 0;
  srvAsymN = 0;
  noteSrvPing(rtt: number | null): void {
    this.serverPingMs = rtt;
    if (rtt === null || rtt <= 0 || this.telemetry.ping <= 0) {return;}
    const asym = (rtt - this.telemetry.ping) / 2;
    this.srvAsymMs = this.srvAsymMs === 0 ? asym : this.srvAsymMs * 0.9 + asym * 0.1;
    if (asym > 25) {this.srvAsymN += 1;}
  }

  /** Worker-transport probes (clean wire RTT, postMessage delivery lag,
   *  coalesced tick count) - null on non-worker transports. */
  get netProbe(): { rttMs: number; lagMs: number; coalesced: number; drainMsMax?: number } | null {
    return this.ws?.probe ?? null;
  }

  getPacketLoss(): number {
    return this.telemetry.packetLoss(Date.now());
  }

  getJitter(): number {
    return this.telemetry.jitter();
  }

  /** Netcode-v2 tier our own connection negotiated - self row on the
   *  scoreboard (remotes get theirs from gameState/playerJoined). A live
   *  UDP volatile lane shows as '<tier>+udp' - the composite is the tier. */
  getTransportTier(): TransportKind | 'p2p' | 'host' | string | undefined {
    const t = this.ws?.tier;
    return t !== undefined && this.udpLane.live ? `${t}+udp` : t;
  }

}
