import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3 } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler } from './CombatHandler.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';
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
  }

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
  ): void {
    this.roomInfo.bases = bases;
    this.roomInfo.structures = structures;
    this.roomInfo.arena = arena;
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
      room: this.roomInfo.room,
      mode: this.roomInfo.mode || undefined,
      team: player.team,
      scores: this.roomInfo.scores ? { ...this.roomInfo.scores } : undefined,
      ffaScores: this.roomInfo.ffaScores?.(),
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena
        ? { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena }
        : undefined,
      flags: this.roomInfo.flags?.(),
      pickups: this.roomInfo.pickups?.(),
      deployables: this.roomInfo.deployables?.(),
      matchEndsAt: this.roomInfo.matchEndsAt?.() || undefined,
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
      room: this.roomInfo.room,
      mode: this.roomInfo.mode || undefined,
      scores: this.roomInfo.scores ? { ...this.roomInfo.scores } : undefined,
      ffaScores: this.roomInfo.ffaScores?.(),
      map: this.roomInfo.bases || this.roomInfo.structures || this.roomInfo.arena
        ? { mode: this.roomInfo.mode || undefined, bases: this.roomInfo.bases, structures: this.roomInfo.structures, arena: this.roomInfo.arena }
        : undefined,
      flags: this.roomInfo.flags?.(),
      pickups: this.roomInfo.pickups?.(),
      deployables: this.roomInfo.deployables?.(),
      matchEndsAt: this.roomInfo.matchEndsAt?.() || undefined,
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

    switch (msg.type) {
      case 'position':
        this.handlePosition(playerId, msg);
        break;
      case 'teleport':
        this.handleTeleport(playerId, msg);
        break;
      case 'shot':
        this.combat.handleShot(playerId, msg);
        break;
      case 'aoeShot':
        this.combat.handleAOEShot(playerId, msg);
        break;
      case 'jump':
      case 'jetpack':
        this.relayPresenceEvent(playerId, msg);
        break;
      case 'projectileDestroy':
        this.combat.handleProjectileDestroy(playerId, msg);
        break;
      case 'environmentDamage':
        this.combat.handleEnvironmentDamage(playerId, msg);
        break;
      case 'heal':
        this.combat.handleHeal(playerId, msg);
        break;
      case 'deploy':
        this.roomInfo.onDeploy?.(playerId, msg.kind, msg.position);
        break;
      case 'creatureHit':
        this.ballSim?.handleHit(playerId, msg.id, msg.damage, msg.kx, msg.ky, msg.kz);
        break;
      case 'inputMove':
        player.skiing = msg.input.ski ? 1 : 0;
        break;
      case 'chat':
        // Room-scoped relay — broadcast() only reaches this room's sockets.
        this.broadcast({ type: 'chat', playerId, text: msg.text });
        break;
      case 'ping':
        player.lastSeen = Date.now(); // ping is a liveness signal too —
        // without it a non-moving client could still go "stale"
        this.sendToPlayer(playerId, { type: 'pong', timestamp: msg.timestamp });
        break;
      case 'snapshotRequest':
        this.handleSnapshotRequest(playerId);
        break;
      default:
        logger.warn(`Unhandled message type`, { playerId, type: (msg as { type: string }).type });
        break;
    }
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
