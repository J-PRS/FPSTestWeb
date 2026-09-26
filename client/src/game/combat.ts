// Combat pipeline: weapon fire -> projectile spawn -> per-frame update ->
// impact handling (effects, AOE force, hit scoring, server/demo notifications).
// All shared game state arrives via CombatDeps (getters for late-init objects).

import * as THREE from 'three';
import type { ChildLogger } from '../core/Logger.js';
import type { DemoManager } from '../demo/index.js';
import type { Player } from '../entities/Player.js';
import type { ViewModel } from '../entities/ViewModel.js';
import { THROW_RELEASE } from '../entities/ViewModel.js';
import type { Ball } from '../entities/balls.js';
import { Nugget } from '../entities/Nugget.js';
import { BallDebris } from '../effects/debris.js';
import type { DamageNumberManager } from '../effects/damageNumbers.js';
import type { EffectsManager } from '../effects/effects.js';
import { Explosion } from '../effects/explosion.js';
import { Implosion } from '../effects/implosion.js';
import { ScorchDecal } from '../effects/scorch.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import { Projectile } from '../projectiles/Projectile.js';
import {
  ROCKET_CONFIG, DISC_CONFIG, GRENADE_CONFIG, CHAINGUN_CONFIG,
  MORTAR_CONFIG, GL_CONFIG, FLAK_CONFIG, PLASMA_CONFIG,
  computeAccuracy,
} from '../projectiles/index.js';
import type { ProjectileConfig } from '../projectiles/types.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { setupInputTracking } from '../utils/InputTracking.js';
import { PENDING_ROCKET_TIMEOUT, FLAK_SHARDS, FLAK_SPREAD, ROCKET_RADIUS } from '../core/config.js';
import { getWeaponStats, WeaponType } from '../../../shared/weapons.js';
import { aoeImpulse, aoeDamage as aoeDamageOf } from '../../../shared/combat.js';
import { poissonDisc } from '../utils/poissonSpread.js';
import type { Terrain } from '../world/terrain.js';
import { screenShake } from '../effects/screenShake.js';
import type { WorldState } from './worldState.js';

export interface CombatDeps {
  scene(): THREE.Scene;
  terrain(): Terrain;
  camera(): THREE.Camera;
  player(): Player;
  viewModel(): ViewModel | undefined;
  demoManager(): DemoManager | null;
  networkManager(): NetworkManager;
  effects(): EffectsManager;
  hud(): HUD;
  healthBarSystem(): HealthBarSystem;
  damageNumbers(): DamageNumberManager;
  fragMessages: FragMessages;
  inputTracking: ReturnType<typeof setupInputTracking>;
  explosionTracker: ExplosionTracker;
  logger: ChildLogger;
  world: WorldState;
  balls: Ball[];
  targets: import('../entities/balls.js').Targetable[]; // balls + crawlers — shootable/blastable
  nuggets: Nugget[];
}

const SCORCH_MAX = 48;

// Flak spread basis — rebuilt per shot, never retained
const _flakRight = new THREE.Vector3();
const _flakUp = new THREE.Vector3();
const _flakUp0 = new THREE.Vector3(0, 1, 0);
const _flakDir = new THREE.Vector3();

// Remote player positions for projectile collision — rebuilt per frame into
// the same Map (zeroed allocations in the hot loop)
const _remotePlayerPositions = new Map<string, THREE.Vector3>();

type FireArgs = { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 };

