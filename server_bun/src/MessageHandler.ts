import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3, PlayerState, ClaimVerdict } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler, type CombatDeps } from './CombatHandler.ts';
import type { KillFeed } from './killFeed.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { CONFIG } from './config.ts';
import { WIRE } from './wire.ts';
import { MoveClaims } from './moveClaims.ts';
import type { BallSim } from './BallSim.ts';
import type { CreatureSim } from './CreatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import type { PickupKind } from '../../shared/pickups.ts';

import type { TeamId } from '../../shared/teams.ts';
import type { DeployKind } from '../../shared/deployables.ts';
import type { RoomEventSink } from './roomEvents.ts';
import { wallNow } from './wallClock.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

/** What the enclosing Room tells its MessageHandler about the match. */
export interface RoomInfo {
  room: string;
  mode: string;
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
  /** Static structures from the map spec — echoed on gameState so every
   *  client builds the same base compounds/cover. */
  structures?: import('../../shared/mapSpec.ts').StructureSpec[];
  /** Arena dome from the map spec — center {x,z} + radius. */
  arena?: { x: number; z: number; radius: number };
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
  fog?: { color: [number, number, number]; distance?: number; visible?: number };
  /** Baked terrain albedo + skybox dir — client dressing only. */
  terrainTex?: string;
  sky?: string;
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
  /** Match-clock deadline (epoch ms) for gameState joins — Room.matchEndsAt.
   *  0 means "not armed yet" (no humans have joined). */
  matchEndsAt?: () => number;
  /** Deploy claim sink — Room.deployables.handleDeploy. The return is
   *  the claim verdict the claimant sees in its claimAck. */
  onDeploy?: (playerId: string, kind: string, pos: Vec3) => ClaimVerdict;
  /** Repair-beam claim sink — Room.deployables.repair. */
  onRepair?: (playerId: string, targetId: number) => ClaimVerdict;
  /** Blast aftermath (deployables, flag/pickup punts, wildlife splash,
   *  armor sweeps, shadow impulses, flag drops) rides the emit channel —
   *  subscribe to the bus instead of hanging a hook here. */
  influence?: InfluenceMap;
  /** Instant-skill claim sink — Room.moveSim.drainEnergy(ENERGY.skillCost). */
  onSkillUse?: (playerId: string) => ClaimVerdict;
  /** Carried-flag throw claim — RoomFlags.throwFor. */
  onThrowFlag?: (playerId: string) => void;
  /** Shadow-move hooks — Room.moveSim. Position reports reconcile the
   *  sim; teleport/respawn resync it; inputMove feeds it. */
  /** Returns false when the event is stale (seq regression on an
   *  unordered transport) — the handler then skips its side effects. */
  moveInput?: (playerId: string, input: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number) => boolean | void;
  /** Reports reconcile the sim; a non-null return is the sim's truth when
   *  the report diverged past tolerance — send it back as a correction. */
  moveReport?: (playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number) => { pos: Vec3; vel: Vec3; inputSeq: number; onGround: boolean } | null;
  /** Rabbit rooms: current flag carrier (null = flag loose). Present only
   *  in rabbit rooms — CombatHandler gates all PvP damage on the pair
   *  involving the carrier. */
  rabbitCarrier?: () => string | null;
  /** Rabbit bottom-feeder ids — RoomScore.bottomFeeders. */
  rabbitBottom?: () => Set<string>;
  /** Jet-tank access for heal-beam ammo — energy is server truth. */
  drainEnergy?: (playerId: string, amount: number) => void;
  energyOf?: (playerId: string) => number | null;
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
    rabbitBottom: roomInfo?.rabbitBottom,
    drainEnergy: roomInfo?.drainEnergy,
    energyOf: roomInfo?.energyOf,
    moveResync: roomInfo?.moveResync,

    mode: roomInfo?.mode,
    influence: roomInfo?.influence,
    health: roomInfo?.health,
    envRange: roomInfo?.envRange,
    preyNear: roomInfo?.preyNear,
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

  roomInfo: RoomInfo = { room: 'default', mode: '' };

  hb(key: string, n = 1): void {
    const h = this.roomInfo.health;
    if (h) h.set(key, (h.get(key) ?? 0) + n);
  }

