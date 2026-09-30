import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3, PlayerState } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler } from './CombatHandler.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { CLIENT_STATUS_MASK } from '../../shared/status.ts';
import { CONFIG } from './config.ts';
import { pushRewindSample } from './rewind.ts';
import type { BallSim } from './BallSim.ts';
import type { CreatureSim } from './CreatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import type { PickupKind } from '../../shared/pickups.ts';

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
  winAt?: number;
  /** Objective anchors from the map spec — echoed on gameState so clients
   *  place flags/bases where the map says, not where the URL guessed. */
  bases?: { alpha?: { x: number; y: number; z: number }; bravo?: { x: number; y: number; z: number } };
  /** Static structures from the map spec — echoed on gameState so every
   *  client builds the same base compounds/cover. */
  structures?: { kind: 'box' | 'wall' | 'pillar' | 'ramp'; pos: { x: number; y: number; z: number }; size: { x: number; y: number; z: number }; rotY?: number; team?: 'alpha' | 'bravo' }[];
  /** Arena dome from the map spec — center {x,z} + radius. */
  arena?: { x: number; z: number; radius: number };
  /** Ambient species population overrides from the map spec. */
  ambient?: Record<string, number>;
  /** Heightfield file (maps/<name>.bin) — echoed on gameState so clients
   *  fetch the identical terrain the server's sims run on. */
  terrain?: string;
  /** Any kill — Room drops carried flags here. */
  onKill?: (targetId: string, shooterId: string) => void;
  /** Any damage event — Room flinches bot brains here. */
  onHit?: (targetId: string, shooterId: string) => void;
  /** FFA scoreboard supplier for gameState joins — Room.ffaScores. */
  ffaScores?: () => Record<string, number>;
  /** Flag snapshot supplier for gameState joins — RoomFlags.snapshot. */
  flags?: () => { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[];
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
  moveResync?: (playerId: string, pos: Vec3, yaw: number, fullEnergy?: boolean) => void;
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
  /** Live deployables for gameState joins — RoomDeployables.snapshot. */
  deployables?: () => { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: Vec3; hp?: number; armor?: number }[];
}

export class MessageHandler {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private broadcast: BroadcastFn;
  private sendToPlayer: SendToPlayerFn;
  // Everything that deals damage — projectiles, blasts, env damage, respawns
  private combat: CombatHandler;
  // Server-owned creatures (balls). Optional — a missing/unloadable
  // heightmap must not take down the whole game server.
  private ballSim: BallSim | null = null;
  // Server-owned melee species (crawlers) — same pattern as ballSim.
  private creatureSim: CreatureSim | null = null;
  private rateLimitWarnings: Map<string, number> = new Map();
  private readonly RATE_WARN_COOLDOWN_MS = 5000;

  private roomInfo: RoomInfo = { room: 'default', mode: '' };

