import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3 } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CONFIG } from './config.ts';
import { logger } from './logger.ts';

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

export class MessageHandler {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private broadcast: BroadcastFn;
  private sendToPlayer: SendToPlayerFn;
  private projectileCounter = 0;
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
  }

  handleHandshake(playerId: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const others = this.playerManager.getOtherPlayers(playerId);
    const playersData = others.map((p) => this.playerManager.toGameStatePlayer(p));

    this.sendToPlayer(playerId, {
      type: 'gameState',
      players: playersData,
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
        this.handleShot(playerId, msg);
        break;
      case 'aoeShot':
        this.handleAOEShot(playerId, msg);
        break;
      case 'discAOEShot':
        this.handleDiscAOEShot(playerId, msg);
        break;
      case 'grenadeAOEShot':
        this.handleGrenadeAOEShot(playerId, msg);
        break;
      case 'jump':
        this.handleJump(playerId, msg);
        break;
      case 'jetpack':
        this.handleJetpack(playerId, msg);
        break;
      case 'projectileDestroy':
        this.handleProjectileDestroy(playerId, msg);
        break;
      case 'inputMove':
      case 'input':
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

    // Cheat prevention: position plausibility check
    // Reject if player moved faster than max possible speed since last update
    const now = Date.now();
    const prevPos = player.position;
    const dt = (now - player.lastSeen) / 1000;
    if (dt > 0 && prevPos) {
      const dx = msg.position.x - prevPos.x;
      const dy = msg.position.y - prevPos.y;
      const dz = msg.position.z - prevPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const speed = dist / dt;
      // Max plausible speed: 200 m/s (covers knockback + jetpack + falling)
      // At 20Hz updates, that's 10m per update — very generous
      if (speed > 200) {
        logger.warn(`Position rejected: ${playerId} moved ${dist.toFixed(1)}m in ${dt.toFixed(3)}s (${speed.toFixed(0)} m/s)`);
        return;
      }
    }

    this.playerManager.updatePosition(playerId, msg.position, msg.rotation, msg.velocity);
    // Don't broadcast immediately — batched in tickUpdate
  }

  private handleShot(playerId: string, msg: Extract<ClientMessage, { type: 'shot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;

    const { targetId } = msg;

    if (targetId) {
      // Reject self-damage — client should never send its own ID as targetId
      if (targetId === playerId) {
        logger.warn(`Shot rejected: ${playerId} tried to hit themselves`);
        return;
      }

      const target = this.playerManager.getPlayer(targetId);
      if (target) {
        // Cheap cheat prevention: distance sanity check
        // Reject if shooter claims hit on a target > 200m away (max rocket range + margin)
        const dx = player.position.x - target.position.x;
        const dy = player.position.y - target.position.y;
        const dz = player.position.z - target.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > 40000) { // 200m squared
          logger.warn(`Shot rejected: ${playerId} too far from target ${targetId} (${Math.sqrt(distSq).toFixed(0)}m)`);
          return;
        }
      }

      const result = this.playerManager.applyDamage(targetId, CONFIG.shotDamage);

      if (!result.killed) {
        logger.info('Player hit', { shooter: playerId, target: targetId, damage: CONFIG.shotDamage, targetHealth: result.newHealth });
        this.broadcast({
          type: 'playerHit',
          shooterId: playerId,
          targetId,
          damage: CONFIG.shotDamage,
          health: result.newHealth,
        });
      } else {
        this.playerManager.addKill(playerId);
        logger.info('Player killed', { shooter: playerId, target: targetId, shooterKills: this.playerManager.getPlayer(playerId)?.kills });
        this.broadcast({
          type: 'playerKill',
          shooterId: playerId,
          targetId,
        });
        this.scheduleRespawn(targetId);
      }
    } else {
      logger.debug('Shot fired (miss)', { shooter: playerId });

      if (msg.position && msg.velocity) {
        const projectileId = `proj_${++this.projectileCounter}`;
        this.broadcast({
          type: 'projectileCreated',
          projectileId,
          ownerId: playerId,
          position: msg.position,
          velocity: msg.velocity,
        });
      }
    }
  }

  private handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    this.processAOE(playerId, msg.position, msg.excludeTargetId, 'rocket');
  }

  private handleDiscAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'discAOEShot' }>): void {
    this.processAOE(playerId, msg.position, msg.excludeTargetId, 'disc');
  }

  private handleGrenadeAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'grenadeAOEShot' }>): void {
    this.processAOE(playerId, msg.position, msg.excludeTargetId, 'grenade');
  }

  private processAOE(playerId: string, position: Vec3, excludeTargetId: string | null | undefined, mode: 'rocket' | 'disc' | 'grenade'): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;

    // Cheat prevention: AOE position must be within 200m of shooter
    const dx = player.position.x - position.x;
    const dy = player.position.y - position.y;
    const dz = player.position.z - position.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > 40000) { // 200m squared
      logger.warn(`AOE rejected: ${playerId} too far from explosion (${Math.sqrt(distSq).toFixed(0)}m)`);
      return;
    }

    const pull = mode === 'disc';
    const radius = pull ? CONFIG.discAoeRadius : (mode === 'grenade' ? CONFIG.grenadeAoeRadius : CONFIG.aoeRadius);
    const baseDamage = pull ? CONFIG.discAoeDamage : (mode === 'grenade' ? CONFIG.grenadeAoeDamage : CONFIG.aoeDamage);
    const impulseForce = pull ? CONFIG.discPullForce : (mode === 'grenade' ? CONFIG.grenadeKnockbackForce : CONFIG.knockbackForce);
    const logLabel = pull ? 'disc AOE' : (mode === 'grenade' ? 'grenade AOE' : 'AOE');

    for (const [targetId, target] of this.playerManager.getAllPlayers()) {
      if (targetId === playerId) continue; // Don't damage self
      if (targetId === excludeTargetId) continue; // Skip direct hit target
      if (target.isDead) continue;

      const dx = target.position.x - position.x;
      const dy = target.position.y - position.y;
      const dz = target.position.z - position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist <= radius) {
        const falloff = 1 - dist / radius;
        const damage = Math.round(baseDamage * falloff);
        if (damage <= 0) continue;

        // Apply impulse to target velocity (server-authoritative)
        const impulseMag = impulseForce * falloff;
        if (dist > 0) {
          if (pull) {
            // Pull toward explosion center (reversed direction)
            target.velocity.x -= (dx / dist) * impulseMag;
            target.velocity.y += 0.3 * impulseMag;
            target.velocity.z -= (dz / dist) * impulseMag;
          } else {
            // Push away from explosion center
            target.velocity.x += (dx / dist) * impulseMag;
            target.velocity.y += 0.5 * impulseMag;
            target.velocity.z += (dz / dist) * impulseMag;
          }
        }

        // Notify the target player to apply impulse to their local player
        this.sendToPlayer(targetId, {
          type: 'knockback',
          targetId,
          position,
          force: impulseMag,
          pull: pull || undefined,
        });

        const result = this.playerManager.applyDamage(targetId, damage);

        if (!result.killed) {
          logger.info(`Player ${logLabel} hit`, { shooter: playerId, target: targetId, damage, dist: dist.toFixed(2), targetHealth: result.newHealth });
          this.broadcast({
            type: 'playerHit',
            shooterId: playerId,
            targetId,
            damage,
            health: result.newHealth,
          });
        } else {
          this.playerManager.addKill(playerId);
          logger.info(`Player killed by ${logLabel}`, { shooter: playerId, target: targetId, damage });
          this.broadcast({
            type: 'playerKill',
            shooterId: playerId,
            targetId,
          });
          this.scheduleRespawn(targetId);
        }
      }
    }
  }

  private handleJump(playerId: string, msg: Extract<ClientMessage, { type: 'jump' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.broadcast({
      type: 'jump',
      playerId,
      position: msg.position,
    }, playerId);
  }

  private handleJetpack(playerId: string, msg: Extract<ClientMessage, { type: 'jetpack' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    this.broadcast({
      type: 'jetpack',
      playerId,
      position: msg.position,
    }, playerId);
  }

  private handleProjectileDestroy(_playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    this.broadcast({
      type: 'projectileDestroyed',
      projectileId: msg.projectileId,
    });
  }

  private scheduleRespawn(playerId: string): void {
    setTimeout(() => {
      const result = this.playerManager.respawnPlayer(playerId);
      if (!result) return;

      const player = this.playerManager.getPlayer(playerId);
      if (!player) return;

      logger.info('Player respawned', { playerId, position: result.position });

      this.broadcast({
        type: 'playerRespawn',
        playerId,
        internalId: player.internalId,
        position: result.position,
        rotation: result.rotation,
      });
    }, CONFIG.respawnDelayMs);
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
