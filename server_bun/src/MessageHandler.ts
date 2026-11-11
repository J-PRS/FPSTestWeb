import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3, PlayerState, ClaimVerdict, GameStatePlayer,HitVerdict } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { RateLimiter } from './RateLimiter.ts';
import { CombatHandler, type CombatDeps, type BeamContact } from './CombatHandler.ts';

import type { KillFeed } from './killFeed.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import type { RoomMods } from '../../shared/protocol.ts';
import { CONFIG } from './config.ts';
import { WIRE } from './wire.ts';
import { encodeWidPos, WIRE_E_JUMP, WIRE_E_JET } from '../../shared/wire.ts';
import { MoveClaims } from './moveClaims.ts';
import type { BallSim } from './BallSim.ts';
import type { CreatureSim } from './CreatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import type { PickupKind } from '../../shared/pickups.ts';

import type { TeamId } from '../../shared/teams.ts';
import type { DeployKind } from '../../shared/deployables.ts';
import type { RoomEventSink } from './roomEvents.ts';
import { WORLD_MODEL, spawnPayload, checkIntent } from '../../shared/worldModel.ts';
import { wallNow, type WallMs } from './wallClock.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { simNow } from './simClock.ts';
import type { AtmosphereSpec, SpawnPoint, StructureSpec, WaterSpec, WeatherSpec } from '../../shared/mapSpec.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

