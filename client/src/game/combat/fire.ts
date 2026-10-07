import * as THREE from 'three';

import * as sfx from '../../core/sfx.js';
import { Explosion } from '../../effects/explosion.js';
import { screenShake } from '../../effects/screenShake.js';
import { Projectile } from '../../projectiles/Projectile.js';
import {
  GRENADE_CONFIG, BELT_DISC_CONFIG, STICKY_CONFIG,
  CLUSTER_CONFIG, JAVELIN_CONFIG, IMPACT_CONFIG, REMOTE_RAILGUN_CONFIG,
  ARMORNADE_CONFIG, PROXY_CONFIG, SATCHEL_CONFIG, HEALNADE_CONFIG,
  CONC_CONFIG,
} from '../../projectiles/index.js';
import type { WeaponDef } from '../../weapons.js';
import { BELT_THROW_TIME, type BeltItem } from '../../entities/Player.js';
import type { ProjectileConfig } from '../../projectiles/types.js';
import { THROW_RELEASE } from '../../entities/ViewModel.js';
import { poissonDisc } from '../../utils/poissonSpread.js';
import { spawnDrift } from '../../debug/netProbe.js';
import {
  EXPLOSION_VFX_RADIUS, MELEE_RANGE, MELEE_ARC_DOT, MELEE_DAMAGE, SCORCH_MAX,
} from '../../core/config.js';
import { ScorchDecal } from '../../effects/scorch.js';
import { fxPuff } from '../../effects/vfx.js';
import { swingSwipeView } from '../../effects/swingTrails.js';
import { getWeaponStats, WeaponType, beltThrowCost, serverSimmed } from '../../../../shared/weapons.js';
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
// Muzzle lead: shells spawn at the EYE (FireEvent origin = player.pos)
// so every shot's glow envelope materializes wrapped around the camera —
// a half-meter push down the aim line clears the near plane. The CLAIMED
// spawn moves too (same origin in the shot message), keeping server
// tracking and remote replicas consistent with what the shooter sees.
const MUZZLE_LEAD = 1;
// Shoulder drop (third person only): the eye-point origin reads as
// forehead-fired on the chase cam — a small parallel offset puts the
// launch at chest/gun height. First person keeps the Quake rule:
// spawn exactly on the aim line from the eye/crosshair. The offset
// rides the claimed origin, so what the 3P shooter sees is what
// remote replicas render.
const SHOULDER_DROP = 0.35;
const _spawnOrigin = new THREE.Vector3();