  /** Uniform claim verdict — one ack per claim that carried claimSeq;
   *  claims without one stay legacy fire-and-forget (bot paths, old
   *  clients). Rejects bump the heartbeat so a massed drop pattern
   *  shows up on /metrics before any single client reports it. */
  claimAck(id: string, kind: string, seq: number | undefined, verdict: ClaimVerdict): void {
    if (seq === undefined) return;
    const ok = verdict === true;
    if (!ok) this.hb(`claimrej.${kind}`);
    this.sendToPlayer(id, { type: 'claimAck', kind, seq, ok, ...(ok ? {} : { reason: verdict }) });
  }
  hbMax(key: string, v: number): void {
    const h = this.roomInfo.health;
    if (h && v > (h.get(key) ?? 0)) h.set(key, Math.round(v * 10) / 10);
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
    if (roomInfo) this.roomInfo = roomInfo;
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

  /** Admin hot-reload — re-point the map echo fields so the next gameState
   *  (joiners/spectators) carries the new layout. In-room clients get the
   *  matching `mapUpdate` broadcast from Room.applySpec. */
  setMap(m: Pick<RoomInfo, 'bases' | 'structures' | 'arena' | 'ambient' | 'terrain' | 'heightScale' | 'tileSize' | 'fog' | 'terrainTex' | 'sky' | 'interiors'>): void {
    // Explicit field writes (not Object.assign): a spec that omits a
    // field must clear it, not leave the previous map's value behind.
    this.roomInfo.bases = m.bases;
    this.roomInfo.structures = m.structures;
    this.roomInfo.arena = m.arena;
    this.roomInfo.ambient = m.ambient;
    this.roomInfo.terrain = m.terrain;
    this.roomInfo.heightScale = m.heightScale;
    this.roomInfo.tileSize = m.tileSize;
    this.roomInfo.fog = m.fog;
    this.roomInfo.terrainTex = m.terrainTex;
    this.roomInfo.sky = m.sky;
    this.roomInfo.interiors = m.interiors;
    this.attachStructures(m.structures);
  }

  /** Rebuild the collider set claim validation occludes against —
   *  ctor and admin hot-reload both come through here. */
  attachStructures(list: RoomInfo['structures']): void {
    this.combat.solids = structureColliders(list);
  }

  /** Server-bot fire: broadcast the visible bolt, then apply the hitscan
   *  outcome through combat's shared funnel. */
  botFire(shooterId: string, targetId: string | null, position: Vec3, velocity: Vec3, weaponType: number, hit: boolean): void {
    this.broadcast({
      type: 'projectileCreated',
      projectileId: `bot-${shooterId}-${wallNow()}-${this.botBoltSeq++}`,
      ownerId: shooterId,
      position,
      velocity,
      weaponType,
    });
    if (hit && targetId) this.combat.botAttack(shooterId, targetId, weaponType);
  }

  /** Server-simulated projectile blast (bot rockets etc.) — combat's
   *  trusted AOE path; the sim placed the pop, no cheat check needed. */
  serverBlast(ownerId: string, pos: Vec3, weaponType: number, excludeTargetId: string | null, shotId?: string, attribWeaponType?: number): void {
    this.combat.serverBlast(ownerId, pos, weaponType, excludeTargetId, shotId, attribWeaponType);
  }

  /** Server-simulated direct hit — the room's projectile sim resolved the
   *  contact; combat applies damage through the same funnel as botFire. */
  botAttack(shooterId: string, targetId: string, weaponType: number, airtime?: number, shotId?: string): void {
    this.combat.botAttack(shooterId, targetId, weaponType, airtime, shotId);
  }

  /** Drop per-player bookkeeping when a socket closes (grace-period cleanup
   *  leaves PlayerManager state alive, but rate-limit warn state is per-connection) */
  onPlayerDisconnected(playerId: string): void {
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) this.rateLimitWarnings.delete(key);
    }
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
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) this.rateLimitWarnings.delete(key);
    }
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
      // Top level, not inside map: a bare arena (no bases/terrain) still
      // has a name, and the scoreboard title wants it either way.
      mapName: this.roomInfo.mapName?.(),
      scores: this.roomInfo.scores ? { ...this.roomInfo.scores } : undefined,
      ffaScores: this.roomInfo.ffaScores?.(),
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena || this.roomInfo.terrain || this.roomInfo.heightScale || this.roomInfo.tileSize || this.roomInfo.fog
        ? (() => { const m = { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena, ambient: this.roomInfo.ambient, terrain: this.roomInfo.terrain, heightScale: this.roomInfo.heightScale, tileSize: this.roomInfo.tileSize, fog: this.roomInfo.fog, terrainTex: this.roomInfo.terrainTex, sky: this.roomInfo.sky, interiors: this.roomInfo.interiors };
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
    if (!player) return;
    this.roomInfo.moveTrack?.(playerId, player.position, player.rotation.yaw);

    if (isReconnect) {
      // A reclaimed session's seq counter restarted at 0 on the client —
      // the retained lastSeq from the dead socket would class every new
      // report as stale, freezing position for the whole session (seen:
      // F5 reload → permanent hash desync + implausible-spawn rejects).
      // The judge anchors reseat on stored truth for the same reason.
      player.lastSeq = 0;
      player.lastPosCheckPos = { ...player.position };
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

  /** Full world-state replay for one player — the (re)join payload:
   *  gameState (roster/team/map/flags/pickups/deployables) plus the
   *  creature rosters. Shared by handshake and the resync request, so an
   *  alt-tab catch-up rebuilds the same truth a reload would. */
  sendWorldState(playerId: string, sessionToken?: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const others = this.playerManager.getOtherPlayers(playerId);
    // Humans that never reported a position aren't in-world yet — listing
    // them spawns a frozen ghost mesh at the spawn default for the joiner.
    const playersData = others
      .filter((p) => p.isBot || p.hasReceivedPosition)
      .map((p) => this.playerManager.toGameStatePlayer(p));

    this.sendToPlayer(playerId, {
      type: 'gameState',
      players: playersData,
      sessionToken,
      protocolVersion: PROTOCOL_VERSION,
      // v3 record-id roster — everyone minted before this joiner needs
      // their mapping shipped inline (deltas only reach live sockets).
      wireIds: this.roomInfo.wireIds?.() ?? {},
      ...this.roomEcho(),
      team: player.team,
      localPlayerState: {
        position: { ...player.position },
        rotation: { ...player.rotation },
        velocity: { ...player.velocity },
        health: player.health,
        armor: player.armor,
        isDead: player.isDead,
      },
    });

    // Sim replay frames — each world sim reports its own roster
    // snapshot; anything spawned after arrives as a live event.
    this.sendSimWorldState(playerId);
  }

  /** Broadcast the playerJoined announce once — gates on the flag so a
   *  player reports for a while, then a second path can't re-announce. */
  announceIfInWorld(player: PlayerState): void {
    if (player.joinAnnounced) return;
    player.joinAnnounced = true;
    this.announceJoin(player);
  }

  private announceJoin(player: PlayerState): void {
    this.broadcast({
      type: 'playerJoined',
      playerId: player.id,
      name: player.name,
      internalId: player.internalId,
      position: player.position,
      rotation: player.rotation,
      team: player.team,
      transport: player.transport,
      armorClass: player.armorClass,
      health: player.health,
      isDead: player.isDead,
    }, player.id);
  }

  /** Spectator join — no player record, so everyone is "others", there's
   *  no localPlayerState, and no playerJoined goes out. The socket still
   *  gets every broadcast + tick frame (sent to connections, not players). */
  handleSpectatorHandshake(playerId: string): void {
    const playersData = [...this.playerManager.getAllPlayers().values()]
      .filter((p) => p.isBot || p.hasReceivedPosition)
      .map((p) => this.playerManager.toGameStatePlayer(p));
    this.sendToPlayer(playerId, {
      type: 'gameState',
      players: playersData,
      protocolVersion: PROTOCOL_VERSION,
      ...this.roomEcho(),
    });
    this.sendSimWorldState(playerId);
  }

  /** World-state replay frames every registered sim opts into — adding
   *  a world sim to room.sims is now the whole wiring for its replay. */
  private sendSimWorldState(playerId: string): void {
    for (const m of this.roomInfo.simsWorldState?.() ?? []) this.sendToPlayer(playerId, m);
  }

  /** `at` = socket-arrival time — the command drain runs it against the
   *  rate limiter so a tick-lag backlog is windowed by when it came in,
   *  not by when the stalled tick caught up. */
  handleMessage(playerId: string, msg: ClientMessage, at?: number): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

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

    const handler = WIRE[msg.type]?.handle as ((h: MessageHandler, id: string, m: ClientMessage) => void) | undefined;
    if (!handler) {
      this.hb('unhandled');
      logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
      return;
    }
    handler(this, playerId, msg);
  }

  // MoveClaims host surface — the room's optional moveSim hooks arrive
  // as always-defined delegates so the funnel doesn't sprinkle ?.().
  moveAuthority(): boolean { return this.roomInfo.moveAuthority?.() ?? false; }
  moveReport(playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number) {
    return this.roomInfo.moveReport?.(playerId, pos, yaw, vel, inputSeq) ?? null;
  }
  moveResync(playerId: string, pos: Vec3, yaw: number): void { this.roomInfo.moveResync?.(playerId, pos, yaw); }
  moveMute(playerId: string): void { this.roomInfo.moveMute?.(playerId); }

  // jump/jetpack are pure presence relays — same shape, dead check, echo
  // to everyone but the sender for remote-side jump-dust/jet FX.
  relayPresenceEvent(playerId: string, msg: Extract<ClientMessage, { type: 'jump' | 'jetpack' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.broadcast({ type: msg.type, playerId, position: msg.position }, playerId);
  }

  handleSnapshotRequest(playerId: string): void {
    const players: SnapshotPlayer[] = [];
    for (const [, p] of this.playerManager.getAllPlayers()) {
      players.push({
        id: p.id,
        internalId: p.internalId,
        position: { ...p.position },
        rotation: { ...p.rotation },
        velocity: { ...p.velocity },
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

    // Log full state for desync debugging
    const stateStr = players.map(p =>
      `${p.id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(2)},${p.position.y.toFixed(2)},${p.position.z.toFixed(2)})`
    ).join(' | ');
    const hashInput = players.map(p =>
      `${p.id}:${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}:${p.health}:${p.isDead ? 1 : 0}`
    ).join('|');
    logger.debug(`Snapshot requested by ${playerId} | Server state: ${stateStr} | Hash input: ${hashInput}`);
  }

  /** Room teardown — the combat funnel owns the pending timers. */
  dispose(): void {
    this.combat.dispose();
  }
}
