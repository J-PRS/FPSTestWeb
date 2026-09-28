import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { Projectile } from '../../projectiles/Projectile.js';
import {
  ROCKET_CONFIG, DISC_CONFIG, GRENADE_CONFIG, CHAINGUN_CONFIG,
  MORTAR_CONFIG, GL_CONFIG, FLAK_CONFIG, PLASMA_CONFIG, RAILGUN_CONFIG,
  BELT_DISC_CONFIG, SHOTGUN_CONFIG, CANNON_CONFIG, RKT_CONFIG,
  PISTOL_CONFIG, REVOLVER_CONFIG, STICKY_CONFIG, PLASMAGUN_CONFIG,
  CLUSTER_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG,
} from '../../projectiles/index.js';
import type { BeltItem } from '../../entities/Player.js';
import type { ProjectileConfig } from '../../projectiles/types.js';
import { THROW_RELEASE } from '../../entities/ViewModel.js';
import { poissonDisc } from '../../utils/poissonSpread.js';
import {
  FLAK_SHARDS, FLAK_SPREAD, SG_PELLETS, SG_SPREAD, ROCKET_RADIUS,
  MELEE_RANGE, MELEE_ARC_DOT, MELEE_DAMAGE,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import type { CombatDeps, FireArgs } from '../combat.js';
import type { Targetable } from '../../entities/balls.js';

// Flak/shotgun spread basis — rebuilt per shot, never retained
const _flakRight = new THREE.Vector3();
const _flakUp = new THREE.Vector3();
const _flakUp0 = new THREE.Vector3(0, 1, 0);
const _flakDir = new THREE.Vector3();
const _meleeHitPos = new THREE.Vector3();
const _meleeToT = new THREE.Vector3();

export interface FireHooks {
  onTargetDestroyed: (t: Targetable, impulse?: THREE.Vector3, weaponType?: number) => void;
  applyForceToRemotes: (pos: THREE.Vector3, radius: number, force: number, forceMode: 'push' | 'pull', aoeDamage: number, directHitTargetId: string | null) => void;
}

// Weapon trigger handlers: every onX translates a FireArgs into spawned
// projectiles (or a melee sweep), kicks the viewmodel, and reports the shot
// to the server. The explosion/impact side lives in combat.ts.
export function createFire(deps: CombatDeps, hooks: FireHooks) {
  function spawnProjectile(config: ProjectileConfig, e: FireArgs, quiet = false): void {
    if (deps.inputTracking.isTabHidden()) return;
    if (deps.lazyDemoManager()?.isPlaying) return;

    if (!quiet) sfx.shoot(config.weaponType);
    // INSTANT SHOOTING: Spawn projectile locally immediately for LAN-like feel
    const p = new Projectile(deps.lazyScene(), e.origin, e.dir, e.playerVel, config);
    deps.world.projectiles.push(p);

    if (config.needsServerTracking) {
      deps.world.projectileRegistry.pending.push(p);
      deps.world.projectileRegistry.pendingSince.set(p, Date.now());
    }

    // Record projectile fired event for demo
    const demoManager = deps.lazyDemoManager();
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
    deps.lazyNetworkManager().sendShot({
      targetId: null, // no target yet
      position: { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      weaponType: config.weaponType,
    });
  }

  // Belt items release mid-throw-anim; compute fresh aim at release time
  // (player may be skiing fast — stale origin would be meters off)
  function freshFireArgs(): FireArgs {
    const player = deps.lazyPlayer();
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
    deps.lazyViewModel()?.kick();
    spawnProjectile(ROCKET_CONFIG, e);
  }

  // Belt loadout → the projectile it throws. Belt sticky reuses the
  // launcher's glue bomb — same fuse, same chain rule, hand-thrown arc.
  const BELT_THROWS: Record<BeltItem, ProjectileConfig> = {
    disc: BELT_DISC_CONFIG,
    grenade: GRENADE_CONFIG,
    cluster: CLUSTER_CONFIG,
    javelin: JAVELIN_CONFIG,
    sticky: STICKY_CONFIG,
    impact: IMPACT_CONFIG,
  };

  function onBelt(_e: FireArgs, item: BeltItem): void {
    deps.lazyViewModel()?.startThrow();
    const config = BELT_THROWS[item] ?? BELT_DISC_CONFIG;
    setTimeout(() => spawnProjectile(config, freshFireArgs()), THROW_RELEASE * 1000);
  }

  function onDiscLauncher(e: FireArgs): void {
    deps.lazyViewModel()?.kick();
    spawnProjectile(DISC_CONFIG, e);
  }

  function onChaingun(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.15);
    spawnProjectile(CHAINGUN_CONFIG, e);
  }

  function onMortar(e: FireArgs): void {
    deps.lazyViewModel()?.kick(2.0); // heavy thump — mortar is the big one
    spawnProjectile(MORTAR_CONFIG, e);
  }

  function onGrenadeLauncher(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.6);
    spawnProjectile(GL_CONFIG, e);
  }

  // UT flak: one shell = a fan of bouncing shards. Spread pattern comes from
  // a poisson-disc sample (even coverage, no random clumping), rotated by a
  // random angle per shot so the pattern isn't visually memorized.
  function onFlak(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.4);
    sfx.shoot(FLAK_CONFIG.weaponType); // once for the fan, not once per shard
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
      spawnProjectile(FLAK_CONFIG, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);
    }
  }

  // Shotgun: same poisson fan as flak but ~3× tighter cone on fast flat
  // slugs — the burst lands as a pattern, not a scatter. Mid-range viable.
  function onShotgun(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.6);
    sfx.shoot(SHOTGUN_CONFIG.weaponType); // once for the burst
    const pts = poissonDisc(SG_PELLETS);
    const rot = Math.random() * Math.PI * 2;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    _flakRight.crossVectors(e.dir, _flakUp0);
    if (_flakRight.lengthSq() < 1e-8) _flakRight.set(1, 0, 0); else _flakRight.normalize();
    _flakUp.crossVectors(_flakRight, e.dir);
    for (const pt of pts) {
      const ox = (pt.x * cs - pt.y * sn) * SG_SPREAD;
      const oy = (pt.x * sn + pt.y * cs) * SG_SPREAD;
      _flakDir.copy(e.dir)
        .addScaledVector(_flakRight, ox)
        .addScaledVector(_flakUp, oy)
        .normalize();
      spawnProjectile(SHOTGUN_CONFIG, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);
    }
  }

  // Serious Sam cannon: one big iron ball that skips off terrain and pops
  // on contact. Heavy kick — the thump is half the fun.
  function onCannon(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.2);
    spawnProjectile(CANNON_CONFIG, e);
  }

  // RPG missile: straight flight, slow enough to track in the air, big
  // warhead pop. Heavy kick — the launch should shove your view.
  function onRocketLauncher(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.6);
    spawnProjectile(RKT_CONFIG, e);
  }

  // Hold-out sidearms — single tracers, light kick (pistol), heavy (revolver)
  function onPistol(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.3);
    spawnProjectile(PISTOL_CONFIG, e);
  }

  function onRevolver(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.0);
    spawnProjectile(REVOLVER_CONFIG, e);
  }

  function onPlasma(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.4);
    spawnProjectile(PLASMA_CONFIG, e);
  }

  // Rapid plasma: light kick, bolt per trigger — the cadence sells it.
  function onPlasmaGun(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.2);
    spawnProjectile(PLASMAGUN_CONFIG, e);
  }

  // Sticky launcher as a primary slot (wid 14) — belt throws reuse the
  // same config but this path never got a callback, so the slot silently
  // fell back to rockets.
  function onStickyLauncher(e: FireArgs): void {
    deps.lazyViewModel()?.kick(0.8);
    spawnProjectile(STICKY_CONFIG, e);
  }

  // Railgun: hypervelocity slug, big kick — the precision slot.
  function onRailgun(e: FireArgs): void {
    deps.lazyViewModel()?.kick(1.8);
    spawnProjectile(RAILGUN_CONFIG, e);
  }

  // Melee sweep — the arc check happens around a point pushed forward
  // centered ahead of the fist so the puncher is outside its own radius.
  function melee(e: FireArgs): void {
    const player = deps.lazyPlayer();
    const stats = getWeaponStats(WeaponType.Melee);
    sfx.shoot(WeaponType.Melee);
    _meleeHitPos.copy(player.pos).addScaledVector(e.dir, MELEE_RANGE * 0.7);

    // Weapon sweeps aside for the punch — no recoil kick, reads as melee
    deps.lazyViewModel()?.punch();
    deps.world.explosions.push(new Explosion(
      deps.lazyScene(), _meleeHitPos, true, 0, deps.lazyTerrain(),
      (stats.aoeRadius * 0.7) / ROCKET_RADIUS, 0xaaddff,
    ));
    screenShake.blast(_meleeHitPos, stats.aoeRadius, player.pos);

    let connected: THREE.Vector3 | null = null;
    for (const t of deps.targets) {
      if (t.dead) continue;
      _meleeToT.copy(t.pos).sub(player.pos);
      const dist = _meleeToT.length();
      if (dist > MELEE_RANGE + (t.hitRadius ?? t.radius)) continue;
      _meleeToT.divideScalar(dist || 1);
      if (_meleeToT.dot(e.dir) < MELEE_ARC_DOT) continue;
      t.applyKnockback(player.pos, stats.knockbackForce);
      deps.lazyDamageNumbers().spawn(t.pos, MELEE_DAMAGE, '#aaddff', deps.lazyCamera());
      deps.reportTargetDamage?.(t, MELEE_DAMAGE);
      if (t.takeDamage(MELEE_DAMAGE)) hooks.onTargetDestroyed(t, t.vel, WeaponType.Melee);
      else if (!t.hideHealthBar) deps.lazyHealthBarSystem().spawnBall(t, MELEE_DAMAGE, t.health);
      deps.lazyHud().showHitMarker();
      connected ??= t.pos;
    }
    // The crack that sells it — positional impact only when the punch lands
    if (connected) { sfx.at(connected, 'impact', 1); sfx.hitMarker(true); }

    // Players go through the authoritative AOE claim
    const networkManager = deps.lazyNetworkManager();
    if (networkManager?.isConnected()) {
      networkManager.sendAOEShot({
        position: { x: _meleeHitPos.x, y: _meleeHitPos.y, z: _meleeHitPos.z },
        weaponType: WeaponType.Melee, excludeTargetId: null,
      });
    }
    hooks.applyForceToRemotes(_meleeHitPos, stats.aoeRadius, stats.knockbackForce, 'push', stats.aoeDamage, null);
  }

  return {
    spawnProjectile,
    onFire, onBelt, onDiscLauncher, onChaingun, onMortar, onGrenadeLauncher,
    onFlak, onPlasma, onRailgun, onShotgun, onCannon, onRocketLauncher,
    onPistol, onRevolver, onSticky: onStickyLauncher, onPlasmaGun,
    onMelee: melee,
  };
}