export function createCombat(deps: CombatDeps) {
  const { logger } = deps;

  function spawnProjectile(config: ProjectileConfig, e: FireArgs): void {
    if (deps.inputTracking.isTabHidden()) return;
    if (deps.demoManager()?.isPlaying) return;

    // INSTANT SHOOTING: Spawn projectile locally immediately for LAN-like feel
    const p = new Projectile(deps.scene(), e.origin, e.dir, e.playerVel, config);
    deps.world.projectiles.push(p);

    if (config.needsServerTracking) {
      deps.world.projectileRegistry.pending.push(p);
      deps.world.projectileRegistry.pendingSince.set(p, Date.now());
    }

    // Record projectile fired event for demo
    const demoManager = deps.demoManager();
    if (demoManager?.isRecording) {
      const velocity = e.dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(e.playerVel, 0.5);
      p.demoProjectileId = demoManager.recordProjectileFired(
        { x: e.origin.x, y: e.origin.y, z: e.origin.z },
        { x: velocity.x, y: velocity.y, z: velocity.z },
        config.weaponType
      );
    }

    // Send shot to server with projectile position/velocity so remote clients
    // see the shot (all weapons, weaponType selects their visual config)
    const velocity = e.dir.clone().normalize().multiplyScalar(config.speed);
    deps.networkManager().sendShot(
      null, // no target yet
      { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      { x: velocity.x, y: velocity.y, z: velocity.z },
      undefined,
      undefined,
      config.weaponType
    );
  }

  // Belt items release mid-throw-anim; compute fresh aim at release time
  // (player may be skiing fast — stale origin would be meters off)
  function freshFireArgs(): FireArgs {
    const player = deps.player();
    return {
      origin: player.pos.clone(),
      dir: new THREE.Vector3(
        Math.cos(player.pitch) * Math.sin(player.yaw),
        Math.sin(player.pitch),
        Math.cos(player.pitch) * Math.cos(player.yaw)
      ).normalize(),
      playerVel: player.vel.clone(),
    };
  }

  function onFire(e: FireArgs): void {
    deps.viewModel()?.kick();
    spawnProjectile(ROCKET_CONFIG, e);
  }

  function onDisc(_e: FireArgs): void {
    deps.viewModel()?.startThrow();
    setTimeout(() => spawnProjectile(DISC_CONFIG, freshFireArgs()), THROW_RELEASE * 1000);
  }

  function onGrenade(_e: FireArgs): void {
    deps.viewModel()?.startThrow();
    setTimeout(() => spawnProjectile(GRENADE_CONFIG, freshFireArgs()), THROW_RELEASE * 1000);
  }

  function onDiscLauncher(e: FireArgs): void {
    deps.viewModel()?.kick();
    spawnProjectile(DISC_CONFIG, e);
  }

  function onChaingun(e: FireArgs): void {
    deps.viewModel()?.kick(0.15);
    spawnProjectile(CHAINGUN_CONFIG, e);
  }

  function onMortar(e: FireArgs): void {
    deps.viewModel()?.kick(2.0); // heavy thump — mortar is the big one
    spawnProjectile(MORTAR_CONFIG, e);
  }

  function onGrenadeLauncher(e: FireArgs): void {
    deps.viewModel()?.kick(0.6);
    spawnProjectile(GL_CONFIG, e);
  }

  // UT flak: one shell = a fan of bouncing shards. Spread pattern comes from
  // a poisson-disc sample (even coverage, no random clumping), rotated by a
  // random angle per shot so the pattern isn't visually memorized.
  function onFlak(e: FireArgs): void {
    deps.viewModel()?.kick(1.4);
    const pts = poissonDisc(FLAK_SHARDS);
    const rot = Math.random() * Math.PI * 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    _flakRight.crossVectors(e.dir, _flakUp0);
    if (_flakRight.lengthSq() < 1e-8) _flakRight.set(1, 0, 0); else _flakRight.normalize();
    _flakUp.crossVectors(_flakRight, e.dir);
    for (const pt of pts) {
      const ox = (pt.x * cs - pt.y * sn) * FLAK_SPREAD;
      const oy = (pt.x * sn + pt.y * cs) * FLAK_SPREAD;
      _flakDir.copy(e.dir)
        .addScaledVector(_flakRight, ox)
        .addScaledVector(_flakUp, oy)
        .normalize();
      spawnProjectile(FLAK_CONFIG, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel });
    }
  }

  function onPlasma(e: FireArgs): void {
    deps.viewModel()?.kick(0.4);
    spawnProjectile(PLASMA_CONFIG, e);
  }

  // ---- Projectile explosion processing (push or pull based on config) ----
  function processProjectileExplosion(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    aoeDamage: number,
    falloffMultiplier: number,
    collisionMultiplier: number,
    forceMultiplier: number,
    shooterId?: string,
    directHit: boolean = false,
    directHitTargetId?: string | null,
    age: number = 0,
    sendAOE?: (pos: { x: number; y: number; z: number }, targetId: string | null) => void,
    _explosionType: 'rocket' | 'grenade' = 'rocket',
    explosionTint?: string | number
  ): void {
    // Explosion/implosion visual + scorch decal on the terrain below the blast
    if (forceMode === 'push') {
      deps.world.explosions.push(new Explosion(deps.scene(), pos, directHit, age, deps.terrain(), radius / ROCKET_RADIUS, explosionTint));
      screenShake.blast(pos, radius, deps.player().pos);
    } else {
      deps.world.implosions.push(new Implosion(deps.scene(), pos, age, deps.terrain()));
      screenShake.blast(pos, radius * 0.5, deps.player().pos);
    }
    // Scorch only when the blast is near the ground — a midair hit would
    // otherwise paint a phantom mark on terrain far below.
    if (pos.y - deps.terrain().getHeight(pos.x, pos.z) <= radius) {
      if (deps.world.scorches.length >= SCORCH_MAX) {
        deps.world.scorches.shift()!.dispose();
      }
      deps.world.scorches.push(new ScorchDecal(deps.scene(), deps.terrain(), pos, radius * 0.6));
    }

    // Record explosion for death impulse calculation
    deps.explosionTracker.addExplosion(pos, force, shooterId || deps.networkManager().getLocalPlayerId());

    applyExplosionForce(pos, radius, force, forceMode, falloffMultiplier, collisionMultiplier, forceMultiplier, aoeDamage, directHitTargetId ?? null);

    // AOE damage to remote players (server-side authority)
    const networkManager = deps.networkManager();
    if (networkManager && networkManager.isConnected() && sendAOE) {
      sendAOE({ x: pos.x, y: pos.y, z: pos.z }, directHitTargetId ?? null);
    }
  }

  interface Forceable {
    pos: THREE.Vector3;
    applyKnockback(from: THREE.Vector3, force: number): void;
    applyPull(to: THREE.Vector3, force: number): void;
  }

  // Apply push/pull force to local player, balls, and remote players
  function applyExplosionForce(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    falloffMultiplier: number,
    collisionMultiplier: number,
    forceMultiplier: number,
    aoeDamage: number,
    directHitTargetId: string | null
  ): void {
    const falloffAt = (dist: number) => 1 - dist / (radius * falloffMultiplier);
    const applyTo = (t: Forceable, f: number) =>
      forceMode === 'push' ? t.applyKnockback(pos, f) : t.applyPull(pos, f);

    const player = deps.player();
    const dpx = player.pos.distanceTo(pos);
    if (dpx < radius * falloffMultiplier) {
      applyTo(player, force * falloffAt(dpx));
    }
    applyForceToBalls(pos, radius, force, forceMode, collisionMultiplier, forceMultiplier, applyTo);
    applyForceToNuggets(pos, radius, force, forceMode, forceMultiplier);
    applyForceToRemotes(pos, radius, force, forceMode, aoeDamage, directHitTargetId);
  }

  // Nuggets are light pickups — blast throws them at a boosted force so
  // explosions visibly scatter loot instead of it hovering through the blast
  function applyForceToNuggets(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    forceMultiplier: number
  ): void {
    const f = force * forceMultiplier * 1.3;
    for (const n of deps.nuggets) {
      if (n.dead || n.collected) continue;
      if (n.pos.distanceToSquared(pos) < radius * radius) {
        if (forceMode === 'push') n.applyKnockback(pos, f);
        else n.applyPull(pos, f);
      }
    }
  }

  function applyForceToBalls(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    collisionMultiplier: number,
    forceMultiplier: number,
    applyTo: (t: Forceable, f: number) => void
  ): void {
    for (const ball of deps.targets) {
      if (ball.dead) continue;
      const db = ball.pos.distanceTo(pos);
      const threshold = forceMode === 'push'
        ? radius + ball.radius
        : radius * collisionMultiplier + ball.radius;
      if (db < threshold) {
        applyTo(ball, force * forceMultiplier);
      }
    }
  }

  // Remote players: damage preview + predicted knockback. Prediction mirrors
  // the server's impulse math (force * (1-dist/radius)) and only bridges the
  // ~1 RTT before the victim's real trajectory streams back — RemotePlayer
  // runs it as dead reckoning and clears stale pre-hit snapshots so there's
  // no snap-back when interpolation resumes.
  function applyForceToRemotes(
    pos: THREE.Vector3,
    radius: number,
    force: number,
    forceMode: 'push' | 'pull',
    aoeDamage: number,
    directHitTargetId: string | null
  ): void {
    for (const [playerId, rp] of deps.world.remotePlayers) {
      if (rp.isDead) continue;
      // Match server damage exactly: 1 - dist/radius inside radius, 0 outside.
      // (The wider falloffAt curve is for knockback reach only — using it here
      // predicts splash damage the server never applies, and the health bar
      // snaps back to full on the next authoritative update.)
      const dist = rp.position.distanceTo(pos);
      const impulse = aoeImpulse(force, dist, radius);
      if (impulse <= 0) continue;
      rp.applyPredictedKnockback(pos, impulse, forceMode === 'pull');
      if (playerId === directHitTargetId) continue;
      deps.hud().showHitMarker();
      deps.healthBarSystem().predictDamage(playerId, aoeDamageOf(aoeDamage, dist, radius));
    }
  }

  // Q-skill Slam landing — the "explosion" is the player hitting terrain.
  // Runs through the same blast path as projectiles so prediction,
  // particles, scorch, and the server aoeShot all behave identically.
  function slam(pos: THREE.Vector3): void {
    const stats = getWeaponStats(WeaponType.Slam);
    const networkManager = deps.networkManager();
    const sendAOE = (p: { x: number; y: number; z: number }, targetId: string | null) =>
      networkManager.sendAOEShot(p, WeaponType.Slam, targetId);
    processProjectileExplosion(
      pos,
      stats.aoeRadius,
      stats.knockbackForce,
      stats.forceMode,
      stats.aoeDamage,
      1.0, 1.0, 1.0,          // falloff/collision/force multipliers
      undefined,              // shooterId — defaults to local player
      false,                  // directHit — slam has no proxy-hit bonus layer
      null,
      0,
      sendAOE,
      'rocket',
      0xffcc66                // hot slam flash
    );
  }

  // ---- Update projectiles ----
  function updateProjectiles(dt: number): void {
    // Clean up stale pending projectiles (no server response within timeout)
    const now = Date.now();
    const registry = deps.world.projectileRegistry;
    for (let i = registry.pending.length - 1; i >= 0; i--) {
      const p = registry.pending[i];
      const timestamp = registry.pendingSince.get(p) || 0;
      if (now - timestamp > PENDING_ROCKET_TIMEOUT) {
        registry.pending.splice(i, 1);
        registry.pendingSince.delete(p);
      }
    }

    // Get remote player positions for collision (skip dead players)
    const remotePlayerPositions = _remotePlayerPositions;
    remotePlayerPositions.clear();
    deps.world.remotePlayers.forEach((rp, playerId) => {
      if (rp.isDead) return;
      remotePlayerPositions.set(playerId, rp.position);
    });

    for (let i = deps.world.projectiles.length - 1; i >= 0; i--) {
      const p = deps.world.projectiles[i];
      p.update(dt, deps.terrain(), deps.targets, remotePlayerPositions);

      if (p.exploded && !p.explosionProcessed) {
        p.explosionProcessed = true;
        handleProjectileImpact(p);
      }

      if (p.dead) {
        const demoManager = deps.demoManager();
        if (demoManager?.isRecording && p.demoProjectileId) {
          demoManager.recordProjectileDestroyed(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
        }
        p.dispose();
        deps.world.projectiles.splice(i, 1);
      }
    }
  }

  // Projectile exploded: spawn effect, apply AOE, score hits, notify server/demo
  function handleProjectileImpact(p: Projectile): void {
    // Remote shells are server-authoritative: render the effect locally,
    // but never report AOE/destroy/hits — that's the shooter's client's job.
    // (GL shells explode on their 2.5s fuse on every observing client.)
    if (p.isRemote) {
      spawnVisualOnly(p);
      return;
    }

    // Notify server to destroy tracked projectile
    if (p.serverProjectileId) {
      deps.networkManager().sendProjectileDestroy(p.serverProjectileId);
    }

    spawnImpactEffect(p);
    recordProjectileHit(p);

    if (p.hitBall) handleBallHit(p, p.hitBall);
    if (p.hitPlayerId) handlePlayerHit(p, p.hitPlayerId);
  }

  // Visual effect only — no AOE, no damage, no server traffic
  function spawnVisualOnly(p: Projectile): void {
    // Prefer the swept hitPoint — on a bounce-fail the integrated pos is
    // already inside the terrain and the blast would render underground
    const pos = p.hitPointValid ? p.hitPoint : p.pos;
    if (p.config.noExplosion) {
      deps.effects().spawnImpact(pos, p.vel);
      return;
    }
    deps.world.explosions.push(new Explosion(deps.scene(), pos, p.directHit, p.age, deps.terrain(), p.explosionRadius / ROCKET_RADIUS, p.config.damageColor));
  }

  function spawnImpactEffect(p: Projectile): void {
    if (p.config.noExplosion) {
      // Bullet impact at the exact sweep intersection point (terrain hits
      // use the bisected hitPoint; ball/player hits use pos).
      deps.effects().spawnImpact(p.hitPointValid ? p.hitPoint : p.pos, p.vel);
      return;
    }
    // One AOE message for all weapons — the shared weapon table carries
    // weaponType, server resolves stats from it (no per-weapon message types)
    const networkManager = deps.networkManager();
    const weaponType = p.config.weaponType;
    const sendAOE = (pos: { x: number; y: number; z: number }, targetId: string | null) =>
      networkManager.sendAOEShot(pos, weaponType, targetId, p.serverProjectileId ?? null, p.hitAge ?? p.age);
    processProjectileExplosion(
      p.hitPointValid ? p.hitPoint : p.pos,
      p.explosionRadius,
      p.force,
      p.forceMode,
      p.config.aoeDamage,
      p.config.falloffMultiplier,
      p.config.collisionMultiplier,
      p.config.forceMultiplier,
      undefined,
      p.directHit,
      p.hitPlayerId,
      p.age,
      sendAOE,
      (p.config.name === 'grenade' || p.config.name === 'grenadeLauncher') ? 'grenade' : 'rocket',
      p.config.damageColor
    );
  }

  // Demo recording + cool-shot logging for any hit (terrain, ball, or player)
  function recordProjectileHit(p: Projectile): void {
    const demoManager = deps.demoManager();
    if (demoManager?.isRecording && p.demoProjectileId) {
      const targetId = p.hitBall ? p.hitBall.id : (p.hitPlayerId ? 0xFFFF : 0);
      demoManager.recordProjectileHit(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, targetId);
    }
    if (p.hitBall || p.hitPlayerId) {
      logger.info(`[CoolShot] ${p.config.displayName} hit ${p.hitBall ? 'ball' : 'player'} airtime=${p.hitAge.toFixed(3)}s dist=${p.hitDistance.toFixed(1)} direct=${p.directHit}`);
      if (demoManager?.isRecording && p.hitAge > 0.2) {
        demoManager.autoClipOnHit(p.hitAge, 0.2);
      }
    }
  }

  function logHitScore(p: Projectile, target: 'ball' | 'player'): void {
    const acc = computeAccuracy(p.hitAccuracy, p.directHit);
    const dist = p.hitDistance;
    const air = p.hitAge;
    const score = Math.round(acc * dist * air);
    logger.info(`[Hit] ${target} direct=${p.directHit} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
    deps.fragMessages.show(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
    deps.hud().showHitMarker();
  }

  function handleBallHit(p: Projectile, ball: import('../entities/balls.js').Targetable): void {
    const destroyed = ball.takeDamage();
    deps.damageNumbers().spawn(ball.pos, 1, p.config.damageColor, deps.camera());
    if (!destroyed) {
      deps.healthBarSystem().spawnBall(ball, 1, ball.health);
    }
    logHitScore(p, 'ball');
    if (destroyed) {
      deps.world.debrisList.push(new BallDebris(deps.scene(), deps.terrain(), ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
      deps.player().kills++;
      // Drop nuggets (bigger balls drop more)
      for (let n = 0; n < Math.round(ball.scale); n++) {
        deps.nuggets.push(new Nugget(deps.scene(), ball.pos, ball.vel));
      }
    }

    const demoManager = deps.demoManager();
    if (demoManager?.isRecording) {
      if (destroyed) {
        demoManager.recordTargetDestroyed(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, ball.variant, ball.health);
      } else {
        demoManager.recordTargetHit(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
      }
    }
  }

  function handlePlayerHit(p: Projectile, playerId: string): void {
    const targetPlayer = deps.world.remotePlayers.get(playerId);
    const hitPos = targetPlayer ? targetPlayer.position : deps.player().pos;
    const directDamage = getWeaponStats(p.config.weaponType).directDamage;
    deps.damageNumbers().spawn(hitPos, directDamage, p.config.damageColor, deps.camera());
    deps.healthBarSystem().predictDamage(playerId, directDamage);
    logHitScore(p, 'player');

    const networkManager = deps.networkManager();
    if (networkManager) {
      networkManager.sendShot(playerId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { x: p.vel.x, y: p.vel.y, z: p.vel.z }, Date.now(), p.serverProjectileId, p.config.weaponType, p.hitAge);
      logger.info(`[Shot] Sent to server: player=${playerId} proj=${p.serverProjectileId} direct=${p.directHit} air=${p.hitAge.toFixed(2)}s`);
    }
  }

  return {
    onFire, onDisc, onGrenade, onDiscLauncher, onChaingun, onMortar, onGrenadeLauncher, onFlak, onPlasma,
    slam,
    updateProjectiles,
  };
}