/** What the enclosing Room tells its MessageHandler about the match. */
export interface RoomInfo {
  room: string;
  mode: string;
  /** Whether outcome claims (aoeShot, creatureHit, heal, repair,
   *  projectileDestroy) are adjudicated. A sim-running authority sets
   *  false: clients only ever send intents there, so a claim that still
   *  arrives is forged or stale — reject, don't adjudicate. A P2P host
   *  embeds these modules without sims and leaves it unset (default
   *  true): there the claim IS the authority path. */
  claimsAccepted?: boolean;
  /** Live scoreboard object (mutated by Room.score) — echoed into gameState. */
  scores?: { alpha: number; bravo: number };
  /** Team-mode room → friendly fire is blocked at the damage funnel. */
  teams?: boolean;
  /** Server option (CONFIG.friendlyFire / FPS_FRIENDLY_FIRE): when set,
   *  teammates CAN damage each other — the friendly gate opens. */
  friendlyFire?: boolean;
  winAt?: number;
  /** Objective anchors from the map spec — echoed on gameState so clients
   *  place flags/bases where the map says, not where the URL guessed. */
  bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } };
  /** Effective spawn pools — thunks like mapName: mode modules re-mint
   *  spheres mid-match (conquest node rings), so gameState reads the live
   *  PlayerManager pools, not the spec's authored copy. Debug dressing
   *  only (F1 command-map layer). */
  spawns?: () => SpawnPoint[] | null;
  teamSpawns?: () => { alpha?: SpawnPoint[]; bravo?: SpawnPoint[] } | null;
  /** Static structures from the map spec — echoed on gameState so every
   *  client builds the same base compounds/cover. */
  structures?: StructureSpec[];
  /** Arena dome from the map spec — center {x,z} + radius. */
  arena?: { x: number; z: number; radius: number };
  /** Kill zone height (world Y) — echoed for the client's own prediction. */
  killY?: number;
  /** World-state replay frames the room's registered sims emit —
   *  roster snapshots a joiner/resync replays (Room.sims worldState). */
  simsWorldState?: () => ServerMessage[];
  /** Map display name for the scoreboard chrome — lazy like ffaScores:
   *  the spec source lands after Room's ctor (factory/rotation/reload),
   *  so a frozen string would miss the real name on the first gameState. */
  mapName?: () => string | undefined;
  /** Ambient species population overrides from the map spec. */
  ambient?: Record<string, number>;
  /** Heightfield file (maps/<name>.bin) — echoed on gameState so clients
   *  fetch the identical terrain the server's sims run on. */
  terrain?: string;
  /** Vertical gain on the room's field — clients must scale their copy
   *  identically or prediction diverges. */
  heightScale?: number;
  /** Meters per heightmap wrap — the field sampling span clients must
   *  match (spec.tileSize; absent = engine default). */
  tileSize?: number;
  /** Mission-authored haze — spec.fog, client dressing only. */
  fog?: { color: [number, number, number]; distance?: number; visible?: number; horizon?: [number, number, number] };
  /** Gameplay water — spec.water, echoed for client surface + prediction. */
  water?: WaterSpec;
  /** Baked terrain albedo + skybox dir — client dressing only. */
  terrainPreset?: number;
  terrainTex?: string;
  sky?: string;
  /** Ambient particle weather + procedural-sky tuning — client dressing only. */
  weather?: WeatherSpec;
  atmosphere?: AtmosphereSpec;
  /** Interior placements (T2 .dif→.glb buildings) — client dressing only. */
  interiors?: { file: string; pos: { x: number; y: number; z: number }; rot?: number[]; scale?: { x: number; y: number; z: number } }[];
  /** Domain-event sink — combat/chat notifications (kill, hit, fire,
   *  botSpoke, chat) fan out to the room's subscribers. Commands and
   *  queries stay as direct hooks below; an event never carries a
   *  verdict back. */
  emit?: RoomEventSink;
  /** Seeded room rng — scenario harnesses inject it so claim-path dice
   *  (bomblet scatter) replay identically under a seed. */
  rng?: () => number;
  /** FFA scoreboard supplier for gameState joins — Room.ffaScores. */
  ffaScores?: () => Record<string, number>;
  /** v3 record-id roster snapshot for gameState joins — Room.wireIds as
   *  {wireId: playerId}; deltas only reach sockets already live. */
  wireIds?: () => Record<number, string>;
  /** Flag snapshot supplier for gameState joins — RoomFlags.snapshot. */
  flags?: () => { team: TeamId; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[];
  /** Live pickups for gameState joins — RoomPickups.snapshot. */
  pickups?: () => { id: number; pos: Vec3; kind: PickupKind }[];
  /** Live room-modifier reader - roomFactory can flip the flags on a
   *  reused Room after this snapshot, so combatDeps and the gameState
   *  echo both read through here instead of cached booleans. */
  mods?: () => RoomMods;
  gunRungOf?: (playerId: string) => number;
  gunGameHeld?: (playerId: string, weaponType: number) => void;
  /** Match-clock deadline (epoch ms) for gameState joins — Room.matchEndsAt.
   *  0 means "not armed yet" (no humans have joined). */
  matchEndsAt?: () => number;
  /** tickNack sink — a client that lost a tick burst asks for a
   *  full-record window so its masked-field baselines reseed in ~1s
   *  instead of waiting out the 750ms stagger. Room-cooldowned. */
  nackFulls?: () => void;
  /** Per-recipient nack answer for spectators: returns true when the
   *  id is a spectator (their gap is scoped to their own intro window),
   *  false/absent for players (room-wide nackFulls applies). */
  nackFor?: (playerId: string) => boolean;
  /** Seat is a spectator: no player record, still eats broadcasts. */
  isSpectator?: (playerId: string) => boolean;
  /** 'ready' sink — a held-off-spawn seat's client finished warming
   *  (session veil dropped); releases the body into the world. */
  readySpawn?: (playerId: string) => void;
  /** Spawn pacing — seat ids the joiner's world hasn't admitted yet;
   *  TickFanout admits them a few per tick and gates their records
   *  meanwhile. Room.admitPending.set. */
  admitQueue?: (playerId: string, ids: Set<string>) => void;
  /** tickNack gate — false while the client's join burst still holds
   *  its tick frames (seq gaps there are by design, not loss). */
  drainedForTicks?: (playerId: string) => boolean;
  /** Flood-control breach → pause the socket's inbound dispatch for ms.
   *  A tripped socket stops paying parse+validate per flooded frame;
   *  Bun 1.4 ws.pause()/resume() closes the no-inbound-backpressure gap. */
  floodPause?: (playerId: string, ms: number) => void;
  /** Deploy claim sink — Room.deployables.handleDeploy. The return is
   *  the claim verdict the claimant sees in its claimAck. */
  onDeploy?: (playerId: string, kind: string, pos: Vec3, vel?: Vec3) => ClaimVerdict;
  /** Repair-beam claim sink — Room.deployables.repair. */
  onRepair?: (playerId: string, targetId: number) => ClaimVerdict;
  /** Blast aftermath (deployables, flag/pickup punts, wildlife splash,
   *  armor sweeps, shadow impulses, flag drops) rides the emit channel —
   *  subscribe to the bus instead of hanging a hook here. */
  influence?: InfluenceMap;
  /** Instant-skill claim sink — Room.moveSim.drainEnergy(ENERGY.skillCost). */
  onSkillUse?: (playerId: string, skill?: string) => ClaimVerdict;
  /** Carried-flag throw claim — RoomFlags.throwFor. */
  onThrowFlag?: (playerId: string) => void;
  /** Shadow-move hooks — Room.moveSim. Position reports reconcile the
   *  sim; teleport/respawn resync it; inputMove feeds it. */
  /** Returns false when the event is stale (seq regression on an
   *  unordered transport) — the handler then skips its side effects. */
  moveInput?: (playerId: string, input: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number, ageMs?: number) => boolean | void;
  /** Reports reconcile the sim; a non-null return is the sim's truth when
   *  the report diverged past tolerance — send it back as a correction. */
  moveReport?: (playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number, rttMs?: number) => { pos: Vec3; vel: Vec3; inputSeq: number; onGround: boolean } | null;
  /** Shadow's consumed-input watermark for gameState restores — anchors
   *  the client's post-flap journal replay. */
  inputSeqOf?: (playerId: string) => number;
  /** Rabbit rooms: current flag carrier (null = flag loose). Present only
   *  in rabbit rooms — CombatHandler gates all PvP damage on the pair
   *  involving the carrier. */
  rabbitCarrier?: () => string | null;
  /** Rabbit flag exists (first corpse spawned it) — CombatHandler. */
  rabbitFlagLive?: () => boolean;
  /** Rabbit bottom-feeder ids — RoomScore.bottomFeeders. */
  rabbitBottom?: () => Set<string>;
  /** Jet-tank access for heal-beam ammo — energy is server truth. */
  drainEnergy?: (playerId: string, amount: number) => void;
  /** Enemy-dome blast occlusion — blast at the shield edge can't splash
   *  occupants inside. Wired from Room.deployables.shieldedPoint. */
  shieldBlocked?: (from: Vec3, to: Vec3, shooterId: string) => boolean;
  /** Target uplink-transit estimate (ms) — blast lag-comp subtracts the
   *  broadcast lead so validation aims at the shooter's screen point. */
  transitOf?: (playerId: string) => number;
  /** Link jitter EMA — bounds the shooter's claimed render lag. */
  transitVarOf?: (playerId: string) => number;
  /** Server-measured RTT (ping/pong echo) — cross-checks the
   *  client-reported transit inside the move shadow. */
  transitNote?: (playerId: string, rttMs: number, stamp: number) => void;
  /** Claim-declared trigger instant — the shooter's server-clock estimate;
   *  (arrival − fireAt) is that claim's measured uplink transit. */
  uplinkNote?: (playerId: string, fireAt: number) => void;
  /** Binary playerHit lane — the room owns wireIds, returns false when an
   *  id can't resolve so the caller falls back to the JSON broadcast. */
  wireHit?: CombatDeps['wireHit'];
  /** Room wireId lookup for S→C binary events (u16 on the wire). */
  widOf?: (playerId: string) => number | undefined;
  /** Broadcast one pre-encoded binary frame (broadcastBinaryReliable). */
  wireCast?: (data: Uint8Array, journaled?: boolean | 'volatile', exclude?: string) => void;
  /** Single-recipient reliable binary (knockback — victim-only). */
  wireTo?: (playerId: string, data: Uint8Array, journaled?: boolean | 'volatile') => void;
  /** Arrival-time muzzle relay already flashed this shotId. */
  earlyRelayed?: (playerId: string, shotId?: string) => boolean;
  energyOf?: (playerId: string) => number | null;
  groundedOf?: (playerId: string) => boolean;
  /** Wire-invisible cloak: position-bearing emits must not leak to
   *  non-teammates while this holds (records, relays, snapshots). */
  cloakHidden?: (playerId: string) => boolean;
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
  /** Bot chat lands as a 'botSpoke' event — Room relays it as a 'reply'
   *  notice to the squad. Player chat lands as 'chat' — Room keyword-
   *  matches it into a bot notice (gg/ez/name-mention). */
  /** Mute the shadow's divergence judge ~1 RTT without re-seating it —
   *  armed alongside correctionGraceUntil whenever a correction goes out:
   *  pre-correction reports still in flight would otherwise blip the
   *  divergence counter toward a kick. */
  moveMute?: (playerId: string) => void;
  moveTrack?: (playerId: string, pos: Vec3, yaw: number) => void;
  moveUntrack?: (playerId: string) => void;
  /** When set, the sim is truth: position reports degrade to aim/ping/
   *  liveness hints and never write player.position. */
  moveAuthority?: () => boolean;
  /** Room heartbeat counters — every validation/damage funnel bumps its
   *  own tags; Room.healthTick flushes the map on a timer. */
  health?: Map<string, number>;
  /** Distance from a player to the nearest live creature — env-damage
   *  claims far past melee range get flagged, not silently eaten. */
  envRange?: (playerId: string) => number;
  /** Nearest ball / crawler to a point — self-frag autopsy. */
  preyNear?: (pos: Vec3, shooterId?: string) => { ball: number; crawler: number; foe: number };
  /** A legit fire claim lands as a 'fire' event — the sheep meter's
   *  human ignore debit reads its recency (bots report via BrainOut). */
  /** Live deployables for gameState joins — RoomDeployables.snapshot. */
  deployables?: () => { id: number; owner: string; kind: DeployKind; pos: Vec3; hp?: number; armor?: number; team?: string }[];
  /** Fire-intent → authoritative shell spawn (RoomProjectiles). Returns
   *  the LiveProj id or null when the weapon has no body. Only
   *  server-simmed weapons route here. */
  fireProjectile?: (ownerId: string, weaponType: number, origin: Vec3, dir: Vec3, ownerVel: Vec3, shotId?: string, lagS?: number) => string | null;
  /** Beam-intent resolution — the honest ray a Lightning tick strikes
   *  (terrain/wall/player/creature, earliest wins). Room.beamSweep. */
  beamSweep?: (shooterId: string, muzzle: Vec3, dir: Vec3, range: number, includeTeammates?: boolean) => BeamContact | null;
  /** Beam contact damage sinks — BallSim/CreatureSim handleHit. */
  ballHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  crawlerHit?: (playerId: string, id: number, damage: number) => HitVerdict | null;
  /** Repair-beam intent resolution — Room.deployables.repairTarget. */
  repairTarget?: (playerId: string, muzzle: Vec3, dir: Vec3, range: number) => number | null;
}