function spawnProjectile(deps: CombatDeps, config: ProjectileConfig, e: FireArgs, quiet = false): Projectile | undefined {
  if (deps.inputTracking.isTabHidden()) {return undefined;}
  if (deps.lazyDemoManager()?.isPlaying) {return undefined;}

  if (!quiet) {sfx.shoot(config.weaponType);}
  // Decloak-on-fire: bot senses mask this player's cloak for the reveal
  // window, same rule the server applies to its own bots.
  deps.lazyPlayer().lastFireAt = performance.now();
  _spawnOrigin.copy(e.origin).addScaledVector(e.dir, MUZZLE_LEAD);
  if (deps.lazyPlayer().thirdPerson) {_spawnOrigin.y -= SHOULDER_DROP;}
  // INSTANT SHOOTING: Spawn projectile locally immediately for LAN-like feel
  const p = new Projectile(deps.lazyScene(), _spawnOrigin, e.dir, e.playerVel, config);
  deps.world.projectiles.push(p);

  // Every spawn below claims a wire identity — the nonce is what binds
  // the projectileCreated echo back to this shell. Minting only for
  // needsServerTracking left untracked shells (bomblets, MRV children)
  // registering server-side with no id to link: 'no local shell' warns.
  // needsServerTracking keeps governing the damage-claim path; the nonce
  // costs a map entry, pruned on death.
  p.shooterTeam = deps.world.localTeam ?? null;
  p.shotId = `s${++deps.world.projectileRegistry.seq}`;
  deps.world.projectileRegistry.byShotId.set(p.shotId, p);

  // Record projectile fired event for demo
  const demoManager = deps.lazyDemoManager();
  if (demoManager?.isRecording) {
    const velocity = e.dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(e.playerVel, 0.5);
    p.demoProjectileId = demoManager.recordProjectileFired(
      { x: _spawnOrigin.x, y: _spawnOrigin.y, z: _spawnOrigin.z },
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
  // see the shot (all weapons, weaponType selects their visual config).
  // The claim MUST carry the same inherited-velocity flight the
  // Projectile sim runs — omitting playerVel*0.5 makes the server's
  // arcBlockedAt replay a slower, undeflected arc that clips walls the
  // real shell cleared ("flight blocked" rejects on honest hits).
  const velocity = e.dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(e.playerVel, 0.5);
  // NetProbe: claimed-vs-flown drift — must stay ~0 or the server's
  // arc replay diverges (the 'flight blocked' phantom-reject class).
  spawnDrift(velocity.distanceTo(p.vel));
  if (serverSimmed(config.weaponType)) {
    // Claimless path: the intent is all we send — the server spawns its
    // own authoritative shell and echoes shotId on projectileCreated,
    // which linkOwnProjectile binds to this predicted shell. Contact
    // and blast outcomes arrive as broadcasts; nothing is claimed here.
    // quiet = one pellet of a burst fan: the pull sends ONE intent and
    // the server fans the whole spread itself, echoing a pellet index.
    if (!quiet) {
      deps.lazyNetworkManager().sendShotFired({
        weaponType: config.weaponType,
        dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
        pos: { x: _spawnOrigin.x, y: _spawnOrigin.y, z: _spawnOrigin.z },
        shotId: p.shotId ?? undefined,
      });
    }
    return p;
  }
  deps.lazyNetworkManager().sendShot({
    targetId: null, // no target yet
    position: { x: _spawnOrigin.x, y: _spawnOrigin.y, z: _spawnOrigin.z },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
    weaponType: config.weaponType,
    shotId: p.shotId ?? undefined,
    // Trigger-time stamp — the server's fire-window escape hatch compares
    // client-side spacing, and wire compression (batching/backlog drain)
    // otherwise makes two legal shots arrive inside one window.
    timestamp: Date.now(),
  });
  return p;
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
  conc: CONC_CONFIG,
  remoterailgun: REMOTE_RAILGUN_CONFIG,
  armornade: ARMORNADE_CONFIG,
  proxy: PROXY_CONFIG,
  satchel: SATCHEL_CONFIG,
  heal: HEALNADE_CONFIG,
};

function onBelt(deps: CombatDeps, _e: FireArgs, item: BeltItem): void {
  const p = deps.lazyPlayer();
  // Ordnance economy: a dry belt can't throw — server enforces the same
  // rule on the spawn claim, this gate just saves the animation/no-op.
  const config = BELT_THROWS[item] ?? BELT_DISC_CONFIG;
  const cost = beltThrowCost(config.weaponType);
  if (p.beltCharges < cost) {return;}
  // Some throws are a deliberate plant, not a flick — the anim stretch and
  // the release delay must agree or the bomb leaves the hand early.
  const timeScale = BELT_THROW_TIME[item] ?? 1;
  deps.lazyViewModel()?.startThrow(timeScale);
  // Dying mid wind-up must not release — the server rejects dead-player
  // claims, leaving a local ghost projectile.
  setTimeout(() => {
    const pl = deps.lazyPlayer();
    if (pl.isDead || pl.beltCharges < cost) {return;}
    pl.beltCharges -= cost;
    // The javelin's juice is the THROW — a speedline whip on release so a
    // spear leaving the hand reads as force, not a lob.
    if (item === 'javelin') {deps.lazySpeedLines?.().burst();}
    spawnProjectile(deps, config, freshFireArgs(deps));
  }, THROW_RELEASE * timeScale * 1000);
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
  if (_flakRight.lengthSq() < 1e-8) {_flakRight.set(1, 0, 0);} else {_flakRight.normalize();}
  _flakUp.crossVectors(_flakRight, e.dir);
  // Simmed fans ride ONE intent per pull — the server fans the spread
  // itself and echoes pellet indices, so each predicted pellet registers
  // under its own `${pullId}#${idx}` slot for the echo bind.
  const simmed = serverSimmed(config.weaponType);
  const pullId = simmed ? `s${++deps.world.projectileRegistry.seq}` : '';
  const registry = deps.world.projectileRegistry;
  let i = 0;
  for (const pt of pts) {
    const ox = (pt.x * cs - pt.y * sn) * spread;
    const oy = (pt.x * sn + pt.y * cs) * spread;
    _flakDir.copy(e.dir)
      .addScaledVector(_flakRight, ox)
      .addScaledVector(_flakUp, oy)
      .normalize();
    const p = spawnProjectile(deps, config, { origin: e.origin, dir: _flakDir.clone(), playerVel: e.playerVel }, true);
    if (p && simmed) {
      p.fanSlot = `${pullId}#${i}`;
      registry.byFanSlot.set(p.fanSlot, p);
    }
    i++;
  }
  if (simmed) {
    deps.lazyNetworkManager().sendShotFired({
      weaponType: config.weaponType,
      dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
      pos: { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      shotId: pullId,
    });
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
    if (_flakRight.lengthSq() < 1e-8) {_flakRight.set(1, 0, 0);} else {_flakRight.normalize();}
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
function meleeSwingFx(deps: CombatDeps, e: FireArgs, fxPos: THREE.Vector3, groundHit: THREE.Vector3 | null, landed: boolean): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  deps.lazyViewModel()?.punch(landed); // landed = apex hold — the hit-pose dwell
  deps.world.explosions.push(new Explosion(
    deps.lazyScene(), fxPos, true, 0, deps.lazyTerrain(),
    (stats.aoeRadius * 0.7) / EXPLOSION_VFX_RADIUS, 0xAADDFF, 'punch',
  ));
  screenShake.blast(fxPos, stats.aoeRadius, player.pos);
  if (groundHit) {
    if (deps.world.scorches.length >= SCORCH_MAX) {deps.world.scorches.shift()!.dispose();}
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
  deps.lazySpeedLines?.().surge(player.pos, fxPos, 0xAADDFF, 8);
  // The slash arc — the actual "swing" read. Hit or whiff, every punch
  // sweeps an X of billboarded streaks across the view (~0.16s); without
  // it a mid-air swing was just a faint puff. Pinned to the camera so it
  // doesn't lag behind at speed; the camera kicks along with it.
  swingSwipeView(deps.lazyScene(), deps.lazyCamera());
  screenShake.swingKick(1, landed);
}

// Melee sweep — the arc check happens around a point pushed forward
// centered ahead of the fist so the puncher is outside its own radius.
function melee(deps: CombatDeps, hooks: FireHooks, e: FireArgs): void {
  const player = deps.lazyPlayer();
  const stats = getWeaponStats(WeaponType.Melee);
  sfx.shoot(WeaponType.Melee);
  player.lastFireAt = performance.now(); // decloak-on-fire — see spawnProjectile
  _meleeHitPos.copy(player.pos).addScaledVector(e.dir, MELEE_RANGE * 0.7);

  const groundHit = meleeGroundContact(player.pos, e.dir, deps.lazyTerrain());

  let connected: THREE.Vector3 | null = null;
  for (const t of deps.targets) {
    if (t.dead) {continue;}
    _meleeToT.copy(t.pos).sub(player.pos);
    const dist = _meleeToT.length();
    if (dist > MELEE_RANGE + (t.hitRadius ?? t.radius)) {continue;}
    _meleeToT.divideScalar(dist || 1);
    if (_meleeToT.dot(e.dir) < MELEE_ARC_DOT) {continue;}
    t.applyKnockback(player.pos, stats.knockbackForce);
    deps.lazyDamageNumbers().spawn(t.pos, MELEE_DAMAGE, '#aaddff', deps.lazyCamera());
    deps.reportTargetDamage?.(t, MELEE_DAMAGE);
    if (t.takeDamage(MELEE_DAMAGE)) {hooks.onTargetDestroyed(t, t.vel, WeaponType.Melee);}
    else if (!t.hideHealthBar) {deps.lazyHealthBarSystem().spawnBall(t, MELEE_DAMAGE, t.health);}
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
      lifeMin: 0.12, lifeMax: 0.35, sizeScale: 1,
      colA: [0.6, 0.85, 1], colB: [0.3, 0.5, 0.9], additive: true,
    });
    screenShake.add(0.22);
  }

  // Swing FX after hit detection — `landed` picks the connect variant
  // (apex dwell + deeper camera kick) same frame the input resolved.
  meleeSwingFx(deps, e, groundHit ?? _meleeHitPos, groundHit, connected !== null);

  // The swing intent rides shotFired — the server derives the arc point
  // itself (no position claim) and relays the fire for observers.
  const networkManager = deps.lazyNetworkManager();
  if (networkManager?.isConnected()) {
    networkManager.sendShotFired({
      weaponType: WeaponType.Melee, dir: { x: e.dir.x, y: e.dir.y, z: e.dir.z },
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
