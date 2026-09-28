import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3 } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler } from './CombatHandler.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
import { STATUS_MASK } from '../../shared/status.ts';
import type { BallSim } from './BallSim.ts';

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
  /** Any kill — Room drops carried flags here. */
  onKill?: (targetId: string, shooterId: string) => void;
  /** Any damage event — Room flinches bot brains here. */
  onHit?: (targetId: string, shooterId: string) => void;
  /** FFA scoreboard supplier for gameState joins — Room.ffaScores. */
  ffaScores?: () => Record<string, number>;
  /** Flag snapshot supplier for gameState joins — RoomFlags.snapshot. */
  flags?: () => { team: 'alpha' | 'bravo'; pos: Vec3; state: 'home' | 'carried' | 'dropped'; carrier: string | null }[];
  /** Live pickups for gameState joins — RoomPickups.snapshot. */
  pickups?: () => { id: number; pos: Vec3; kind: 'gem' | 'tag' }[];
  /** Match-clock deadline (epoch ms) for gameState joins — Room.matchEndsAt.
   *  0 means "not armed yet" (no humans have joined). */
  matchEndsAt?: () => number;
  /** Deploy claim sink — Room.deployables.handleDeploy. */
  onDeploy?: (playerId: string, kind: string, pos: Vec3) => void;
  /** Live deployables for gameState joins — RoomDeployables.snapshot. */
  deployables?: () => { id: number; owner: string; kind: 'turret' | 'mine' | 'station' | 'drone'; pos: Vec3 }[];
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
  private rateLimitWarnings: Map<string, number> = new Map();
  private readonly RATE_WARN_COOLDOWN_MS = 5000;

  private roomInfo: RoomInfo = { room: 'default', mode: '' };

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
    this.combat = new CombatHandler(playerManager, broadcast, sendToPlayer, roomInfo?.onKill, roomInfo?.onHit, roomInfo?.teams ?? false);

    // Per-type dispatch — a new message type is one table entry. Field
    // order: handlers need this.combat, so the table is built last.
    this.handlers = {
      position: (id, m) => this.handlePosition(id, m as Extract<ClientMessage, { type: 'position' }>),
      teleport: (id, m) => this.handleTeleport(id, m as Extract<ClientMessage, { type: 'teleport' }>),
      shot: (id, m) => this.combat.handleShot(id, m as Extract<ClientMessage, { type: 'shot' }>),
      aoeShot: (id, m) => this.combat.handleAOEShot(id, m as Extract<ClientMessage, { type: 'aoeShot' }>),
      jump: (id, m) => this.relayPresenceEvent(id, m as Extract<ClientMessage, { type: 'jump' }>),
      jetpack: (id, m) => this.relayPresenceEvent(id, m as Extract<ClientMessage, { type: 'jetpack' }>),
      projectileDestroy: (id, m) => this.combat.handleProjectileDestroy(id, m as Extract<ClientMessage, { type: 'projectileDestroy' }>),
      environmentDamage: (id, m) => this.combat.handleEnvironmentDamage(id, m as Extract<ClientMessage, { type: 'environmentDamage' }>),
      heal: (id, m) => this.combat.handleHeal(id, m as Extract<ClientMessage, { type: 'heal' }>),
      deploy: (id, m) => this.roomInfo.onDeploy?.(id, (m as Extract<ClientMessage, { type: 'deploy' }>).kind, (m as Extract<ClientMessage, { type: 'deploy' }>).position),
      creatureHit: (id, m) => {
        const h = m as Extract<ClientMessage, { type: 'creatureHit' }>;
        this.ballSim?.handleHit(id, h.id, h.damage, h.kx, h.ky, h.kz);
      },
      inputMove: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p) return;
        const i = (m as Extract<ClientMessage, { type: 'inputMove' }>).input;
        p.skiing = i.ski ? 1 : 0;
        p.status = (i.status ?? 0) & STATUS_MASK;
      },
      // Room-scoped relay — broadcast() only reaches this room's sockets.
      chat: (id, m) => this.broadcast({ type: 'chat', playerId: id, text: (m as Extract<ClientMessage, { type: 'chat' }>).text }),
      ping: (id, m) => {
        const p = this.playerManager.getPlayer(id);
        if (!p) return;
        p.lastSeen = Date.now(); // ping is a liveness signal too —
        // without it a non-moving client could still go "stale"
        this.sendToPlayer(id, { type: 'pong', timestamp: (m as Extract<ClientMessage, { type: 'ping' }>).timestamp });
      },
      snapshotRequest: (id) => this.handleSnapshotRequest(id),
    };
  }

  private handlers: Record<string, (playerId: string, msg: ClientMessage) => void> = {};

  setBallSim(sim: BallSim): void {
    this.ballSim = sim;
  }

  /** Admin hot-reload — re-point the map echo fields so the next gameState
   *  (joiners/spectators) carries the new layout. In-room clients get the
   *  matching `mapUpdate` broadcast from Room.applySpec. */
  setMap(
    bases: RoomInfo['bases'],
    structures: RoomInfo['structures'],
    arena: RoomInfo['arena'],
    ambient?: RoomInfo['ambient'],
  ): void {
    this.roomInfo.bases = bases;
    this.roomInfo.structures = structures;
    this.roomInfo.arena = arena;
    this.roomInfo.ambient = ambient;
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

  /** Drop per-player bookkeeping when a socket closes (grace-period cleanup
   *  leaves PlayerManager state alive, but rate-limit warn state is per-connection) */
  onPlayerDisconnected(playerId: string): void {
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) this.rateLimitWarnings.delete(key);
    }
    this.combat.onPlayerDisconnected(playerId);
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {
    this.combat.onPlayerRemoved(playerId);
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
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena
        ? { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena, ambient: this.roomInfo.ambient }
        : undefined,
      flags: this.roomInfo.flags?.(),
      pickups: this.roomInfo.pickups?.(),
      deployables: this.roomInfo.deployables?.(),
      matchEndsAt: this.roomInfo.matchEndsAt?.() || undefined,
    };
  }

  handleHandshake(playerId: string, sessionToken?: string, isReconnect = false): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    // Reconnecting dead player: the disconnect cancelled their respawn
    // timer — re-arm it or they stay dead for the rest of the session.
    this.combat.ensureRespawnScheduled(playerId);

    const others = this.playerManager.getOtherPlayers(playerId);
    const playersData = others.map((p) => this.playerManager.toGameStatePlayer(p));

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
        isDead: player.isDead,
      },
    });

    // Creature roster — joiner/reconnect replays the live ball set from
    // these segment snapshots; anything spawned after is a ballSpawn event.
    if (this.ballSim) {
      this.sendToPlayer(playerId, { type: 'ballRoster', balls: this.ballSim.roster() });
    }

    // Grace reconnects never emitted a playerLeft — peers still have this
    // player on their roster, so re-announcing playerJoined is pure spam.
    if (!isReconnect) {
      this.broadcast({
        type: 'playerJoined',
        playerId: player.id,
        internalId: player.internalId,
        position: player.position,
        rotation: player.rotation,
        team: player.team,
      }, playerId);
    }
  }

  /** Spectator join — no player record, so everyone is "others", there's
   *  no localPlayerState, and no playerJoined goes out. The socket still
   *  gets every broadcast + tick frame (sent to connections, not players). */
  handleSpectatorHandshake(playerId: string): void {
    const playersData = [...this.playerManager.getAllPlayers().values()]
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
  }

  handleMessage(playerId: string, msg: ClientMessage): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    if (!this.rateLimiter.check(playerId, msg.type)) {
      const warnKey = `${playerId}:${msg.type}`;
      const now = Date.now();
      const lastWarn = this.rateLimitWarnings.get(warnKey);
      if (!lastWarn || now - lastWarn > this.RATE_WARN_COOLDOWN_MS) {
        this.rateLimitWarnings.set(warnKey, now);
        logger.warn(`Rate limit exceeded`, { playerId, messageType: msg.type });
      }
      return;
    }

    const handler = this.handlers[msg.type];
    if (!handler) {
      logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
      return;
    }
    handler(playerId, msg);
  }

  private handlePosition(playerId: string, msg: Extract<ClientMessage, { type: 'position' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;

    // Cheat prevention: position plausibility check.
    // Compares CONSECUTIVE reports (lastPosCheck* updates even on reject),
    // so a rejected position doesn't poison every subsequent check — the
    // old version measured each new report against a stale accepted pos,
    // spiralling into permanent rejection once a player got >threshold away.
    const now = Date.now();
    const dt = Math.max((now - player.lastPosCheckTime) / 1000, 0.05); // floor: bursts of queued packets report ~1ms gaps
    player.lastPosCheckTime = now;
    if (player.hasReceivedPosition && player.lastPosCheckPos) {
      const dx = msg.position.x - player.lastPosCheckPos.x;
      const dy = msg.position.y - player.lastPosCheckPos.y;
      const dz = msg.position.z - player.lastPosCheckPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const speed = dist / dt;
      player.lastPosCheckPos = { ...msg.position };
      // Reject only genuine impossibilities: >50m in one report, or speed
      // beyond any legit combination of skiing + knockback + jetpack
      if (dist > 50 || speed > 300) {
        player.consecutiveRejects++;
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
          }
        }
        // Client persisting past corrections (disputed knockback, lost
        // correction packet): force-accept after 10 rejects to resync
        // instead of warping the player forever.
        if (player.consecutiveRejects > 10) {
          logger.warn(`Position force-accepted: ${playerId} after ${player.consecutiveRejects} rejects (resync)`);
          player.consecutiveRejects = 0;
        } else {
          return;
        }
      } else {
        player.consecutiveRejects = 0;
      }
    } else {
      player.lastPosCheckPos = { ...msg.position };
    }

    this.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity, msg.seq);
    player.hasReceivedPosition = true;
    if (msg.ping !== undefined) player.ping = msg.ping;
    this.pushHistory(player, now);
    // Don't broadcast immediately — batched in tickUpdate
  }

  private static readonly HISTORY_MS = 400; // rewind window for lag comp
  private pushHistory(player: { history: { t: number; x: number; y: number; z: number }[]; position: { x: number; y: number; z: number } }, now: number): void {
    player.history.push({ t: now, x: player.position.x, y: player.position.y, z: player.position.z });
    while (player.history.length > 0 && player.history[0]!.t < now - MessageHandler.HISTORY_MS) {
      player.history.shift();
    }
  }

  // Declared discontinuity (warp beacon, respawn): position arrives
  // pre-accepted — reseat the plausibility anchor so the NEXT report
  // deltas from here instead of measuring a 50m jump as a speedhack.
  private handleTeleport(playerId: string, msg: Extract<ClientMessage, { type: 'teleport' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
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
    // Pre-warp samples are a different location entirely — keeping them
    // lets lag-comp rewind land the shooter/target back at the corpse.
    player.history.length = 0;
    this.pushHistory(player, Date.now());
    // Relay so observers snap instead of interpolating across the gap
    this.broadcast({ type: 'teleport', playerId, position: msg.position, velocity: msg.velocity }, playerId);
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
}