/** RoomInfo → CombatDeps projection — kept out of the constructor so the
 *  handler table stays the ctor's readable half. */
function combatDeps(roomInfo: RoomInfo | undefined): CombatDeps {
  return {
    emit: roomInfo?.emit,
    rng: roomInfo?.rng,
    teams: roomInfo?.teams,
    friendlyFire: roomInfo?.friendlyFire,
    rabbitCarrier: roomInfo?.rabbitCarrier,
    rabbitFlagLive: roomInfo?.rabbitFlagLive,
    rabbitBottom: roomInfo?.rabbitBottom,
    drainEnergy: roomInfo?.drainEnergy,
    shieldBlocked: roomInfo?.shieldBlocked,
    energyOf: roomInfo?.energyOf,
    moveResync: roomInfo?.moveResync,

    mode: roomInfo?.mode,
    mods: roomInfo?.mods,
    gunRungOf: roomInfo?.gunRungOf,
    gunGameHeld: roomInfo?.gunGameHeld,
    influence: roomInfo?.influence,
    health: roomInfo?.health,
    envRange: roomInfo?.envRange,
    preyNear: roomInfo?.preyNear,
    fireProjectile: roomInfo?.fireProjectile,
    beamSweep: roomInfo?.beamSweep,
    ballHit: roomInfo?.ballHit,
    crawlerHit: roomInfo?.crawlerHit,
    repairTarget: roomInfo?.repairTarget,
    repair: roomInfo?.onRepair,
    transitOf: roomInfo?.transitOf,
    transitVarOf: roomInfo?.transitVarOf,
    uplinkNote: roomInfo?.uplinkNote,
    wireHit: roomInfo?.wireHit,
    widOf: roomInfo?.widOf,
    wireCast: roomInfo?.wireCast,
    wireTo: roomInfo?.wireTo,
    earlyRelayed: roomInfo?.earlyRelayed,
  };
}

export class MessageHandler {
  // Public fields/methods are the MoveClaims host surface (moveClaims.ts)
  // — the position/teleport plausibility funnel lives there.
  playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  broadcast: BroadcastFn;
  sendToPlayer: SendToPlayerFn;
  // Public — wire.ts handlers drive these directly.
  moves: MoveClaims;
  // Everything that deals damage — projectiles, blasts, env damage, respawns
  combat: CombatHandler;
  /** Room/flag code reads killFeed for situation chatter (bot 'say' events). */
  get killFeed(): KillFeed { return this.combat.killFeed; }
  /** Fast-forward driver seam: lapses sim-timed respawn deadlines when
   *  sim-time outruns wall time. Live rooms never call it — the wall
   *  timers fire first there, so this is a no-op shadow. */
  respawnTick(now: number): void { this.combat.respawner.tick(now); }
  // Server-owned creatures (balls). Optional — a missing/unloadable
  // heightmap must not take down the whole game server.
  ballSim: BallSim | null = null;
  // Server-owned melee species (crawlers) — same pattern as ballSim.
  creatureSim: CreatureSim | null = null;
  private rateLimitWarnings: Map<string, number> = new Map();
  /** Bot bolt ids are wallNow-keyed — a bot firing several bolts in the
   *  same millisecond (multi-weapon tick) would otherwise broadcast one
   *  id twice and the client's registry would overwrite the first mesh. */
  private botBoltSeq = 0;
  private readonly RATE_WARN_COOLDOWN_MS = 5000;

