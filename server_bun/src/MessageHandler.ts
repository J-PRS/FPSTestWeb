import type { ClientMessage, ServerMessage, SnapshotPlayer } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CombatHandler } from './CombatHandler.ts';
import { logger } from './logger.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

export class MessageHandler {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private broadcast: BroadcastFn;
  private sendToPlayer: SendToPlayerFn;
  // Everything that deals damage — projectiles, blasts, env damage, respawns
  private combat: CombatHandler;
  private rateLimitWarnings: Map<string, number> = new Map();
  private readonly RATE_WARN_COOLDOWN_MS = 5000;

  constructor(
    playerManager: PlayerManager,
    rateLimiter: RateLimiter,
    broadcast: BroadcastFn,
    sendToPlayer: SendToPlayerFn,
  ) {
    this.playerManager = playerManager;
    this.rateLimiter = rateLimiter;
    this.broadcast = broadcast;
    this.sendToPlayer = sendToPlayer;
    this.combat = new CombatHandler(playerManager, broadcast, sendToPlayer);
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

  handleHandshake(playerId: string, sessionToken?: string): void {
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
      localPlayerState: {
        position: { ...player.position },
        rotation: { ...player.rotation },
        velocity: { ...player.velocity },
        health: player.health,
        isDead: player.isDead,
      },
    });

    this.broadcast({
      type: 'playerJoined',
      playerId: player.id,
      internalId: player.internalId,
      position: player.position,
      rotation: player.rotation,
    }, playerId);
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
      case 'inputMove':
        player.skiing = msg.input.ski ? 1 : 0;
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
    // Don't broadcast immediately — batched in tickUpdate
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
