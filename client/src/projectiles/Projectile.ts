import * as THREE from 'three';

import { PLAYER_RADIUS } from '../core/config.js';
import { hitRadiusAt } from '../../../shared/combat.js';

import type { Targetable } from '../entities/balls.js';

import { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';
import * as sfx from '../core/sfx.js';
import { RibbonTrail } from './RibbonTrail.js';
import { ProjectileTrail } from './trailParticles.js';
import { buildProjectileMeshes, updateProjectileMesh } from './visuals.js';
import { sweepTerrain, sweepBall, sweepPlayer, sweepObstacle } from './sweep.js';

// Shared projectile geometries — dispose() never frees them, so reuse across shots
const _tNormal = new THREE.Vector3();
const _rayDir = new THREE.Vector3();


/**
 * Projectile: client-authoritative hitscan-like projectile with swept collision.
 *
 * Per-frame movement advances the projectile by `vel * dt`. After each move, a
 * swept check is performed against terrain, balls, and remote players. The
 * sweep steps from the previous position to the new position to avoid tunneling
 * through fast-moving targets.
 *
 * Hit detection uses two concentric thresholds:
 *  1. Core (direct hit): distance <= target radius + projectile body radius.
 *     This is the "real" collision and always takes precedence over a wake
 *     hit when encountered within the same sweep.
 *  2. Wake (proxy hit): distance <= target radius + expanding hit radius.
 *     The hit radius grows over the projectile's lifetime (see `hitRadius`),
 *     giving a wider, forgiving hitbox for near misses.
 *
 * Wake hit logic:
 *  - The projectile stores the minimum distance it has ever seen to each target
 *    in `wakeBallDistances` / `wakePlayerDistances`. These maps persist across
 *    frames for the life of the projectile.
 *  - A wake hit is meant to trigger when the projectile has passed the target
 *    and is moving away (distance increasing from the recorded minimum).
 *  - However, because the minimum is stored across frames, a moving target can
 *    leave a stale minimum. If the projectile re-approaches the target while
 *    still outside the core, the old check `d > prevMin` would fire a wake
 *    hit prematurely, before the projectile could reach the core.
 *  - To prevent this, `passedCenter` is recomputed each sweep. It is set when
 *    the current step is farther than the immediately previous step, meaning
 *    the projectile has passed the closest point of this sweep. Wake hits are
 *    only allowed once `d > prevMin` AND `passedCenter` is true.
 *
 * On impact, the projectile records `hitBall`, `directHit`, `hitAccuracy`, etc.,
 * marks itself `exploded`, and the visual effect is handled elsewhere.
 *
 * Trail/wake particle visuals live in trailParticles.ts (TrailHost interface).
 * (Not a bug: `hitRadius` starts at `hitMin`=0 by design — it's the expanding
 *  WAKE threshold, not the direct-hit radius, and a fresh projectile must not
 *  whack its own shooter. Core hits use the constant `bodyRadius`.)
 */
// Anything swept-collidable that ISN'T a damageable target — currently
// turretter bolts. prevPos = start-of-frame pos so the check is
// segment-vs-segment (both objects moved this frame).
export interface SweepObstacle {
  readonly pos: THREE.Vector3;
  readonly prevPos: THREE.Vector3;
  readonly radius: number;
}

export class Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
  hitBolt: SweepObstacle | null = null; // mid-air interception — combat turns this into a cookoff blast
  age = 0.0;
  spawnedThisFrame = true; // skip first update so projectile renders at spawn pos before moving
  isRemote = false; // true for server-authoritative/demo projectiles
  hitBall: Targetable | null = null; // balls AND crawlers — any shootable target
  hitPlayerId: string | null = null;
  serverProjectileId: string | null = null; // remote player hit tracking
  demoProjectileId = 0; // demo recording tracking ID
  hitAccuracy = 0.0; // actual center-to-center dist at moment of hit
  hitAge = 0.0; // projectile age at hit (airtime)
  hitDistance = 0.0; // travel distance from shot origin
  directHit = false; // true = hit with core hitbox, false = expanding wake hitbox
  minHitDist = 0.0; // minimum distance during sweep (for accurate accuracy)
  readonly hitPoint = new THREE.Vector3(); // exact sweep intersection (set by sweepTerrain)
  hitPointValid = false;
  explosionProcessed = false;
  // Sticky: froze to a surface — physics off, fuse still burning. The
  // blast is what hurts people, not the glue point.
  stuck = false;

  // Ray-burst (remote railgun): at rayBurst.delay the slug discharges a
  // hitscan beam down its velocity line — implemented as one giant swept
  // step so terrain/target/obstacle collision applies to the beam itself.
  // Terminal: hit or miss, the slug is spent at the end of the segment.
  private rayFired = false;
  private rayDone = false;
  private readonly rayFrom = new THREE.Vector3();
  /** Visual/sfx hook — fired once at discharge with (beam origin, end). */
  onRayBurst: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;

  readonly config: ProjectileConfig;
  // Random tumble axis for 'ball' projectiles — fixed per shot
  private readonly tumbleX = Math.random() * 2 - 1;
  private readonly tumbleY = Math.random() * 2 - 1;
  private readonly tumbleZ = Math.random() * 2 - 1;

  // Wake hit tracking: only trigger when distance increases (projectile passed target)
  // (public: the sweep functions in sweep.ts read/write them)
  readonly wakeBallDistances = new Map<Targetable, number>(); // target -> min distance seen
  readonly wakePlayerDistances = new Map<string, number>(); // playerId -> min distance seen

  // Wake-proxy radius — shared/combat.ts so the server's hit-claim
  // validation computes the exact same number from the reported airtime.
  get hitRadius(): number {
    return hitRadiusAt(this.config.weaponType, this.age);
  }

  get explosionRadius(): number { return this.config.explosionRadius; }
  get force(): number { return this.config.force; }
  get forceMode(): 'push' | 'pull' { return this.config.forceMode; }

  private scene: THREE.Scene;
  private mesh: THREE.Mesh;
  private glowMesh: THREE.Mesh | null = null;
  readonly prevPos: THREE.Vector3; // start-of-frame pos — sweeps step prevPos→pos
  private shotOrigin: THREE.Vector3;

  // Particle trail — emission, pooling, fade-out all live in ProjectileTrail
  private trail: ProjectileTrail;
  private projectileRemoved = false;
  private disposed = false;
  private ribbons: RibbonTrail[] = [];

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3, config: ProjectileConfig) {
    this.scene = scene;
    this.config = config;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    // 50% player velocity inheritance (Tribes Ascend style)
    this.vel = dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(playerVel, 0.5);

    const v = buildProjectileMeshes(scene, config, this.pos);
    this.mesh = v.mesh;
    this.glowMesh = v.glowMesh;

    this.trail = new ProjectileTrail({
      scene, config,
      pos: this.pos, prevPos: this.prevPos, vel: this.vel,
      age: () => this.age,
      hitRadius: () => this.hitRadius,
    });

    this.ribbons = v.ribbons;
  }

  // Swept collision math lives in sweep.ts (SweepHost) — the checks are
  // free functions so they're testable without a scene-bound projectile.

  update(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[]): void {
    if (this.dead) return;

    // First frame: just render at spawn position, don't apply physics yet
    if (this.spawnedThisFrame) {
      this.spawnedThisFrame = false;
      this.updateMesh();
      return;
    }

    if (!this.exploded) this.updateAlive(dt, terrain, balls, remotePlayers, obstacles);

    // Discharge aftermath: beam visual fires once with the resolved
    // endpoint (swept hitPoint on a hit, range cap on a miss), then the
    // slug detonates there. Lives in update() so early returns inside
    // updateAlive can't skip it.
    if (this.rayFired && !this.rayDone) {
      this.rayDone = true;
      this.onRayBurst?.(this.rayFrom, this.hitPointValid ? this.hitPoint : this.pos);
      if (!this.exploded) this.explode();
    }

    if (this.exploded && !this.projectileRemoved) this.removeProjectileMesh();
    for (const r of this.ribbons) r.update(dt);
    this.trail.update(dt);

    if (this.exploded && this.trail.empty && this.ribbons.every(r => r.done)) {
      this.dead = true;
    }
  }

  // Teleport the projectile forward along its velocity without physics steps —
  // used to compensate remote-spawn latency so it appears where it really is
  advanceBy(seconds: number): void {
    this.prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, seconds);
    this.age += seconds;
    if (this.mesh) this.mesh.position.copy(this.pos);
  }

  // Physics + collision + visuals for a live (non-exploded) projectile
  private updateAlive(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[]): void {
    this.prevPos.copy(this.pos);
    this.lastDt = dt;
    this.age += dt;

    // Stuck bomb: planted on a surface, ticking down to fuse. No physics,
    // no collision — only the timer matters.
    if (this.stuck) {
      if (this.config.maxLifetime && this.age >= this.config.maxLifetime) this.explode();
      else this.updateMesh();
      return;
    }
    // hitPoint is per-frame: a stale value from a previous bounce would
    // teleport the explosion back to the last terrain contact (the
    // "explosion in the wrong spot" bug on fuse/ball/player kills)
    this.hitPointValid = false;
    this.vel.y += this.config.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);

    // Fuse: auto-explode if max lifetime is reached
    if (this.config.maxLifetime && this.age >= this.config.maxLifetime) {
      this.explode();
      return;
    }

    // Ray-burst discharge: the rest of this frame's travel is the beam —
    // prevPos stays at the discharge point so the swept segment covers the
    // whole ray. Applies to remote replicas too: delay/direction/range are
    // all deterministic from spawn state, like bounces.
    if (this.config.rayBurst && !this.rayFired && this.age >= this.config.rayBurst.delay) {
      this.rayFired = true;
      this.rayFrom.copy(this.pos);
      _rayDir.copy(this.vel).normalize();
      this.prevPos.copy(this.pos);
      this.pos.addScaledVector(_rayDir, this.config.rayBurst.range);
    }

    // Remote (server-authoritative/demo) projectiles skip all collision.
    // Exception: bouncing shells (GL) still bounce off terrain — the bounce
    // is deterministic from spawn state, so it matches the shooter's arc
    // and keeps remote shells from tunneling through the ground.
    if (this.isRemote) {
      // A discharged beam still respects terrain — the sweep sets hitPoint
      // so update() pops the slug at contact, not at the range cap.
      if (this.rayFired) sweepTerrain(this, terrain);
      if (this.canBounce && sweepTerrain(this, terrain) && !this.bounceOffTerrain(terrain)) {
        this.explode(); // bounce budget/graze exhausted — die like a local shard
        return;
      }
      if (!this.canBounce && this.config.armTime !== undefined && sweepTerrain(this, terrain)) {
        this.explode(); // armed mortar shell touching terrain on a remote client
        return;
      }
      // Remote stickies glue identically — the fuse clock is the shared
      // truth, so both sides pop at the same age regardless of contact.
      if (this.config.sticks && sweepTerrain(this, terrain)) this.stickAt(this.hitPoint);
    } else if (this.checkCollisions(terrain, balls, remotePlayers, obstacles)) {
      return; // exploded inside checkCollisions
    }

    this.updateMesh();
    this.trail.emitSegment();
    for (const r of this.ribbons) r.push(this.pos, this.vel);
  }

  // Runs all swept collision checks; returns true if the projectile hit
  // something and exploded (records hit target + accuracy data).
  private checkCollisions(terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>, obstacles?: SweepObstacle[]): boolean {
    if (sweepTerrain(this, terrain)) {
      // arming fuse (T2 mortar): bounces only apply BEFORE the shell is armed
      if (this.canBounce && this.bounceOffTerrain(terrain)) {
        return false; // bounced — still live, fuse keeps running
      }
      if (this.config.sticks) {
        this.stickAt(this.hitPoint);
        return true;
      }
      this.explode();
      return true;
    }
    // Obstacles (turret bolts) before targets: an interception is the
    // earliest contact worth reporting — the blast usually takes the
    // enemy anyway, and the cookoff is the interesting outcome.
    return this.checkObstacles(obstacles) || this.checkBalls(balls) || this.checkPlayers(remotePlayers);
  }

  private checkObstacles(obstacles?: SweepObstacle[]): boolean {
    // Hitscan shells carry no payload — a slug can't cook off a warhead.
    if (!obstacles || this.config.noExplosion) return false;
    let best: SweepObstacle | null = null, bestT = Infinity;
    for (const o of obstacles) {
      if (sweepObstacle(this, o) && this.hitT < bestT) { best = o; bestT = this.hitT; }
    }
    if (!best) return false;
    // Re-run the winning sweep so hitPoint/hitT describe ITS contact, not
    // a later bolt's — hitAt was overwritten by each tested obstacle.
    sweepObstacle(this, best);
    this.hitBolt = best;
    if (this.config.sticks) {
      // Shot down mid-flight — cook off on the spot, the bolt eats the pop.
      this.explode();
      return true;
    }
    this.explode();
    return true;
  }

  // dt of the currently-running update — recordHit uses it to back the
  // reported hitAge off to the actual swept contact point, not end-of-frame.
  private lastDt = 0;

  // Reflect velocity off the heightfield normal at hitPoint. Returns false
  // when the impact was too weak to bounce — caller should treat it as a
  // detonation instead of letting the shell sink or jitter in place.
  private bouncesTaken = 0;
  private get armed(): boolean {
    return this.config.armTime === undefined || this.age >= this.config.armTime;
  }

  // GL/flak shells always bounce; a mortar only bounces while unarmed —
  // once armed it's impact-fused like any other shell.
  get canBounce(): boolean {
    return !!this.config.bounces && (this.config.armTime === undefined || !this.armed);
  }

  private bounceOffTerrain(terrain: Terrain): boolean {
    if (this.config.maxBounces !== undefined && ++this.bouncesTaken > this.config.maxBounces) {
      return false; // out of bounces — treat as impact
    }
    const e = 0.5;
    const x = this.hitPoint.x, z = this.hitPoint.z;
    _tNormal.set(
      -(terrain.getHeight(x + e, z) - terrain.getHeight(x - e, z)) / (2 * e),
      1,
      -(terrain.getHeight(x, z + e) - terrain.getHeight(x, z - e)) / (2 * e)
    ).normalize();

    const vn = this.vel.dot(_tNormal);
    // hitPoint is already the center AT the collision plane (radius above
    // the surface for bouncers) — depenetration just needs a small normal
    // clearance so the next sweep doesn't instantly retrigger on slopes.
    const depenetrate = this.config.terrainOffset + 0.05;
    // Grazing/resting contact: armed shells detonate; unarmed (mortar
    // pre-arm) shells bleed off the normal component and slide until the
    // fuse arms them — the T2 mortar bounces off dirt before it can pop.
    if (vn >= -2) {
      if (this.armed) return false;
      this.vel.addScaledVector(_tNormal, -vn);
      this.pos.copy(this.hitPoint).addScaledVector(_tNormal, depenetrate);
      this.prevPos.copy(this.pos);
      if (this.config.bounceSfx) sfx.at(this.pos, this.config.bounceSfx, 0.5, 1.4);
      return true;
    }
    this.vel.addScaledVector(_tNormal, -(1 + (this.config.bounceRestitution ?? 0.5)) * vn);
    const fr = this.config.bounceFriction ?? 0.7;
    this.vel.x *= fr;
    this.vel.z *= fr;
    // Sit just above the surface so the next sweep doesn't immediately retrigger
    this.pos.copy(this.hitPoint).addScaledVector(_tNormal, depenetrate);
    this.prevPos.copy(this.pos);
    if (this.config.bounceSfx) {
      // Harder hits ping louder; weak grazes stay quiet — sells mass.
      const gain = Math.min(1, -vn / 40);
      sfx.at(this.pos, `ricochet${1 + Math.floor(Math.random() * 3)}`, gain);
    }
    return true;
  }

  private checkBalls(balls?: Targetable[]): boolean {
    if (!balls) return false;
    for (const ball of balls) {
      if (ball.dead) continue;
      if (sweepBall(this, ball)) {
        this.recordHit(this.minHitDist - ball.radius);
        this.hitBall = ball;
        if (this.config.sticks) {
          // Glued to the target's contact point — fuse keeps burning and
          // the blast catches it. (Tracking a moving ball mid-stick is
          // wasted fidelity; it won't outrun 11m of splash.)
          this.stickAt(this.hitPoint);
          return true;
        }
        this.explode();
        return true;
      }
    }
    return false;
  }

  private checkPlayers(remotePlayers?: Map<string, THREE.Vector3>): boolean {
    if (!remotePlayers) return false;
    for (const [playerId, playerPos] of remotePlayers) {
      if (sweepPlayer(this, playerPos, playerId)) {
        this.recordHit(this.minHitDist - PLAYER_RADIUS);
        this.hitPlayerId = playerId;
        if (this.config.sticks) {
          this.stickAt(this.hitPoint);
          return true;
        }
        this.explode();
        return true;
      }
    }
    return false;
  }

  // Contact point along this frame's sweep + its parametric position
  // (0=prevPos, 1=pos). Hit distance/airtime come from here, not the
  // already-integrated end-of-frame pos — a fast shell could overshoot the
  // target by meters inside one frame and inflate the hit score/claim.
  private hitX = 0; private hitY = 0; private hitZ = 0; private hitT = 1;
  hitAt(x: number, y: number, z: number, t: number): void {
    this.hitX = x; this.hitY = y; this.hitZ = z; this.hitT = t;
    // Also the detonation point — combat renders the blast at hitPoint when
    // valid, so target hits (not just terrain) explode at contact, not at
    // the overshot end-of-frame position.
    this.hitPoint.set(x, y, z);
    this.hitPointValid = true;
  }

  private recordHit(minDist: number): void {
    this.hitAccuracy = Math.max(0, minDist);
    this.hitAge = this.age - this.lastDt * (1 - this.hitT);
    const dx = this.hitX - this.shotOrigin.x;
    const dy = this.hitY - this.shotOrigin.y;
    const dz = this.hitZ - this.shotOrigin.z;
    this.hitDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Mesh ramp-in: every projectile pops in small and grows to full size —
  // a 1.6m cannonball spawning at your face shouldn't fill half the screen
  // for a frame. Config overrides via meshStartScale/meshRampInDuration;
  // meshRampIn === false opts out. Duration capped at 40% of maxLifetime
  // so a 0.4s shotgun pellet still snaps to size fast.


  private updateMesh(): void {
    updateProjectileMesh(this.mesh, this.glowMesh, this.pos, this.vel,
      this.config, this.age, this.hitRadius,
      { x: this.tumbleX, y: this.tumbleY, z: this.tumbleZ }, this.lastDt);
  }

  private removeProjectileMesh(): void {
    if (this.projectileRemoved) return;
    this.scene.remove(this.mesh);
    // mat/glowMat are cache-shared — never dispose
    if (this.glowMesh) {
      this.scene.remove(this.glowMesh);
    }
    this.projectileRemoved = true;
  }

  /** Plant the bomb at a contact point — motion and sweeps stop, the
   *  fuse doesn't. */
  private stickAt(p: THREE.Vector3): void {
    this.stuck = true;
    this.pos.copy(p);
    this.prevPos.copy(p);
    this.vel.set(0, 0, 0);
    this.updateMesh();
  }

  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    this.removeProjectileMesh();
    for (const r of this.ribbons) r.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeProjectileMesh();
    for (const r of this.ribbons) r.dispose(this.scene);
    this.trail.dispose();
    this.disposed = true;
    // Mark dead so a mass-dispose (demo teardown) can't leave a live object
    // updating — update loops key off `dead`, not `disposed`.
    this.dead = true;
  }
}
