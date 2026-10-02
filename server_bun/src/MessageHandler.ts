import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3, PlayerState } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler, type CombatDeps } from './CombatHandler.ts';
import type { KillFeed } from './killFeed.ts';
import type { InfluenceMap } from './influenceMap.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { CONFIG } from './config.ts';
import { MoveClaims } from './moveClaims.ts';
import type { BallSim } from './BallSim.ts';
import type { CreatureSim } from './CreatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import type { PickupKind } from '../../shared/pickups.ts';
import { isPerkId } from '../../shared/perks.ts';
import { CLASS_STATS } from '../../shared/botClasses.ts';
import type { ArmorClass } from '../../shared/botClasses.ts';
import type { TeamId } from '../../shared/teams.ts';

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
  structures?: { kind: 'box' | 'wall' | 'pillar' | 'ramp'; pos: { x: number; y: number; z: number }; size: { x: number; y: number; z: number }; rotY?: number; team?: TeamId }[];
  /** Arena dome from the map spec — center {x,z} + radius. */
  arena?: { x: number; z: number; radius: number };
  /** Ambient species population overrides from the map spec. */
  ambient?: Record<string, number>;
  /** Heightfield file (maps/<name>.bin) — echoed on gameState so clients
   *  fetch the identical terrain the server's sims run on. */
  terrain?: string;
  /** Baked terrain albedo + skybox dir — client dressing only. */
  terrainTex?: string;
  sky?: string;
  /** Interior placements (T2 .dif→.glb buildings) — client dressing only. */
  interiors?: { file: string; pos: { x: number; y: number; z: number }; rot?: number[]; scale?: { x: number; y: number; z: number } }[];
  /** Any kill — Room drops carried flags here. */
  onKill?: (targetId: string, shooterId: string) => void;
  /** Any damage event — Room flinches bot brains here. */
  onHit?: (targetId: string, shooterId: string) => void;
  /** Seeded room rng — scenario harnesses inject it so claim-path dice
   *  (bomblet scatter) replay identically under a seed. */
  rng?: () => number;
  /** FFA scoreboard supplier for gameState joins — Room.ffaScores. */
  ffaScores?: () => Record<string, number>;
  /** Flag snapshot supplier for gameState joins — RoomFlags.snapshot. */
  flags?: () => { team: TeamId; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[];
  /** Live pickups for gameState joins — RoomPickups.snapshot. */
  pickups?: () => { id: number; pos: Vec3; kind: PickupKind }[];
  /** Match-clock deadline (epoch ms) for gameState joins — Room.matchEndsAt.
   *  0 means "not armed yet" (no humans have joined). */
  matchEndsAt?: () => number;
  /** Deploy claim sink — Room.deployables.handleDeploy. */
  onDeploy?: (playerId: string, kind: string, pos: Vec3) => void;
  /** Repair-beam claim sink — Room.deployables.repair. */
  onRepair?: (playerId: string, targetId: number) => void;
  /** AOE blast sink for deployables — Room.deployables.applyBlast. */
  deployBlast?: (pos: Vec3, damage: number, radius: number, shooterId: string) => void;
  pickupsKnock?: (at: Vec3, radius: number, force: number) => void;
  preySplash?: (ownerId: string, pos: Vec3, radius: number, maxDamage: number) => void;
  influence?: InfluenceMap;
  /** Instant-skill claim sink — Room.moveSim.drainEnergy(ENERGY.skillCost). */
  onSkillUse?: (playerId: string) => void;
  /** Shadow-move hooks — Room.moveSim. Position reports reconcile the
   *  sim; teleport/respawn resync it; inputMove feeds it. */
  /** Returns false when the event is stale (seq regression on an
   *  unordered transport) — the handler then skips its side effects. */
  moveInput?: (playerId: string, input: { forward: number; right: number; jump: number; ski: number; jet?: number }, status?: number, seq?: number) => boolean | void;
  /** Reports reconcile the sim; a non-null return is the sim's truth when
   *  the report diverged past tolerance — send it back as a correction. */
  moveReport?: (playerId: string, pos: Vec3, yaw: number, vel?: Vec3, inputSeq?: number) => { pos: Vec3; vel: Vec3; inputSeq: number; onGround: boolean } | null;
  /** Server-side impulses (knockback) the sim must also receive. */
  moveImpulse?: (playerId: string, dv: Vec3) => void;
  dropFlagCarrier?: (playerId: string) => void;
  /** Jet-tank access for heal-beam ammo — energy is server truth. */
  drainEnergy?: (playerId: string, amount: number) => void;
  energyOf?: (playerId: string) => number | null;
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
  /** Bot chat landed — Room relays it as a 'reply' notice to the squad. */
  onBotSpoke?: (id: string) => void;
  /** A player typed in chat — Room keyword-matches it into a bot notice
   *  (gg → 'gg', ez → 'salty', bot-name mention → 'mention'). */
  onChat?: (id: string, text: string) => void;
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
  /** Armor-grenade plating sweep — BallSim.armorBlast + CreatureSim.armorBlast. */
  creatureArmor?: (pos: Vec3, amount: number, radius: number) => void;
  /** A legit fire claim passed the gates — the sheep meter's human
   *  ignore debit reads its recency (bots report via BrainOut.fire). */
  onFire?: (playerId: string) => void;
  /** Live deployables for gameState joins — RoomDeployables.snapshot. */
  deployables?: () => { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone' | 'shield'; pos: Vec3; hp?: number; armor?: number; team?: string }[];
}

/** RoomInfo → CombatDeps projection — kept out of the constructor so the
 *  handler table stays the ctor's readable half. */
function combatDeps(roomInfo: RoomInfo | undefined): CombatDeps {
  return {
    onKill: roomInfo?.onKill,
    onHit: roomInfo?.onHit,
    rng: roomInfo?.rng,
    teams: roomInfo?.teams,
    friendlyFire: roomInfo?.friendlyFire,
    moveImpulse: roomInfo?.moveImpulse,
    dropFlagCarrier: roomInfo?.dropFlagCarrier,
    drainEnergy: roomInfo?.drainEnergy,
    energyOf: roomInfo?.energyOf,
    moveResync: roomInfo?.moveResync,
    onBotSpoke: roomInfo?.onBotSpoke,
    mode: roomInfo?.mode,
    deployBlast: roomInfo?.deployBlast,
    pickupsKnock: roomInfo?.pickupsKnock,
    preySplash: roomInfo?.preySplash,
    influence: roomInfo?.influence,
    health: roomInfo?.health,
    envRange: roomInfo?.envRange,
    creatureArmor: roomInfo?.creatureArmor,
    onFire: roomInfo?.onFire,
  };
}

export class MessageHandler {
  // Public fields/methods are the MoveClaims host surface (moveClaims.ts)
  // — the position/teleport plausibility funnel lives there.
  playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  broadcast: BroadcastFn;
  sendToPlayer: SendToPlayerFn;
  private moves: MoveClaims;
  // Everything that deals damage — projectiles, blasts, env damage, respawns
  private combat: CombatHandler;
  /** Room/flag code reads killFeed for situation chatter (bot 'say' events). */
  get killFeed(): KillFeed { return this.combat.killFeed; }
  /** Fast-forward driver seam: lapses sim-timed respawn deadlines when
   *  sim-time outruns wall time. Live rooms never call it — the wall
   *  timers fire first there, so this is a no-op shadow. */
  respawnTick(now: number): void { this.combat.respawner.tick(now); }
  // Server-owned creatures (balls). Optional — a missing/unloadable
  // heightmap must not take down the whole game server.
  private ballSim: BallSim | null = null;
  // Server-owned melee species (crawlers) — same pattern as ballSim.
  private creatureSim: CreatureSim | null = null;
  private rateLimitWarnings: Map<string, number> = new Map();
  private readonly RATE_WARN_COOLDOWN_MS = 5000;

  private roomInfo: RoomInfo = { room: 'default', mode: '' };

  hb(key: string, n = 1): void {
    const h = this.roomInfo.health;
    if (h) h.set(key, (h.get(key) ?? 0) + n);
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

    // Per-type dispatch — a new message type is one table entry. Field
    // order: handlers need this.combat, so the table is built last.
    // The mapped type narrows `m` per key, so entries never cast — and a
    // ClientMessage type with no entry is a table the compiler can see.
    this.handlers = {
      position: (id, m) => this.moves.handlePosition(id, m),
      teleport: (id, m) => this.moves.handleTeleport(id, m),
      shot: (id, m) => this.combat.handleShot(id, m),
      aoeShot: (id, m) => this.combat.handleAOEShot(id, m),
      shotFired: (id, m) => this.combat.handleShotFired(id, m),
      jump: (id, m) => this.relayPresenceEvent(id, m),
      jetpack: (id, m) => this.relayPresenceEvent(id, m),
      projectileDestroy: (id, m) => this.combat.handleProjectileDestroy(id, m),
      environmentDamage: (id, m) => this.combat.handleEnvironmentDamage(id, m),
      heal: (id, m) => this.combat.handleHeal(id, m),
      deploy: (id, m) => this.roomInfo.onDeploy?.(id, m.kind, m.position),
      repair: (id, m) => this.roomInfo.onRepair?.(id, m.targetId),
      skillUse: (id) => this.roomInfo.onSkillUse?.(id),
      creatureHit: (id, m) => {
        this.ballSim?.handleHit(id, m.id, m.damage, m.kx, m.ky, m.kz);
      },
      crawlerHit: (id, m) => {
        this.creatureSim?.handleHit(id, m.id, m.damage);
      },
      inputMove: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p || p.isDead) return;
        const i = m.input;
        // Stale input events (reordered datagrams) must not touch skiing/
        // status either — the sim's seq gate decides before we commit.
        const newStatus = (i.status ?? 0) & CLIENT_STATUS_MASK;
        if (this.roomInfo.moveInput?.(id, i, newStatus, m.seq) === false) return;
        p.skiing = i.ski ? 1 : 0;
        p.status = newStatus;
      },
      // Room-scoped relay — broadcast() only reaches this room's sockets.
      chat: (id, m) => {
        const sender = this.playerManager.getPlayer(id);
        // Truncate — the relay is the broadcast ceiling too, so an
        // oversized payload would amplify one client's bandwidth into
        // every socket in the room.
        const text = typeof m.text === 'string' ? m.text.slice(0, 280) : '';
        if (!text) return;
        // Team channel: only the sender's own team hears it — and only
        // when the sender actually carries a team, else a ffa client
        // claiming 'team' would quietly self-filter to nobody.
        const vgs = typeof m.vgs === 'string' ? m.vgs : undefined;
        if (m.team && sender?.team) {
          for (const [pid, p] of this.playerManager.getAllPlayers()) {
            if (p.team === sender.team) this.sendToPlayer(pid, { type: 'chat', playerId: id, text, team: true, vgs });
          }
          return;
        }
        this.broadcast({ type: 'chat', playerId: id, text, vgs });
        // Bots can read: the relay above ships the line, this lets the
        // room turn high-confidence phrases (gg, ez, a bot's name) into
        // a squad notice — whether anyone answers is still dice+cooldown.
        this.roomInfo.onChat?.(id, text);
      },
      ping: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p) return;
        p.lastSeen = Date.now(); // ping is a liveness signal too —
        // without it a non-moving client could still go "stale"
        this.sendToPlayer(id, { type: 'pong', timestamp: m.timestamp });
      },
      snapshotRequest: (id) => { this.hb('snapreq'); this.handleSnapshotRequest(id); },
      resync: (id) => { this.hb('resync'); this.sendWorldState(id); },
      // Tribes rule: the tier swap banks on the next respawn — applying
      // it mid-life would be a free heal and flip the sim's speed scale
      // without the shadow knowing.
      classUpdate: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        // A cast here isn't a check — an off-table class hits
        // CLASS_STATS[garbage].maxHealth at respawn and throws.
        const cls = m.armorClass;
        if (p && typeof cls === 'string' && cls in CLASS_STATS) p.pendingClass = cls as ArmorClass;
      },
      perkUpdate: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (p && isPerkId(m.perk)) p.pendingPerk = m.perk;
      },
    };
  }

  private handlers: { [K in ClientMessage['type']]?: (playerId: string, msg: Extract<ClientMessage, { type: K }>) => void } = {};

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
  setMap(m: Pick<RoomInfo, 'bases' | 'structures' | 'arena' | 'ambient' | 'terrain' | 'terrainTex' | 'sky' | 'interiors'>): void {
    // Explicit field writes (not Object.assign): a spec that omits a
    // field must clear it, not leave the previous map's value behind.
    this.roomInfo.bases = m.bases;
    this.roomInfo.structures = m.structures;
    this.roomInfo.arena = m.arena;
    this.roomInfo.ambient = m.ambient;
    this.roomInfo.terrain = m.terrain;
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
      projectileId: `bot-${shooterId}-${Date.now()}`,
      ownerId: shooterId,
      position,
      velocity,
      weaponType,
    });
    if (hit && targetId) this.combat.botAttack(shooterId, targetId, weaponType);
  }

  /** Server-simulated projectile blast (bot rockets etc.) — combat's
   *  trusted AOE path; the sim placed the pop, no cheat check needed. */
  serverBlast(ownerId: string, pos: Vec3, weaponType: number, excludeTargetId: string | null): void {
    this.combat.serverBlast(ownerId, pos, weaponType, excludeTargetId);
  }

  /** Server-simulated direct hit — the room's projectile sim resolved the
   *  contact; combat applies damage through the same funnel as botFire. */
  botAttack(shooterId: string, targetId: string, weaponType: number, airtime?: number): void {
    this.combat.botAttack(shooterId, targetId, weaponType, airtime);
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
      scores: this.roomInfo.scores ? { ...this.roomInfo.scores } : undefined,
      ffaScores: this.roomInfo.ffaScores?.(),
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena || this.roomInfo.terrain
        ? (() => { const m = { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena, ambient: this.roomInfo.ambient, terrain: this.roomInfo.terrain, terrainTex: this.roomInfo.terrainTex, sky: this.roomInfo.sky, interiors: this.roomInfo.interiors };
          logger.warn(`roomEcho map keys: ${Object.keys(m).join(',')} interiors=${m.interiors?.length}`); return m; })()
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
  private sendWorldState(playerId: string, sessionToken?: string): void {
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

    // Creature roster — joiner/resync replays the live ball set from
    // these segment snapshots; anything spawned after is a ballSpawn event.
    if (this.ballSim) {
      this.sendToPlayer(playerId, { type: 'ballRoster', balls: this.ballSim.roster() });
    }
    if (this.creatureSim) {
      this.sendToPlayer(playerId, { type: 'crawlRoster', crawlers: this.creatureSim.roster() });
    }
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
      internalId: player.internalId,
      position: player.position,
      rotation: player.rotation,
      team: player.team,
      transport: player.transport,
      armorClass: player.armorClass,
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
    if (this.ballSim) {
      this.sendToPlayer(playerId, { type: 'ballRoster', balls: this.ballSim.roster() });
    }
    if (this.creatureSim) {
      this.sendToPlayer(playerId, { type: 'crawlRoster', crawlers: this.creatureSim.roster() });
    }
  }

  handleMessage(playerId: string, msg: ClientMessage): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    if (!this.rateLimiter.check(playerId, msg.type)) {
      const warnKey = `${playerId}:${msg.type}`;
      const now = Date.now();
      const lastWarn = this.rateLimitWarnings.get(warnKey);
      this.hb('ratelimit');
      if (!lastWarn || now - lastWarn > this.RATE_WARN_COOLDOWN_MS) {
        this.rateLimitWarnings.set(warnKey, now);
        logger.warn(`Rate limit exceeded`, { playerId, messageType: msg.type });
      }
      return;
    }

    // Indexed access widens to the union of all handler signatures —
    // the per-key narrowing already happened in the table, so one cast
    // here replaces one per entry.
    const handler = this.handlers[msg.type] as ((id: string, m: ClientMessage) => void) | undefined;
    if (!handler) {
      this.hb('unhandled');
      logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
      return;
    }
    handler(playerId, msg);
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
  private relayPresenceEvent(playerId: string, msg: Extract<ClientMessage, { type: 'jump' | 'jetpack' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.broadcast({ type: msg.type, playerId, position: msg.position }, playerId);
  }

  private handleSnapshotRequest(playerId: string): void {
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
      timestamp: Date.now(),
    });

    // Log full state for desync debugging
    const stateStr = players.map(p =>
      `${p.id}[${p.kills}/${p.deaths}] ${p.isDead ? 'DEAD' : `HP${p.health}`} @(${p.position.x.toFixed(2)},${p.position.y.toFixed(2)},${p.position.z.toFixed(2)})`
    ).join(' | ');
    const hashInput = players.map(p =>
      `${p.id}:${Math.round(p.position.x)},${Math.round(p.position.y)},${Math.round(p.position.z)}:${p.health}:${p.isDead ? 1 : 0}`
    ).join('|');
    logger.info(`Snapshot requested by ${playerId} | Server state: ${stateStr} | Hash input: ${hashInput}`);
  }

  /** Room teardown — the combat funnel owns the pending timers. */
  dispose(): void {
    this.combat.dispose();
  }
}