  /** UDP volatile lane: mint a session bind token for a joiner (native
   *  clients read `udp:{token,port}` in gameState and point their loopback
   *  shim at it). Static/global like ConnectionManager.publishFns —
   *  server.ts sets it when FPS_UDP_PORT is live; absent = key omitted
   *  from gameState (JSON.stringify drops undefined fields). */
  static udpBind: ((playerId: string) => { token: string; port: number } | undefined) | undefined;

  /** Seats a gameState ships inline; the rest pace in via the fanout. */
  static readonly JOIN_INLINE_SEATS = 6;

  roomInfo: RoomInfo = { room: 'default', mode: '' };

  /** Set from roomInfo.claimsAccepted at construction — wire.ts's claim
   *  verbs consult it before adjudicating (RoomInfo has the doc). */
  readonly acceptClaims: boolean;

  hb(key: string, n = 1): void {
    const h = this.roomInfo.health;
    if (h) {h.set(key, (h.get(key) ?? 0) + n);}
  }

  /** Uniform claim verdict — one ack per claim that carried claimSeq;
   *  claims without one stay legacy fire-and-forget (bot paths, old
   *  clients). Rejects bump the heartbeat so a massed drop pattern
   *  shows up on /metrics before any single client reports it. */
  claimAck(id: string, kind: string, seq: number | undefined, verdict: ClaimVerdict): void {
    if (seq === undefined) {return;}
    const ok = verdict === true;
    // Record under the in-flight dispatch key so a resent claim replay
    // gets the ORIGINAL verdict without re-applying the effect.
    if (this.pendingClaimKey) {this.claimVerdicts.set(this.pendingClaimKey, { ok, reason: ok ? undefined : String(verdict) });}
    if (!ok) {this.hb(`claimrej.${kind}`);}
    this.sendToPlayer(id, Object.assign({kind,seq,ok}, (ok ? {} : { reason: verdict }), {type: 'claimAck' as const}));
  }

  /** (playerId:type:claimSeq) → verdict — makes every stamped claim
   *  idempotent under replay: a socket that died mid-flight gets its
   *  intent resent post-reclaim, and the replay must not double-apply
   *  (double belt charge, double plant, double slam damage). Bounded —
   *  claimSeq is monotonic per player, so oldest-first eviction keeps
   *  the replay window covered. */
  private claimVerdicts = new Map<string, { ok: boolean; reason?: string }>();
  private pendingClaimKey: string | undefined;
  hbMax(key: string, v: number): void {
    const h = this.roomInfo.health;
    if (h && v > (h.get(key) ?? 0)) {h.set(key, Math.round(v * 10) / 10);}
  }

  constructor(
    playerManager: PlayerManager,
    rateLimiter: RateLimiter,
    broadcast: BroadcastFn,
    sendToPlayer: SendToPlayerFn,
    roomInfo?: RoomInfo,
  ) {
    this.playerManager = playerManager;
    this.rateLimiter = rateLimiter;
    this.broadcast = broadcast;
    this.sendToPlayer = sendToPlayer;
    if (roomInfo) {this.roomInfo = roomInfo;}
    this.acceptClaims = roomInfo?.claimsAccepted ?? true;
    this.combat = new CombatHandler(playerManager, broadcast, sendToPlayer, combatDeps(roomInfo));
    this.moves = new MoveClaims(this);
    this.attachStructures(roomInfo?.structures);
    // Per-type dispatch lives in wire.ts — a new message type is one
    // WIRE entry (validate + limit + handle), not edits in three files.
  }

  /** Server-sim entry point — deployable sentries fire through the same
   *  outcome funnel as player/bot damage. */
  mineBlast(ownerId: string, pos: Vec3, maxDamage: number, radius: number, knockback: number): void {
    this.combat.mineBlast(ownerId, pos, maxDamage, radius, knockback);
  }

  turretAttack(ownerId: string, targetId: string, damage: number): void {
    this.combat.turretAttack(ownerId, targetId, damage);
  }

  setBallSim(sim: BallSim): void {
    this.ballSim = sim;
  }

  setCreatureSim(sim: CreatureSim): void {
    this.creatureSim = sim;
  }

  crawlerBite(targetId: string, damage: number, species?: string, from?: { x: number; y: number; z: number }): void {
    this.combat.crawlerAttack(targetId, damage, species, from);
  }

  /** MoveSim-measured hard contact — server computes it on the shadow,
   *  never trusts a claim: fall damage can't be faked upward or dodged
   *  downward by what a client chooses to report. */
  fallDamage(targetId: string, damage: number): void {
    this.combat.serverHit('environment', targetId, damage, 'fell to death', { hb: 'dmg.fall' });
  }

  /** Kill zone — the shadow measured the body below the map's floor.
   *  Server-authoritative like the fall path: the client has no say. */
  killZone(targetId: string, damage: number): void {
    this.combat.serverHit('environment', targetId, damage, 'fell out of the arena', { hb: 'dmg.killzone' });
  }

