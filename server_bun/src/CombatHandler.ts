import type { ClientMessage, ServerMessage, Vec3 } from './types.ts';
import type { PlayerManager } from './PlayerManager.ts';
import type { WeaponStats } from '../../shared/weapons.ts';
import { getWeaponStats, WeaponType } from '../../shared/weapons.ts';
import { aoeDamage, aoeImpulse, validateHitClaim, validateAoeClaim, type TrackedProjectile } from '../../shared/combat.ts';
import { CONFIG } from './config.ts';
import { logger } from './logger.ts';

// How long a hit/knocked-back player stays on the unsuppressed full-rate
// tick path — covers the shooter's predicted-knockback window (~0.6s)
// plus margin so the real trajectory replaces the prediction.
const FORCE_SEND_MS = 900;

type BroadcastFn = (msg: ServerMessage, excludePlayerId?: string) => void;
type SendToPlayerFn = (playerId: string, msg: ServerMessage) => void;

/**
 * Everything that can hurt a player: shot hit-claims, AOE blasts,
 * environmental damage, projectile tracking/destroy, and respawn timers.
 * Split from MessageHandler so the dispatch surface (movement, presence,
 * snapshots) stays a thin routing file.
 */
export class CombatHandler {
  private projectileCounter = 0;
  private projectiles: Map<string, TrackedProjectile> = new Map();
  private respawnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private playerManager: PlayerManager,
    private broadcast: BroadcastFn,
    private sendToPlayer: SendToPlayerFn,
  ) {}

  /** Drop live projectiles when a player is fully removed (grace timeout /
   *  idle reap) — NOT on socket close, so a rejoining player keeps theirs. */
  onPlayerRemoved(playerId: string): void {
    for (const [id, proj] of this.projectiles) {
      if (proj.ownerId === playerId) this.projectiles.delete(id);
    }
  }

  /** Cancel a pending respawn on disconnect — the player might rejoin during
   *  the grace window, and a stale timer would fire on the new session (or
   *  double-respawn if they died again after reconnecting). */
  onPlayerDisconnected(playerId: string): void {
    const pending = this.respawnTimers.get(playerId);
    if (pending) {
      clearTimeout(pending);
      this.respawnTimers.delete(playerId);
    }
  }

  handleShot(playerId: string, msg: Extract<ClientMessage, { type: 'shot' }>): void {
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

  handleAOEShot(playerId: string, msg: Extract<ClientMessage, { type: 'aoeShot' }>): void {
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

  private processAOE(playerId: string, position: Vec3, excludeTargetId: string | null | undefined, stats: WeaponStats): void {
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

  // Client-reported environmental damage (crawler pounces, etc.) — self-only,
  // clamped so it can never be aimed at another player or one-shot anyone.
  handleEnvironmentDamage(playerId: string, msg: Extract<ClientMessage, { type: 'environmentDamage' }>): void {
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

  handleProjectileDestroy(playerId: string, msg: Extract<ClientMessage, { type: 'projectileDestroy' }>): void {
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
}
