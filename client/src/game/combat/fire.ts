import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { Projectile } from '../../projectiles/Projectile.js';
import {
  GRENADE_CONFIG, BELT_DISC_CONFIG, STICKY_CONFIG,
  CLUSTER_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, REMOTE_RAILGUN_CONFIG,
  ARMORNADE_CONFIG,
} from '../../projectiles/index.js';
import type { WeaponDef } from '../../weapons.js';
import type { BeltItem } from '../../entities/Player.js';
import type { ProjectileConfig } from '../../projectiles/types.js';
import { THROW_RELEASE } from '../../entities/ViewModel.js';
import { poissonDisc } from '../../utils/poissonSpread.js';
import {
  EXPLOSION_VFX_RADIUS, MELEE_RANGE, MELEE_ARC_DOT, MELEE_DAMAGE, SCORCH_MAX,
} from '../../core/config.js';
import { ScorchDecal } from '../../effects/scorch.js';
import { fxPuff } from '../../effects/vfx.js';
import { getWeaponStats, WeaponType, BELT_THROW_COST } from '../../../../shared/weapons.js';
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
const _meleeProbe = new THREE.Vector3();

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
    p.shotId = `s${++deps.world.projectileRegistry.seq}`;
    deps.world.projectileRegistry.byShotId.set(p.shotId, p);
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
    shotId: p.shotId ?? undefined,
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
  armornade: ARMORNADE_CONFIG,
};

function onBelt(deps: CombatDeps, _e: FireArgs, item: BeltItem): void {
  const p = deps.lazyPlayer();
  // Ordnance economy: a dry belt can't throw — server enforces the same
  // rule on the spawn claim, this gate just saves the animation/no-op.
  if (p.beltCharges < BELT_THROW_COST) return;
  deps.lazyViewModel()?.startThrow();
  const config = BELT_THROWS[item] ?? BELT_DISC_CONFIG;
  // Dying mid wind-up must not release — the server rejects dead-player
  // claims, leaving a local ghost projectile.
  setTimeout(() => {
    const pl = deps.lazyPlayer();
    if (pl.isDead || pl.beltCharges < BELT_THROW_COST) return;
    pl.beltCharges -= BELT_THROW_COST;
    spawnProjectile(deps, config, freshFireArgs(deps));
  }, THROW_RELEASE * 1000);
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

// Terrain contact: march the fist ray against the heightfield. A swing
// that reaches dirt relocates the whole punch FX to the contact point —
// punching the ground should read as punching the ground, not air near it.
function meleeGroundContact(playerPos: THREE.Vector3, dir: THREE.Vector3, terrain: ReturnType<CombatDeps['lazyTerrain']>): THREE.Vector3 | null {
  for (let d = 0.4; d <= MELEE_RANGE; d += 0.4) {
    _meleeProbe.copy(playerPos).addScaledVector(dir, d);
    if (_meleeProbe.y - terrain.getHeight(_meleeProbe.x, _meleeProbe.z) < 0.4) {
      return _meleeProbe.clone();
    }
  }
  return null;
}

// Swing presentation: fist puff at the resolved contact point, a fist-mark
// scorch + dirt spray + thud on terrain hits, and a speed-line whoosh that
// sells the arc without an arm animation (same trick as the blink surge).
// All visuals — the damage/force side stays in melee() below.
function meleeSwingFx(deps: CombatDeps, e: FireArgs, fxPos: THREE.Vector3, groundHit: THREE.Vector3 | null): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  deps.lazyViewModel()?.punch(); // weapon sweeps aside — no recoil kick
  deps.world.explosions.push(new Explosion(
    deps.lazyScene(), fxPos, true, 0, deps.lazyTerrain(),
    (stats.aoeRadius * 0.7) / EXPLOSION_VFX_RADIUS, 0xaaddff, 'punch',
  ));
  screenShake.blast(fxPos, stats.aoeRadius, player.pos);
  if (groundHit) {
    if (deps.world.scorches.length >= SCORCH_MAX) deps.world.scorches.shift()!.dispose();
    deps.world.scorches.push(new ScorchDecal(deps.lazyScene(), deps.lazyTerrain(), groundHit, 1.4));
    // Dirt spray kicked up off the fist — brown, gravity-bound, short.
    fxPuff(groundHit, {
      count: 14, pos: [0.4, 0.1, 0.4],
      velMin: [-3.5, 2.5, -3.5], velMax: [3.5, 8, 3.5],
      lifeMin: 0.25, lifeMax: 0.7, sizeScale: 1.6,
      colA: [0.32, 0.26, 0.18], colB: [0.5, 0.42, 0.3],
    });
    sfx.at(groundHit, 'slam_thud', 0.9);
    screenShake.add(0.28);
  }
  deps.lazySpeedLines?.().surge(player.pos, fxPos, 0xaaddff, 8);
}

// Melee sweep — the arc check happens around a point pushed forward
// centered ahead of the fist so the puncher is outside its own radius.
function melee(deps: CombatDeps, hooks: FireHooks, e: FireArgs): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  sfx.shoot(WeaponType.Melee);
  _meleeHitPos.copy(player.pos).addScaledVector(e.dir, MELEE_RANGE * 0.7);

  const groundHit = meleeGroundContact(player.pos, e.dir, deps.lazyTerrain());
  meleeSwingFx(deps, e, groundHit ?? _meleeHitPos, groundHit);

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
  if (connected) {
    sfx.at(connected, 'impact', 1);
    sfx.hitMarker(true);
    // Contact sparks + a shake bump — feedback that says HOW HARD, fired
    // only on a confirmed hit so whiffs stay soft.
    fxPuff(connected, {
      count: 10, pos: [0.3, 0.3, 0.3],
      velMin: [-5, 1, -5], velMax: [5, 6, 5],
      lifeMin: 0.12, lifeMax: 0.35, sizeScale: 1.0,
      colA: [0.6, 0.85, 1.0], colB: [0.3, 0.5, 0.9], additive: true,
    });
    screenShake.add(0.22);
  }

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
  hooks.applyForceToRemotes({ pos: _meleeHitPos, radius: stats.aoeRadius, force: stats.knockbackForce, forceMode: 'push', aoeDamage: stats.aoeDamage, directHitTargetId: null, forceMultiplier: 1 });
}
export function createFire(deps: CombatDeps, hooks: FireHooks) {

  return {
    spawnProjectile: (c: ProjectileConfig, e: FireArgs, quiet = false) => spawnProjectile(deps, c, e, quiet),
    fireWeapon: (d: WeaponDef, e: FireArgs) => fireWeapon(deps, d, e),
    onBelt: (e: FireArgs, item: BeltItem) => onBelt(deps, e, item),
    onMelee: (e: FireArgs) => melee(deps, hooks, e),
  };
}