  /** Admin hot-reload — re-point the map echo fields so the next gameState
   *  (joiners/spectators) carries the new layout. In-room clients get the
   *  matching `mapUpdate` broadcast from Room.applySpec. */
  setMap(m: Pick<RoomInfo, 'bases' | 'structures' | 'arena' | 'killY' | 'ambient' | 'terrain' | 'heightScale' | 'tileSize' | 'fog' | 'water' | 'terrainTex' | 'terrainPreset' | 'sky' | 'weather' | 'atmosphere' | 'interiors'>): void {
    // Explicit field writes (not Object.assign): a spec that omits a
    // field must clear it, not leave the previous map's value behind.
    this.roomInfo.bases = m.bases;
    this.roomInfo.structures = m.structures;
    this.roomInfo.arena = m.arena;
    this.roomInfo.killY = m.killY;
    this.roomInfo.ambient = m.ambient;
    this.roomInfo.terrain = m.terrain;
    this.roomInfo.heightScale = m.heightScale;
    this.roomInfo.tileSize = m.tileSize;
    this.roomInfo.fog = m.fog;
    this.roomInfo.water = m.water;
    this.roomInfo.terrainTex = m.terrainTex;
    this.roomInfo.terrainPreset = m.terrainPreset;
    this.roomInfo.sky = m.sky;
    this.roomInfo.weather = m.weather;
    this.roomInfo.atmosphere = m.atmosphere;
    this.roomInfo.interiors = m.interiors;
    this.attachStructures(m.structures);
  }

  /** Rebuild the collider set claim validation occludes against —
   *  ctor and admin hot-reload both come through here. Interior hull
   *  boxes ride the wire list already (eff() merges them). */
  attachStructures(list: RoomInfo['structures']): void {
    this.combat.solids = structureColliders(list);
  }

  /** Server-bot fire: broadcast the visible bolt, then apply the hitscan
   *  outcome through combat's shared funnel. */
  botFire(shooterId: string, targetId: string | null, position: Vec3, velocity: Vec3, weaponType: number, hit: boolean): void {
    this.broadcast({
      type: 'projectileCreated',
      projectileId: `bot-${shooterId}-${wallNow()}-${((this.botBoltSeq += 1) - 1)}`,
      ownerId: shooterId,
      position,
      velocity,
      weaponType,
    });
    if (hit && targetId) {this.combat.botAttack(shooterId, targetId, weaponType);}
  }

  /** Server-simulated projectile blast (bot rockets etc.) — combat's
   *  trusted AOE path; the sim placed the pop, no cheat check needed. */
  serverBlast(ownerId: string, pos: Vec3, weaponType: number, excludeTargetId: string | null, opts?: { shotId?: string; attribWeaponType?: number; power?: number; air?: number; radiusScale?: number }): void {
    this.combat.serverBlast(ownerId, pos, weaponType, excludeTargetId, opts);
  }

  /** Rope-dart contact — room projectile sim resolved a Hook connect. */
  grapple(ownerId: string, anchor: Vec3, victimId: string | null): void {
    this.combat.grapple(ownerId, anchor, victimId);
  }

  /** Server-simulated direct hit — the room's projectile sim resolved the
   *  contact; combat applies damage through the same funnel as botFire. */
  botAttack(shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string): void {
    this.combat.botAttack(shooterId, targetId, weaponType, airtime, shotId);
  }

