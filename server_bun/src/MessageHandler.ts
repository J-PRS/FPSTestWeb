import type { ClientMessage, ServerMessage, SnapshotPlayer, Vec3 } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { CONFIG } from './config.ts';
import { logger } from './logger.ts';
import { getWeaponStats, WeaponType } from '../../shared/weapons.ts';
import { aoeDamage, aoeImpulse, validateHitClaim, validateAoeClaim, type TrackedProjectile } from '../../shared/combat.ts';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

// How long a hit/knocked-back player stays on the unsuppressed full-rate
// tick path — covers the shooter's predicted-knockback window (~0.6s)
// plus margin so the real trajectory replaces the prediction.
const FORCE_SEND_MS = 900;

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

export class MessageHandler {
  private playerManager: PlayerManager;
  private rateLimiter: RateLimiter;
  private broadcast: BroadcastFn;
  private sendToPlayer: SendToPlayerFn;
  private projectileCounter = 0;
  private projectiles: Map<string, TrackedProjectile> = new Map();
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

  /** Drop per-player bookkeeping when a socket closes (grace-period cleanup
   *  leaves PlayerManager state alive, but rate-limit warn state is per-connection) */
  onPlayerDisconnected(playerId: string): void {
    for (const key of this.rateLimitWarnings.keys()) {
      if (key.startsWith(`${playerId}:`)) this.rateLimitWarnings.delete(key);
    }
    // Cancel any pending respawn — the player might rejoin during the grace
    // window, and a stale timer would fire on the new session (or
    // double-respawn if they died again after reconnecting).
    const pending = this.respawnTimers.get(playerId);
    if (pending) {
      clearTimeout(pending);
      this.respawnTimers.delete(playerId);
    }
  }

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === playerId) this.projectiles.delete(id);
    }
  }

  handleHandshake(playerId: string, sessionToken?: string): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

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
        this.handleShot(playerId, msg);
        break;
      case 'aoeShot':
        this.handleAOEShot(playerId, msg);
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
      case 'environmentDamage':
        this.handleEnvironmentDamage(playerId, msg);
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
      if (!target) {
        logger.warn(`Shot rejected: ${playerId} targeted unknown player ${targetId}`);
        return;
      }

      // Hit claims must name the projectile that landed them. The claimed
      // id may be null if the hit raced the server's projectileCreated —
      // fall back to the shooter's most recent spawn of that weapon type.
      const proj = this.resolveClaimedProjectile(playerId, msg.projectileId, msg.weaponType);
      if (!proj) {
        logger.warn(`Shot rejected: ${playerId} hit ${targetId} with no known projectile`);
        return;
      }
      if (msg.position === undefined || msg.airtime === undefined) {
        logger.warn(`Shot rejected: ${playerId} hit claim missing position/airtime`);
        return;
      }
      const verdict = validateHitClaim({
        projectile: proj,
        hitPos: msg.position,
        targetPos: target.position,
        airtime: msg.airtime,
        shooterVel: player.velocity,
        now: Date.now(),
      });
      if (!verdict.ok) {
        logger.warn(`Shot rejected: ${playerId} → ${targetId}: ${verdict.reason}`);
        return;
      }
      // The projectile exploded on impact — drop it so a second claim on
      // the same id can't double-dip.
      if (msg.projectileId) this.projectiles.delete(msg.projectileId);

      const shotDamage = getWeaponStats(proj.weaponType).directDamage;
      const result = this.playerManager.applyDamage(targetId, shotDamage);
      // Full-rate tick updates for the hit window — the shooter's client is
      // extrapolating this target's knockback and needs real positions to
      // converge on (suppression would leave it predicting blind).
      target.forceSendUntil = Date.now() + FORCE_SEND_MS;

      if (!result.killed) {
        logger.info('Player hit', { shooter: playerId, target: targetId, damage: shotDamage, targetHealth: result.newHealth });
        this.broadcast({
          type: 'playerHit',
          shooterId: playerId,
          targetId,
          damage: shotDamage,
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
        this.projectiles.set(projectileId, {
          ownerId: playerId,
          weaponType: msg.weaponType ?? 0,
          origin: { ...msg.position },
          velocity: { ...msg.velocity },
          spawnAt: Date.now(),
        });
        if (this.projectiles.size > 512) {
          // Evict oldest — a live game never has >512 in-flight projectiles;
          // the cap bounds memory if clients never send destroys
          const oldest = this.projectiles.keys().next().value;
          if (oldest) this.projectiles.delete(oldest);
        }
        this.broadcast({
          type: 'projectileCreated',
          projectileId,
          ownerId: playerId,
          position: msg.position,
          velocity: msg.velocity,
          weaponType: msg.weaponType,
        });
      }
    }
  }

  /**
   * Find the tracked projectile a hit claim refers to. The client echoes the
   * server-assigned id when it has it; when the hit outraced the
   * projectileCreated reply it can't, so we fall back to the shooter's most
   * recently spawned projectile of the claimed weapon type.
   */
  private resolveClaimedProjectile(
    playerId: string,
    projectileId: string | null | undefined,
    weaponType: number | undefined,
  ): TrackedProjectile | undefined {
    if (projectileId) {
      const proj = this.projectiles.get(projectileId);
      return proj && proj.ownerId === playerId ? proj : undefined;
    }
    let latest: TrackedProjectile | undefined;
    for (const proj of this.projectiles.values()) {
      if (proj.ownerId !== playerId) continue;
      if (weaponType !== undefined && proj.weaponType !== weaponType) continue;
      latest = proj;
    }
    return latest;
  }

  private handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const stats = getWeaponStats(msg.weaponType);

    if (msg.weaponType === WeaponType.Slam) {
      // Slam is a skill, not a projectile — the blast must land where the
      // player is (they slam into the ground under themselves).
      const dx = player.position.x - msg.position.x;
      const dy = player.position.y - msg.position.y;
      const dz = player.position.z - msg.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > stats.aoeRadius + 20) {
        logger.warn(`AOE rejected: ${playerId} slam ${dist.toFixed(0)}m from player`);
        return;
      }
      this.processAOE(playerId, msg.position, msg.excludeTargetId, stats);
      return;
    }

    // Projectile AOEs must name the tracked projectile that detonated —
    // same fallback resolution as direct-hit claims (race vs projectileCreated).
    const proj = this.resolveClaimedProjectile(playerId, msg.projectileId, msg.weaponType);
    if (!proj) {
      logger.warn(`AOE rejected: ${playerId} blast with no known projectile`);
      return;
    }
    if (msg.airtime === undefined) {
      logger.warn(`AOE rejected: ${playerId} blast claim missing airtime`);
      return;
    }
    const verdict = validateAoeClaim({
      projectile: proj,
      blastPos: msg.position,
      airtime: msg.airtime,
      shooterVel: player.velocity,
      now: Date.now(),
    });
    if (!verdict.ok) {
      logger.warn(`AOE rejected: ${playerId}: ${verdict.reason}`);
      return;
    }
    // The projectile detonated — drop it so the id can't double-dip.
    if (msg.projectileId) this.projectiles.delete(msg.projectileId);

    this.processAOE(playerId, msg.position, msg.excludeTargetId, stats);
  }

  private processAOE(playerId: string, position: Vec3, excludeTargetId: string | null | undefined, stats: import('../../shared/weapons.ts').WeaponStats): void {
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

    const pull = stats.forceMode === 'pull';
    const radius = stats.aoeRadius;
    const baseDamage = stats.aoeDamage;
    const impulseForce = stats.knockbackForce;
    const logLabel = pull ? 'disc AOE' : 'AOE';

    for (const [targetId, target] of this.playerManager.getAllPlayers()) {
      if (targetId === playerId) continue; // Don't damage self
      if (targetId === excludeTargetId) continue; // Skip direct hit target
      if (target.isDead) continue;

      const dx = target.position.x - position.x;
      const dy = target.position.y - position.y;
      const dz = target.position.z - position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist <= radius) {
        // shared/combat.ts — same formula the client predicts with
        const damage = aoeDamage(baseDamage, dist, radius);
        if (damage <= 0) continue;

        // Apply impulse to target velocity (server-authoritative)
        const impulseMag = aoeImpulse(impulseForce, dist, radius);
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
        target.forceSendUntil = Date.now() + FORCE_SEND_MS;
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

  // Client-reported environmental damage (crawler pounces, etc.) — self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
  private handleEnvironmentDamage(playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) return;
    const damage = Math.min(40, Math.max(1, Math.round(msg.amount)));
    const result = this.playerManager.applyDamage(playerId, damage);
    player.forceSendUntil = Date.now() + FORCE_SEND_MS;
    if (!result.killed) {
      this.broadcast({
        type: 'playerHit',
        shooterId: 'environment',
        targetId: playerId,
        damage,
        health: result.newHealth,
      });
    } else {
      logger.info('Player killed by environment', { playerId });
      this.broadcast({
        type: 'playerKill',
        shooterId: 'environment',
        targetId: playerId,
      });
      this.scheduleRespawn(playerId);
    }
  }

  private handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
    // Ownership check: any client could otherwise destroy every other
    // player's in-flight projectiles (grief vector — silently suppresses
    // weapons). Unknown IDs are allowed through so client-side-only IDs
    // still work.
    const proj = this.projectiles.get(msg.projectileId);
    if (proj !== undefined && proj.ownerId !== playerId) {
      logger.warn(`projectileDestroy rejected: ${playerId} doesn't own ${msg.projectileId}`);
      return;
    }
    this.projectiles.delete(msg.projectileId);
    this.broadcast({
      type: 'projectileDestroyed',
      projectileId: msg.projectileId,
    });
  }

  private respawnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private scheduleRespawn(playerId: string): void {
    // One respawn timer per player — a second kill while dead replaces it
    // instead of stacking.
    const existing = this.respawnTimers.get(playerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.respawnTimers.delete(playerId);
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
    this.respawnTimers.set(playerId, timer);
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
