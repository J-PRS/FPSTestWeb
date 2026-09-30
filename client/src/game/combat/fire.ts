import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { Projectile } from '../../projectiles/Projectile.js';
import {
  GRENADE_CONFIG, BELT_DISC_CONFIG, STICKY_CONFIG,
  CLUSTER_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, REMOTE_RAILGUN_CONFIG,
} from '../../projectiles/index.js';
import type { WeaponDef } from '../../weapons.js';
import type { BeltItem } from '../../entities/Player.js';
import type { ProjectileConfig } from '../../projectiles/types.js';
import { THROW_RELEASE } from '../../entities/ViewModel.js';
import { poissonDisc } from '../../utils/poissonSpread.js';
import {
  ROCKET_RADIUS, MELEE_RANGE, MELEE_ARC_DOT, MELEE_DAMAGE,
} from '../../core/config.js';
import { getWeaponStats, WeaponType } from '../../../../shared/weapons.js';
import type { CombatDeps, FireArgs } from '../combat.js';
import type { BlastArgs } from '../blastForce.js';
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
  applyForceToRemotes: (a: BlastArgs) => void;
}

// Weapon trigger handlers: every onX translates a FireArgs into spawned
// projectiles (or a melee sweep), kicks the viewmodel, and reports the shot
// to the server. The explosion/impact side lives in combat.ts.
function spawnProjectile(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, quiet = false): void {
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

  // Ray-burst discharge (remote railgun): beam flash along the slug's
  // velocity line + capacitor zap at the discharge point. The damage is
  // the normal explosion claim at the resolved endpoint — this is pure FX.
  if (config.rayBurst) {
    const beamColor = config.glowColor;
    p.onRayBurst = (from, to) => {
      deps.lazyEffects().spawnBeam(from, to, beamColor);
      sfx.at(from, 'shot_energy', 0.9, 1.3);
    };
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
function freshFireArgs(deps: CombatDeps): FireArgs {
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

// Belt loadout → the projectile it throws. Belt sticky reuses the
// launcher's glue bomb — same fuse, same chain rule, hand-thrown arc.
const BELT_THROWS: Record<BeltItem, ProjectileConfig> = {
  disc: BELT_DISC_CONFIG,
  grenade: GRENADE_CONFIG,
  cluster: CLUSTER_CONFIG,
  javelin: JAVELIN_CONFIG,
  sticky: STICKY_CONFIG,
  impact: IMPACT_CONFIG,
  remoterailgun: REMOTE_RAILGUN_CONFIG,
};

function onBelt(deps: CombatDeps, _e: FireArgs, item: BeltItem): void {
  deps.lazyViewModel()?.startThrow();
  const config = BELT_THROWS[item] ?? BELT_DISC_CONFIG;
  setTimeout(() => spawnProjectile(deps, config, freshFireArgs(deps)), THROW_RELEASE * 1000);
}

// Pellet fan (flak/shotgun): one trigger = a poisson-disc spread of
// projectiles — even coverage without clumping, rotated per shot so the
// pattern isn't visually memorized. One shot sfx for the whole burst.
function spawnFan(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, count: number, spread: number): void {
  sfx.shoot(config.weaponType);
  const pts = poissonDisc(count);
  const rot = Math.random() * Math.PI * 2;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  _flakRight.crossVectors(e.dir, _flakUp0);
  if (_flakRight.lengthSq() < 1e-8) _flakRight.set(1, 0, 0); else _flakRight.normalize();
  _flakUp.crossVectors(_flakRight, e.dir);
  for (const pt of pts) {
    const ox = (pt.x * cs - pt.y * sn) * spread;
    const oy = (pt.x * sn + pt.y * cs) * spread;
    _flakDir.copy(e.dir)
      .addScaledVector(_flakRight, ox)
      .addScaledVector(_flakUp, oy)
      .normalize();
    spawnProjectile(deps, config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);
  }
}

// Trigger dispatch: kick + spawn shape come from the def. 'beam' never
// reaches here — combat.ts routes it to the lightning module, which owns
// its own tick/raycast loop.
function fireWeapon(deps: CombatDeps, def: WeaponDef, e: FireArgs): void {
  deps.lazyViewModel()?.kick(def.kick);
  if (def.pellets) { spawnFan(deps, def.config, e, def.pellets.count, def.pellets.spread); return; }
  if (def.spread) {
    // Stream jitter: a random cone offset per bolt — same basis math as
    // the fan but a single drifting shot, so the volley reads as a hose.
    _flakRight.crossVectors(e.dir, _flakUp0);
    if (_flakRight.lengthSq() < 1e-8) _flakRight.set(1, 0, 0); else _flakRight.normalize();
    _flakUp.crossVectors(_flakRight, e.dir);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * def.spread;
    _flakDir.copy(e.dir)
      .addScaledVector(_flakRight, Math.cos(a) * r)
      .addScaledVector(_flakUp, Math.sin(a) * r)
      .normalize();
    spawnProjectile(deps, def.config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel });
    return;
  }
  spawnProjectile(deps, def.config, e);
}

// Melee sweep — the arc check happens around a point pushed forward
// centered ahead of the fist so the puncher is outside its own radius.
function melee(deps: CombatDeps, hooks: FireHooks, e: FireArgs): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  sfx.shoot(WeaponType.Melee);
  _meleeHitPos.copy(player.pos).addScaledVector(e.dir, MELEE_RANGE * 0.7);

  // Weapon sweeps aside for the punch — no recoil kick, reads as melee
  deps.lazyViewModel()?.punch();
  deps.world.explosions.push(new Explosion(
    deps.lazyScene(), _meleeHitPos, true, 0, deps.lazyTerrain(),
    (stats.aoeRadius * 0.7) / ROCKET_RADIUS, 0xaaddff, 'punch',
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

  // Players go through the authoritative AOE claim; the swing itself
  // rides the cosmetic fire relay so observers see/hear the punch.
  const networkManager = deps.lazyNetworkManager();
  if (networkManager?.isConnected()) {
    networkManager.sendShotFired({
      weaponType: WeaponType.Melee, dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
    });
    networkManager.sendAOEShot({
      position: { x: _meleeHitPos.x, y: _meleeHitPos.y, z: _meleeHitPos.z },
      weaponType: WeaponType.Melee, excludeTargetId: null,
    });
  }
  hooks.applyForceToRemotes({ pos: _meleeHitPos, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: null, falloffMultiplier: 1, collisionMultiplier: 1, forceMultiplier: 1 });
}
export function createFire(deps: CombatDeps, hooks: FireHooks) {

  return {
    spawnProjectile: (c: ProjectileConfig, e: FireArgs, quiet = false) => spawnProjectile(deps, c, e, quiet),
    fireWeapon: (d: WeaponDef, e: FireArgs) => fireWeapon(deps, d, e),
    onBelt: (e: FireArgs, item: BeltItem) => onBelt(deps, e, item),
    onMelee: (e: FireArgs) => melee(deps, hooks, e),
  };
}