  /** Warn keys are ${id}:${msg.type} — every teardown path must sweep
   *  them or a leaver's entries sit in the map for the room's life. */
  private dropWarnKeys(playerId: string): void {
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) {this.rateLimitWarnings.delete(key);}
    }
  }

  /** Drop per-player bookkeeping when a socket closes (grace-period cleanup
   *  leaves PlayerManager state alive, but rate-limit warn state is per-connection) */
  onPlayerDisconnected(playerId: string): void {
    this.dropWarnKeys(playerId);
    this.combat.onPlayerDisconnected(playerId);
    this.roomInfo.moveUntrack?.(playerId);
    this.moves.dropPlayer(playerId);
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs.
   *  Warn keys are cleared here too: a room hop is a removal without a
   *  disconnect, and the hopper's ${id}:* keys would otherwise sit in the
   *  old room's map for its life. */
  onPlayerRemoved(playerId: string): void {
    this.dropWarnKeys(playerId);
    this.combat.onPlayerRemoved(playerId);
    this.moves.dropPlayer(playerId);
    // Removal paths that skip onPlayerDisconnected (kick, reap, admin
    // reload, bot retire) must still free the moveSim shadow.
    this.roomInfo.moveUntrack?.(playerId);
  }

  /** A reclaimed session may restore a dead player whose respawn timer was
   *  cancelled at disconnect — re-arm it or they stay a ghost forever. */
  onPlayerReconnected(playerId: string): void {
    this.combat.ensureRespawn(playerId);
  }

  /** The room-echo half of gameState — identical for joiners and
   *  spectators: mode, team scores, map layout, mid-flight world state. */
  private roomEcho() {
    return {
      room: this.roomInfo.room,
      mode: this.roomInfo.mode || undefined,
      instagib: this.roomInfo.mods?.().instagib || undefined,
      gungame: this.roomInfo.mods?.().gungame || undefined,
      igun: this.roomInfo.mods?.().igun || undefined,
      // Top level, not inside map: a bare arena (no bases/terrain) still
      // has a name, and the scoreboard title wants it either way.
      mapName: this.roomInfo.mapName?.(),
      scores: this.roomInfo.scores ? (Object.assign({}, this.roomInfo.scores)) : undefined,
      ffaScores: this.roomInfo.ffaScores?.(),
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena || this.roomInfo.terrain || this.roomInfo.heightScale || this.roomInfo.tileSize || this.roomInfo.fog || this.roomInfo.water || this.roomInfo.weather || this.roomInfo.atmosphere || this.roomInfo.spawns?.() || this.roomInfo.teamSpawns?.()
        ? (() => { const m = { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena, killY: this.roomInfo.killY, ambient: this.roomInfo.ambient, terrain: this.roomInfo.terrain, heightScale: this.roomInfo.heightScale, tileSize: this.roomInfo.tileSize, fog: this.roomInfo.fog, water: this.roomInfo.water, spawns: this.roomInfo.spawns?.() ?? undefined, teamSpawns: this.roomInfo.teamSpawns?.() ?? undefined, terrainTex: this.roomInfo.terrainTex, terrainPreset: this.roomInfo.terrainPreset, sky: this.roomInfo.sky, weather: this.roomInfo.weather, atmosphere: this.roomInfo.atmosphere, interiors: this.roomInfo.interiors };
          logger.debug(`roomEcho map keys: ${Object.keys(m).join(',')} interiors=${m.interiors?.length}`); return m; })()
        : undefined,
      flags: this.roomInfo.flags?.(),
      pickups: this.roomInfo.pickups?.(),
      deployables: this.roomInfo.deployables?.(),
      matchEndsAt: this.roomInfo.matchEndsAt?.() || undefined,
      respawnMs: CONFIG.respawnDelayMs,
    };
  }

  handleHandshake(playerId: string, sessionToken?: string, isReconnect = false): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) {return;}
    this.roomInfo.moveTrack?.(playerId, player.position, player.rotation.yaw);

    if (isReconnect) {
      // A reclaimed session's seq counter restarted at 0 on the client —
      // the retained lastSeq from the dead socket would class every new
      // report as stale, freezing position for the whole session (seen:
      // F5 reload → permanent hash desync + implausible-spawn rejects).
      // The judge anchors reseat on stored truth for the same reason.
      player.lastSeq = 0;
      player.lastPosCheckPos = Object.assign({}, player.position);
      player.lastPosCheckTime = wallNow();
      player.consecutiveRejects = 0;
      this.roomInfo.moveMute?.(playerId);
    }

    // Reconnecting dead player: the disconnect cancelled their respawn
    // timer — re-arm it or they stay dead for the rest of the session.
    this.combat.ensureRespawnScheduled(playerId);

    this.sendWorldState(playerId, sessionToken);

    // The playerJoined announce waits for the first position report —
    // a menu/lobby sitter who never reports would otherwise spawn a
    // frozen ghost mesh at the spawn default on every peer's screen.
    // announceIfInWorld() fires it from handlePosition/handleTeleport.
    // Grace reconnects never emitted a playerLeft, so rejoins skip it
    // regardless (peers still carry the roster entry).
    if (!isReconnect && player.hasReceivedPosition) {
      this.announceIfInWorld(player);
    }
  }

  /** In-world roster as a join snapshot. Join storms reserialize the
   *  same O(n) roster per joiner, so build once per TTL window and share
   *  — the snapshot can lag ≤100ms, invisible under client interp which
   *  converges to live updates within frames anyway. Callers must not
   *  mutate the returned array (the cache hands it back out). */
  private rosterCache: { at: WallMs; data: GameStatePlayer[] } | undefined;
  private inWorldRoster(): GameStatePlayer[] {
    const now = wallNow();
    if (this.rosterCache && now - this.rosterCache.at < 100) {return this.rosterCache.data;}
    const data = [...this.playerManager.getAllPlayers().values()]
      .filter((p): boolean => (p.isBot || p.hasReceivedPosition) && !p.awaitingReady)
      .map((p): GameStatePlayer => this.playerManager.toGameStatePlayer(p));
    this.rosterCache = { at: now, data };
    return data;
  }

  /** Full world-state replay for one player — the (re)join payload:
   *  gameState (roster/team/map/flags/pickups/deployables) plus the
   *  creature rosters. Shared by handshake and the resync request, so an
   *  alt-tab catch-up rebuilds the same truth a reload would. */
  sendWorldState(playerId: string, sessionToken?: string): void {
    const player = this.playerManager.getPlayer(playerId);
    // AFK-demoted seats resync too: serve the spectator world state
    // (+ wireIds roster) or their client rides orphaned binary forever.
    if (!player) {
      if (this.roomInfo.isSpectator?.(playerId)) {this.handleSpectatorHandshake(playerId);}
      return;
    }

    // Humans that never reported a position aren't in-world yet — listing
    // them spawns a frozen ghost mesh at the spawn default for the joiner.
    // Cloak-hidden seats are out of the snapshot too: the joiner's mesh
    // for them spawns when the record stream re-admits them post-reveal.
    const roster = this.inWorldRoster().filter((p): boolean => p.id !== playerId
      && !(this.roomInfo.cloakHidden?.(p.id) && (player.team === undefined || player.team !== p.team)));
    // Spawn pacing (Nucleus model): an unpaced world sends its biggest
    // tick to the peer least able to take it. The nearest JOIN_INLINE_SEATS
    // ride gameState; the rest admit a few per fanout tick via direct
    // playerJoined, their records gated until the admit lands.
    const mp = player.position;
    const byDist = [...roster].sort((a, b): number =>
      (a.position.x - mp.x) ** 2 + (a.position.z - mp.z) ** 2
      - ((b.position.x - mp.x) ** 2 + (b.position.z - mp.z) ** 2));
    const pending = new Set(byDist.slice(MessageHandler.JOIN_INLINE_SEATS).map((p): string => p.id));
    if (pending.size > 0) {this.roomInfo.admitQueue?.(playerId, pending);}
    const playersData = roster.filter((p): boolean => !pending.has(p.id));

    // Early map announce on the silent mapUpdate verb — the joiner's
    // ~2.7s terrain fetch+apply waits on gameState otherwise; shipping
    // the identical map payload one message earlier lets the client
    // build the world while the roster snapshot + creature rosters
    // serialize behind it. gameState still carries map (unchanged wire);
    // applyTerrain is keyed — the second apply is a no-op.
    const early = this.roomEcho();
    if (early.map) {this.sendToPlayer(playerId, Object.assign({type: 'mapUpdate' as const, mapName: early.mapName, silent: true}, early.map));}

    this.sendGameState(playerId, playersData, {
      sessionToken,
      // wt clients only: advertise the reliable-binary lane (stream 2).
      // Absent on ws/old builds so clients stay on the base64 envelope.
      caps: player.transport === 'wt' ? { binLane: 1 } : undefined,
      // Native-shell volatile lane: the loopback shim binds datagrams to
      // this session by token; volatile claims/ticks ride UDP, reliable
      // stays on ws. Absent when the lane isn't live.
      udp: MessageHandler.udpBind?.(playerId),
      // v3 record-id roster — everyone minted before this joiner needs
      // their mapping shipped inline (deltas only reach live sockets).
      wireIds: this.roomInfo.wireIds?.() ?? {},
      team: player.team,
      localPlayerState: {
        position: Object.assign({}, player.position),
        rotation: Object.assign({}, player.rotation),
        velocity: Object.assign({}, player.velocity),
        health: player.health,
        armor: player.armor,
        isDead: player.isDead,
        // The shadow's input watermark — the anchor is last-accepted
        // truth, so the reconnecting client replays its journal over
        // it instead of snapping backward (see restoreLocalPlayer).
        inputSeq: this.roomInfo.inputSeqOf?.(playerId),
        // Remaining spawn shield — a joiner who lands mid-window has the
        // client predict blasts the server is still refusing to apply.
        protectedMs: Math.max(0, player.protectedUntil - simNow()),
        held: player.heldTokens || undefined,
      },
    });

    // Sim replay frames — each world sim reports its own roster
    // snapshot; anything spawned after arrives as a live event.
    this.sendSimWorldState(playerId);
  }

  /** The one gameState builder — spectator gets the bare envelope,
   *  joiners layer identity/local-state fields on top via extras. */
  private sendGameState(
    playerId: string,
    playersData: GameStatePlayer[],
    extras?: Record<string, unknown>,
  ): void {
    this.sendToPlayer(playerId, Object.assign({players: playersData,protocolVersion: PROTOCOL_VERSION}, this.roomEcho(), extras, {type: 'gameState' as const}));
  }

  /** Broadcast the playerJoined announce once — gates on the flag so a
   *  player reports for a while, then a second path can't re-announce. */
  announceIfInWorld(player: PlayerState): void {
    // Held-off-spawn seats must not announce — their position reports
    // during the veil warmup would otherwise mint the remote mesh early.
    // A cloaked seat's announce carries position to enemies too; leave
    // the flag unset so the first uncloaked report announces it instead.
    if (player.joinAnnounced || player.awaitingReady || this.roomInfo.cloakHidden?.(player.id)) {return;}
    player.joinAnnounced = true;
    this.announceJoin(player);
  }

  private announceJoin(player: PlayerState): void {
    this.broadcast(spawnPayload(WORLD_MODEL.player!, player.id, 'playerId', {
      name: player.name,
      internalId: player.internalId,
      position: player.position,
      rotation: player.rotation,
      team: player.team,
      // Emit-time composite — see toGameStatePlayer; the record stays
      // pure, a live udp lane advertises itself as '<tier>+udp'.
      transport: ConnectionManager.udpLive?.(player.id) ? `${player.transport ?? 'ws'}+udp` : player.transport,
      armorClass: player.armorClass,
      weapon: player.weapon,
      health: player.health,
      isDead: player.isDead,
    }) as ServerMessage, player.id);
  }

  /** Spectator join — no player record, so everyone is "others", there's
   *  no localPlayerState, and no playerJoined goes out. The socket still
   *  gets every broadcast + tick frame (sent to connections, not players). */
  handleSpectatorHandshake(playerId: string): void {
    // wireIds is mandatory: spectators consume the same binary events;
    // an absent roster wipes the client wid table into orphan storms.
    this.sendGameState(playerId, this.inWorldRoster(), {wireIds: this.roomInfo.wireIds?.() ?? {}});
    this.sendSimWorldState(playerId);
  }

  /** World-state replay frames every registered sim opts into — adding
   *  a world sim to room.sims is now the whole wiring for its replay. */
  private sendSimWorldState(playerId: string): void {
    for (const m of this.roomInfo.simsWorldState?.() ?? []) {this.sendToPlayer(playerId, m);}
  }

  /** `at` = socket-arrival time — the command drain runs it against the
   *  rate limiter so a tick-lag backlog is windowed by when it came in,
   *  not by when the stalled tick caught up. */
  handleMessage(playerId: string, msg: ClientMessage, at?: WallMs, trusted = false): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) {return;}

    const verdict = this.rateLimiter.check(playerId, msg.type, at);
    if (verdict !== 'ok') {
      const warnKey = `${playerId}:${msg.type}`;
      const now = wallNow();
      const lastWarn = this.rateLimitWarnings.get(warnKey);
      // Per-type key, not a flat counter — /metrics answers "what was
      // flooding" without a log dig. Message types are a bounded union.
      this.hb(`ratelimit:${msg.type}`);
      // Muted chat still echoes back to the sender, flagged — the
      // client grays the line it already printed so the spammer sees
      // their words went nowhere, like a censored send.
      if ((verdict === 'tripped' || verdict === 'muted') && msg.type === 'chat') {
        this.sendToPlayer(playerId, { type: 'chat', playerId, text: msg.text, vgs: msg.vgs, team: msg.team || undefined, muted: true });
      }
      // The trip tells the offender once — T2's flood-control notice;
      // continued muted drops are logged but silent (canon: the spammer
      // already knows why they went quiet).
      if (verdict === 'tripped') {
        logger.warn(`Flood control tripped`, { playerId, messageType: msg.type });
        this.sendToPlayer(playerId, { type: 'serverWarn', text: `flood control: ${msg.type} muted` });
        // A tripping socket keeps paying full parse+validate per frame
        // on drops — pause stops inbound dispatch entirely for a second.
        this.roomInfo.floodPause?.(playerId, 1000);
      } else if (!lastWarn || now - lastWarn > this.RATE_WARN_COOLDOWN_MS) {
        this.rateLimitWarnings.set(warnKey, now);
        logger.warn(`Rate limit exceeded`, { playerId, messageType: msg.type });
        // Silent drops look like lag to the offender — tell them. Same
        // 5s throttle as the log line so the notice can't itself flood.
        this.sendToPlayer(playerId, { type: 'serverWarn', text: `rate-limited: ${msg.type} dropped` });
      }
      return;
    }

    // Indexed access widens to the union of all handler signatures —
    // the per-key narrowing already happened in the table, so one cast
    // here replaces one per entry.
    // Any valid, rate-limit-passing message proves the socket is alive —
    // liveness can't live per-handler or a chatty-but-untracked type
    // (inputMove in authority mode) starves the idle reaper mid-match.
    player.lastSeen = wallNow();
    // Arrival stamp for uplink math: fireAt↔arrival measures wire transit;
    // measuring at handle time counts command-buffer queue wait too and
    // makes lagS hot (traj-epoch outliers). c.at is enqueue-side wallNow.
    (msg as { arrivedAt?: WallMs }).arrivedAt = at ?? wallNow();

    // Binary-decoded frames were shape+range-checked at the byte
    // boundary — re-walking their field table is pure noise.
    if (!trusted) {checkIntent(msg.type, msg as unknown as Record<string, unknown>);}
    const handler = WIRE[msg.type]?.handle as ((h: MessageHandler, id: string, m: ClientMessage) => void) | undefined;
    if (!handler) {
      this.hb('unhandled');
      logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
      return;
    }
    // Stamped-claim idempotency: the post-reclaim replay resends the same
    // message verbatim — same claimSeq — so a second arrival replays the
    // recorded verdict instead of re-applying the effect.
    const cs = (msg as { claimSeq?: number }).claimSeq;
    if (cs !== undefined) {
      const key = `${playerId}:${msg.type}:${cs}`;
      const seen = this.claimVerdicts.get(key);
      if (seen) {
        this.sendToPlayer(playerId, Object.assign({ kind: msg.type, seq: cs, ok: seen.ok }, (seen.ok ? {} : { reason: seen.reason }), { type: 'claimAck' as const }));
        return;
      }
      this.pendingClaimKey = key;
    }
    try { handler(this, playerId, msg); }
    finally { this.pendingClaimKey = undefined; }
    // Bound the map — a player legitimately replays only the last ~3s of
    // stamps; 4k entries is far past every player's window.
    if (this.claimVerdicts.size > 4096) {
      const it = this.claimVerdicts.keys();
      for (let i = 0; i < 1024; i += 1) { this.claimVerdicts.delete(it.next().value!); }
    }
  }

  // MoveClaims host surface — the room's optional moveSim hooks arrive
  // as always-defined delegates so the funnel doesn't sprinkle ?.().
  moveAuthority(): boolean { return this.roomInfo.moveAuthority?.() ?? false; }
  moveReport(playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number, rttMs?: number): { pos: Vec3; vel: Vec3; inputSeq: number; onGround: boolean; } | null {
    return this.roomInfo.moveReport?.(playerId, pos, yaw, vel, inputSeq, rttMs) ?? null;
  }
  moveInput(playerId: string, input: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number, ageMs?: number): boolean | void {
    return this.roomInfo.moveInput?.(playerId, input, status, seq, ageMs);
  }
  inputSeqOf(playerId: string): number { return this.roomInfo.inputSeqOf?.(playerId) ?? -1; }
  moveResync(playerId: string, pos: Vec3, yaw: number): void { this.roomInfo.moveResync?.(playerId, pos, yaw); }
  moveMute(playerId: string): void { this.roomInfo.moveMute?.(playerId); }
  cloakHidden(playerId: string): boolean { return this.roomInfo.cloakHidden?.(playerId) ?? false; }

  // jump/jetpack are pure presence relays — same shape, dead check, echo
  // to everyone but the sender for remote-side jump-dust/jet FX.
  relayPresenceEvent(playerId: string, msg: Extract<ClientMessage, { type: 'jump' | 'jetpack' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {return;}
    // Cloak secrecy: a jet-flash edge carries the claimed position, so
    // relaying it to enemies peels the wire-side hide.
    if (this.roomInfo.cloakHidden?.(playerId)) {return;}
    const wid = this.roomInfo.widOf?.(playerId);
    if (wid !== undefined && this.roomInfo.wireCast) {
      this.roomInfo.wireCast(encodeWidPos(msg.type === 'jump' ? WIRE_E_JUMP : WIRE_E_JET, wid, msg.position), 'volatile', playerId);
      return;
    }
    this.broadcast({ type: msg.type, playerId, position: msg.position }, playerId);
  }

  handleSnapshotRequest(playerId: string): void {
    // Same secrecy rule as the roster snapshot: hidden enemies don't
    // exist for the requester; their mesh re-spawns when the record
    // stream re-admits them after the reveal window.
    const requester = this.playerManager.getPlayer(playerId);
    const players: SnapshotPlayer[] = [];
    for (const [, p] of this.playerManager.getAllPlayers()) {
      if (p.id !== playerId && this.roomInfo.cloakHidden?.(p.id)
          && (requester === undefined || requester.team === undefined || requester.team !== p.team)) {continue;}
      players.push({
        id: p.id,
        internalId: p.internalId,
        position: Object.assign({}, p.position),
        rotation: Object.assign({}, p.rotation),
        velocity: Object.assign({}, p.velocity),
        health: p.health,
        isDead: p.isDead,
        kills: p.kills,
        deaths: p.deaths,
      });
    }

    this.sendToPlayer(playerId, {
      type: 'snapshot',
      players,
      timestamp: wallNow(),
    });

    // Players were the only healed lane — a desynced flag/pickup/deploy
    // had no path back to truth and warned forever. Resync replays the
    // same world rosters a fresh joiner gets.
    this.sendSimWorldState(playerId);

    // Log full state for desync debugging
    const stateStr = players.map((p): string =>
      `${p.id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(2)},${p.position.y.toFixed(2)},${p.position.z.toFixed(2)})`
    ).join(' | ');
    const hashInput = players.map((p): string =>
      `${p.id}:${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}:${p.health}:${p.isDead ? 1 : 0}`
    ).join('|');
    logger.debug(`Snapshot requested by ${playerId} | Server state: ${stateStr} | Hash input: ${hashInput}`);
  }

  /** Room teardown — the combat funnel owns the pending timers. */
  dispose(): void {
    this.combat.dispose();
  }
}