  private hb(key: string, n = 1): void {
    const h = this.roomInfo.health;
    if (h) h.set(key, (h.get(key) ?? 0) + n);
  }
  private hbMax(key: string, v: number): void {
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
    this.combat = new CombatHandler(playerManager, broadcast, sendToPlayer, {
      onKill: roomInfo?.onKill,
      onHit: roomInfo?.onHit,
      teams: roomInfo?.teams,
      moveImpulse: roomInfo?.moveImpulse,
      moveResync: roomInfo?.moveResync,
      mode: roomInfo?.mode,
      deployBlast: roomInfo?.deployBlast,
      health: roomInfo?.health,
      envRange: roomInfo?.envRange,
      creatureArmor: roomInfo?.creatureArmor,
    });
    this.attachStructures(roomInfo?.structures);

    // Per-type dispatch — a new message type is one table entry. Field
    // order: handlers need this.combat, so the table is built last.
    this.handlers = {
      position: (id, m) => this.handlePosition(id, m as Extract<ClientMessage, { type: 'position' }>),
      teleport: (id, m) => this.handleTeleport(id, m as Extract<ClientMessage, { type: 'teleport' }>),
      shot: (id, m) => this.combat.handleShot(id, m as Extract<ClientMessage, { type: 'shot' }>),
      aoeShot: (id, m) => this.combat.handleAOEShot(id, m as Extract<ClientMessage, { type: 'aoeShot' }>),
      shotFired: (id, m) => this.combat.handleShotFired(id, m as Extract<ClientMessage, { type: 'shotFired' }>),
      jump: (id, m) => this.relayPresenceEvent(id, m as Extract<ClientMessage, { type: 'jump' }>),
      jetpack: (id, m) => this.relayPresenceEvent(id, m as Extract<ClientMessage, { type: 'jetpack' }>),
      projectileDestroy: (id, m) => this.combat.handleProjectileDestroy(id, m as Extract<ClientMessage, { type: 'projectileDestroy' }>),
      environmentDamage: (id, m) => this.combat.handleEnvironmentDamage(id, m as Extract<ClientMessage, { type: 'environmentDamage' }>),
      heal: (id, m) => this.combat.handleHeal(id, m as Extract<ClientMessage, { type: 'heal' }>),
      deploy: (id, m) => this.roomInfo.onDeploy?.(id, (m as Extract<ClientMessage, { type: 'deploy' }>).kind, (m as Extract<ClientMessage, { type: 'deploy' }>).position),
      repair: (id, m) => this.roomInfo.onRepair?.(id, (m as Extract<ClientMessage, { type: 'repair' }>).targetId),
      creatureHit: (id, m) => {
        const h = m as Extract<ClientMessage, { type: 'creatureHit' }>;
        this.ballSim?.handleHit(id, h.id, h.damage, h.kx, h.ky, h.kz);
      },
      crawlerHit: (id, m) => {
        const h = m as Extract<ClientMessage, { type: 'crawlerHit' }>;
        this.creatureSim?.handleHit(id, h.id, h.damage);
      },
      inputMove: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p || p.isDead) return;
        const msg = m as Extract<ClientMessage, { type: 'inputMove' }>;
        const i = msg.input;
        // Stale input events (reordered datagrams) must not touch skiing/
        // status either — the sim's seq gate decides before we commit.
        const newStatus = (i.status ?? 0) & CLIENT_STATUS_MASK;
        if (this.roomInfo.moveInput?.(id, i, newStatus, msg.seq) === false) return;
        p.skiing = i.ski ? 1 : 0;
        p.status = newStatus;
      },
      // Room-scoped relay — broadcast() only reaches this room's sockets.
      chat: (id, m) => {
        const msg = m as Extract<ClientMessage, { type: 'chat' }>;
        const sender = this.playerManager.getPlayer(id);
        // Truncate — the relay is the broadcast ceiling too, so an
        // oversized payload would amplify one client's bandwidth into
        // every socket in the room.
        const text = typeof msg.text === 'string' ? msg.text.slice(0, 280) : '';
        if (!text) return;
        // Team channel: only the sender's own team hears it — and only
        // when the sender actually carries a team, else a ffa client
        // claiming 'team' would quietly self-filter to nobody.
        if (msg.team && sender?.team) {
          for (const [pid, p] of this.playerManager.getAllPlayers()) {
            if (p.team === sender.team) this.sendToPlayer(pid, { type: 'chat', playerId: id, text, team: true });
          }
          return;
        }
        this.broadcast({ type: 'chat', playerId: id, text });
      },
      ping: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p) return;
        p.lastSeen = Date.now(); // ping is a liveness signal too —
        // without it a non-moving client could still go "stale"
        this.sendToPlayer(id, { type: 'pong', timestamp: (m as Extract<ClientMessage, { type: 'ping' }>).timestamp });
      },
      snapshotRequest: (id) => { this.hb('snapreq'); this.handleSnapshotRequest(id); },
      // Tribes rule: the tier swap banks on the next respawn — applying
      // it mid-life would be a free heal and flip the sim's speed scale
      // without the shadow knowing.
      classUpdate: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (p) p.pendingClass = (m as Extract<ClientMessage, { type: 'classUpdate' }>).armorClass as 'light' | 'medium' | 'heavy';
      },
      perkUpdate: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (p) p.pendingPerk = (m as Extract<ClientMessage, { type: 'perkUpdate' }>).perk;
      },
    };
  }

  private handlers: Record<string, (playerId: string, msg: ClientMessage) => void> = {};

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
  setMap(
    bases: RoomInfo['bases'],
    structures: RoomInfo['structures'],
    arena: RoomInfo['arena'],
    ambient?: RoomInfo['ambient'],
    terrain?: RoomInfo['terrain'],
  ): void {
    this.roomInfo.bases = bases;
    this.roomInfo.structures = structures;
    this.roomInfo.arena = arena;
    this.roomInfo.ambient = ambient;
    this.roomInfo.terrain = terrain;
    this.attachStructures(structures);
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
  botAttack(shooterId: string, targetId: string, weaponType: number): void {
    this.combat.botAttack(shooterId, targetId, weaponType);
  }

  /** Drop per-player bookkeeping when a socket closes (grace-period cleanup
   *  leaves PlayerManager state alive, but rate-limit warn state is per-connection) */
  onPlayerDisconnected(playerId: string): void {
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) this.rateLimitWarnings.delete(key);
    }
    this.combat.onPlayerDisconnected(playerId);
    this.roomInfo.moveUntrack?.(playerId);
    this.lastTeleport.delete(playerId);
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
    this.lastTeleport.delete(playerId);
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
        ? { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena, ambient: this.roomInfo.ambient, terrain: this.roomInfo.terrain }
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

    // Creature roster — joiner/reconnect replays the live ball set from
    // these segment snapshots; anything spawned after is a ballSpawn event.
    if (this.ballSim) {
      this.sendToPlayer(playerId, { type: 'ballRoster', balls: this.ballSim.roster() });
    }
    if (this.creatureSim) {
      this.sendToPlayer(playerId, { type: 'crawlRoster', crawlers: this.creatureSim.roster() });
    }

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

  /** Broadcast the playerJoined announce once — gates on the flag so a
   *  player reports for a while, then a second path can't re-announce. */
  private announceIfInWorld(player: PlayerState): void {
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

    const handler = this.handlers[msg.type];
    if (!handler) {
      this.hb('unhandled');
      logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
      return;
    }
    handler(playerId, msg);
  }

  private handlePosition(playerId: string, msg: Extract<ClientMessage, { type: 'position' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;

    const now = Date.now();
    if (!this.plausible(playerId, player, msg, now)) return;

    // inputSeq (not the frame seq) anchors the probe: it's the count of
    // inputMove events the client had consumed when it took this snapshot.
    const simTruth = this.roomInfo.moveReport?.(playerId, msg.position, msg.rotation.yaw, msg.velocity, msg.inputSeq);

    if (this.roomInfo.moveAuthority?.()) {
      // Authority mode: the sim owns position — the report only feeds it
      // yaw/vel hints and carries ping + liveness. Corrections still flow
      // on divergence (tighter tolerance/throttle inside the sim).
      if (simTruth) {
        this.sendToPlayer(playerId, {
          type: 'correction',
          seq: msg.seq ?? 0,
          inputSeq: simTruth.inputSeq,
          grounded: simTruth.onGround,
          position: simTruth.pos,
          velocity: simTruth.vel,
          rotation: msg.rotation,
        });
        // Reseat the plausibility anchor at the corrected position: the
        // client's next report legitimately snaps to simTruth.pos, and
        // without this the snap itself reads as a speedhack reject.
        player.lastPosCheckPos = { ...simTruth.pos };
        this.muteJudges(player, playerId, now);
      }
      player.rotation = { ...msg.rotation };
      player.lastSeen = now;
      if (msg.seq !== undefined && msg.seq > player.lastSeq) player.lastSeq = msg.seq;
      player.hasReceivedPosition = true;
      this.announceIfInWorld(player);
      if (msg.ping !== undefined) player.ping = Math.max(1, msg.ping);
      pushRewindSample(player, now); // player.position is sim truth
      return;
    }

    // Judge mode: divergence is an anti-cheat SIGNAL, never a correction.
    // The shadow sim replays snapshot inputs at fixed ticks while the
    // client integrates per-frame — honest play drifts past tolerance
    // routinely, and snapping the client on sim drift IS the warp
    // players feel. reconcile() still counts divergences for kicks;
    // the client's own report stays truth (as updatePosition applies).
    this.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity, msg.seq);
    player.hasReceivedPosition = true;
    this.announceIfInWorld(player);
    if (msg.ping !== undefined) player.ping = Math.max(1, msg.ping);
    pushRewindSample(player, now);
    // Don't broadcast immediately — batched in tickUpdate
  }

  /** Cheat prevention: position plausibility. Compares CONSECUTIVE reports
   *  (lastPosCheck* updates even on reject), so a rejected position
   *  doesn't poison every subsequent check — the old version measured
   *  each new report against a stale accepted pos, spiralling into
   *  permanent rejection once a player got >threshold away.
   *  Returns false when the report is rejected (still counting up the
   *  force-accept streak); true accepts, including the >10 force-accept
   *  resync for a client persisting past corrections. */
  private plausible(playerId: string, player: PlayerState, msg: Extract<ClientMessage, { type: 'position' }>, now: number): boolean {
    const dt = Math.max((now - player.lastPosCheckTime) / 1000, 0.05); // floor: bursts of queued packets report ~1ms gaps
    player.lastPosCheckTime = now;
    if (!player.hasReceivedPosition || !player.lastPosCheckPos) {
      player.lastPosCheckPos = { ...msg.position };
      return true;
    }
    const dx = msg.position.x - player.lastPosCheckPos.x;
    const dy = msg.position.y - player.lastPosCheckPos.y;
    const dz = msg.position.z - player.lastPosCheckPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const speed = dist / dt;
    player.lastPosCheckPos = { ...msg.position };
    // Reject only genuine impossibilities: >50m in one report, or speed
    // beyond any legit combination of skiing + knockback + jetpack.
    // The window has to be a REAL window — position reports stream at
    // 20Hz, so dt > ~0.5s means the report chain broke (transport blip,
    // hidden tab, transport switch), and the accumulated distance over
    // a dead interval isn't speed evidence (34s gap → 589m at 17m/s
    // used to reject). Reseat the anchor and resume measuring.
    // A correction we just sent snaps the client's reports onto sim
    // truth — but reports emitted before the packet landed still come
    // from the old trajectory and would all read as impossible speed.
    // Mute the check while those in-flight reports drain (grace covers
    // ~2 RTTs of stragglers).
    if (now < player.correctionGraceUntil || dt > 0.5 || (dist <= 50 && speed <= 300)) {
      player.consecutiveRejects = 0;
      return true;
    }
    player.consecutiveRejects++;
    this.hb('posrej');
    this.hbMax('posrejSpeed', speed);
    logger.warn(`Position rejected: ${playerId} moved ${dist.toFixed(1)}m in ${dt.toFixed(3)}s (${speed.toFixed(0)} m/s)`);
    // Send correction on the first reject of a streak only — no flood
    if (player.consecutiveRejects === 1) {
      const validState = this.playerManager.getLastValidState(playerId);
      if (validState) {
        this.sendToPlayer(playerId, {
          type: 'correction',
          seq: validState.seq,
          position: validState.position,
          velocity: validState.velocity,
          rotation: validState.rotation,
        });
        // COMMIT the anchor: reseat the check point AT the corrected
        // position. We just told the client to teleport there — its
        // post-snap report legitimately sits ~far from the rejected
        // pos we recorded above, and without this reseat it is
        // guaranteed-rejected, accumulates to the >10 force-accept,
        // flips lastValid to the far anchor, and the next correction
        // snaps the client BACK — the infinite ping-pong. One anchor,
        // one commit: either the client lands at the correction
        // (accepts immediately) or keeps fighting (rejects count up
        // to the force-accept, which then sticks).
        player.lastPosCheckPos = { ...validState.position };
        this.muteJudges(player, playerId, now);
      }
    }
    // Client persisting past corrections (disputed knockback, lost
    // correction packet): force-accept after 10 rejects to resync
    // instead of warping the player forever.
    if (player.consecutiveRejects <= 10) return false;
    this.hb('posforce');
    logger.warn(`Position force-accepted: ${playerId} after ${player.consecutiveRejects} rejects (resync)`);
    player.consecutiveRejects = 0;
    return true;
  }

  // Declared discontinuity (warp beacon, respawn): position arrives
  // pre-accepted — reseat the plausibility anchor so the NEXT report
  // deltas from here instead of measuring a 50m jump as a speedhack.
  /** Declared-warp cadence — TL beacons are ≥4s apart (TL_COOLDOWN),
   *  joins/respawns are one-offs, so 3s leaves every legal warp free
   *  while a teleport-spam client eats plausibility corrections instead
   *  of free relocation. */
  private lastTeleport = new Map<string, number>();

  private handleTeleport(playerId: string, msg: Extract<ClientMessage, { type: 'teleport' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const now = Date.now();
    if ((this.lastTeleport.get(playerId) ?? 0) > now) {
      logger.warn('teleport dropped: cadence', { playerId });
      return;
    }
    this.lastTeleport.set(playerId, now + 3000);
    player.lastPosCheckPos = { ...msg.position };
    player.lastPosCheckTime = Date.now();
    player.consecutiveRejects = 0;
    this.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity, undefined);
    // updatePosition only touches lastValid on a seq bump — a declared
    // teleport has no seq, so seat it manually or the next correction
    // would snap the player back to BEFORE the warp
    player.lastValidPosition = { ...msg.position };
    player.lastValidVelocity = { ...msg.velocity };
    player.lastValidRotation = { ...msg.rotation };
    player.hasReceivedPosition = true;
    this.announceIfInWorld(player);
    this.roomInfo.moveResync?.(playerId, msg.position, msg.rotation.yaw);
    // Reports already in flight predate the warp — same drain window
    // corrections and respawns get.
    this.muteJudges(player, playerId, now);
    // Pre-warp samples are a different location entirely — keeping them
    // lets lag-comp rewind land the shooter/target back at the corpse.
    player.history.length = 0;
    pushRewindSample(player, now);
    // Relay so observers snap instead of interpolating across the gap
    this.broadcast({ type: 'teleport', playerId, position: msg.position, velocity: msg.velocity }, playerId);
  }

  /** Every re-seat (correction out, respawn, room hop, teleport) must
   *  mute BOTH judges for the drain window: plausibility via the grace
   *  timestamp, the shadow sim via moveMute/markReseated — in-flight
   *  pre-warp reports otherwise read as speedhacks on one judge or
   *  divergences on the other. */
  private muteJudges(player: PlayerState, playerId: string, now: number): void {
    player.correctionGraceUntil = now + CONFIG.reportGraceMs;
    this.roomInfo.moveMute?.(playerId);
  }

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
