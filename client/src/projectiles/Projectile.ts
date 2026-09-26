import * as THREE from 'three';

import { PLAYER_RADIUS, CAPSULE_HALF_HEIGHT, CAPSULE_CENTER_Y, EYE_OFFSET, BLOOM_LAYER } from '../core/config.js';
import { hitRadiusAt } from '../../../shared/combat.js';

import { ChildLogger } from '../core/Logger.js';

import type { Targetable } from '../entities/balls.js';

import { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';
import { RibbonTrail } from './RibbonTrail.js';
import { ProjectileTrail } from './trailParticles.js';

const logger = new ChildLogger('Projectile');

// Shared projectile geometries — dispose() never frees them, so reuse across shots
const _velDir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _FORWARD = new THREE.Vector3(0, 0, 1);
const _tNormal = new THREE.Vector3();

const MESH_GEO_CACHE = new Map<string, THREE.BufferGeometry>();
// Projectile materials are never mutated after construction — share per color
// so rapid fire doesn't create/dispose a material every shot
const BODY_MAT_CACHE = new Map<number, THREE.MeshBasicMaterial>();
const GLOW_MAT_CACHE = new Map<string, THREE.MeshBasicMaterial>();
const GLOW_GEO = new THREE.SphereGeometry(1.0, 12, 12);

function getBodyMat(color: number): THREE.MeshBasicMaterial {
  let m = BODY_MAT_CACHE.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); BODY_MAT_CACHE.set(color, m); }
  return m;
}

function getGlowMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = `${color}|${opacity}`;
  let m = GLOW_MAT_CACHE.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }); GLOW_MAT_CACHE.set(key, m); }
  return m;
}
function getMeshGeo(meshType: string, bodyRadius: number): THREE.BufferGeometry {
  const key = `${meshType}:${bodyRadius}`;
  let geo = MESH_GEO_CACHE.get(key);
  if (!geo) {
    if (meshType === 'disc') {
      geo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
    } else {
      geo = new THREE.CylinderGeometry(0.08, bodyRadius, 0.7, 6);
      geo.rotateX(Math.PI / 2);
    }
    MESH_GEO_CACHE.set(key, geo);
  }
  return geo;
}

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
 * Known issues / TODOs (see _reports/projectile-implementation-review.md):
 *  - `sweepTerrain` samples the projectile center and uses a fixed step of 0.5,
 *    which may tunnel through terrain for small `terrainOffset` values.
 *  - `hitRadius` scales from `hitMin` to `hitMax` over `hitGrow` seconds (can be 0 at spawn).
 *    Trail/wake particle visuals live in trailParticles.ts (TrailHost interface).
 */
export class Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
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

  readonly config: ProjectileConfig;

  // Wake hit tracking: only trigger when distance increases (projectile passed target)
  private wakeBallDistances = new Map<Targetable, number>(); // target -> min distance seen
  private wakePlayerDistances = new Map<string, number>(); // playerId -> min distance seen

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
  private mat: THREE.MeshBasicMaterial;
  private glowMesh: THREE.Mesh | null = null;
  private glowMat: THREE.MeshBasicMaterial | null = null;
  private prevPos: THREE.Vector3;
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

    const geo = getMeshGeo(config.meshType, config.bodyRadius);
    this.mat = getBodyMat(config.meshColor); // shared — never mutated
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(this.pos);
    this.mesh.layers.enable(BLOOM_LAYER);
    scene.add(this.mesh);

    if (config.glowShell) {
      this.glowMat = getGlowMat(config.glowColor, config.glowOpacity); // shared
      this.glowMesh = new THREE.Mesh(GLOW_GEO, this.glowMat);
      this.glowMesh.position.copy(this.pos);
      this.glowMesh.layers.enable(BLOOM_LAYER);
      scene.add(this.glowMesh);
    }

    this.trail = new ProjectileTrail({
      scene, config,
      pos: this.pos, prevPos: this.prevPos, vel: this.vel,
      age: () => this.age,
      hitRadius: () => this.hitRadius,
    });

    if (config.ribbonTrail) {
      const color = config.ribbonColor ?? config.trailColors[0].getHex();
      const width = config.ribbonWidth ?? 0.5;
      const life = config.ribbonLife ?? 0.3;
      // 3 lanes: wide outer band + thin bright core pair offset above/below —
      // reads as a glowing energy streak with depth instead of a flat line
      const coreColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.6).getHex();
      if (config.ribbonLanes === 1) {
        this.ribbons = [RibbonTrail.acquire(scene, color, width, life)];
      } else {
        this.ribbons = [
          RibbonTrail.acquire(scene, color, width, life),
          RibbonTrail.acquire(scene, coreColor, width * 0.35, life * 0.8, width * 0.07),
          RibbonTrail.acquire(scene, coreColor, width * 0.35, life * 0.8, -width * 0.07),
        ];
      }
    }
  }

  // Swept sphere terrain check: sample along path, step size = visual radius.
  // On hit, refines the crossing point by bisection and stores it in hitPoint.
  private sweepTerrain(terrain: Terrain): boolean {
    const STEP = 0.5;
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    const below = (t: number) => {
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      return sy <= terrain.getHeight(sx, sz) + this.config.terrainOffset;
    };
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (below(t)) {
        // Bisect between last above-ground sample and this one
        let lo = Math.max(0, (i - 1) / steps), hi = t;
        for (let k = 0; k < 5; k++) {
          const mid = (lo + hi) / 2;
          if (below(mid)) hi = mid; else lo = mid;
        }
        this.hitPoint.set(
          this.prevPos.x + dx * hi,
          this.prevPos.y + dy * hi,
          this.prevPos.z + dz * hi
        );
        this.hitPointValid = true;
        return true;
      }
    }
    return false;
  }

  // Swept sphere vs ball — checks core (direct) then expanding (wake) hitbox
  private sweepBall(ball: Targetable): boolean {
    const STEP = 0.1; // smaller step for precise core hit detection
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    const coreThresh = ball.radius + this.config.bodyRadius; // direct hit = body overlaps target
    const wakeThresh = ball.radius + this.hitRadius; // expanding wake
    let minDist = Infinity;
    let prevD2 = Infinity;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      // Capsule targets: distance to a segment, not a point.
      //  capsuleTop (Totem) — vertical, feet to feet+height
      //  capsuleEnd (Miner) — centered, pos ± heading-aligned half-extent
      let ex: number, ey: number, ez: number;
      if (ball.capsuleEnd) {
        const e = ball.capsuleEnd;
        const eLen2 = e.lengthSq() || 1;
        const proj = Math.max(-1, Math.min(1,
          ((sx - ball.pos.x) * e.x + (sy - ball.pos.y) * e.y + (sz - ball.pos.z) * e.z) / eLen2));
        ex = sx - (ball.pos.x + e.x * proj);
        ey = sy - (ball.pos.y + e.y * proj);
        ez = sz - (ball.pos.z + e.z * proj);
      } else {
        const capTop = ball.capsuleTop ? ball.pos.y + ball.capsuleTop : ball.pos.y;
        const cy = Math.max(ball.pos.y, Math.min(capTop, sy));
        ex = sx - ball.pos.x; ey = sy - cy; ez = sz - ball.pos.z;
      }
      const d2 = ex * ex + ey * ey + ez * ez;
      const d = Math.sqrt(d2);
      if (d < minDist) minDist = d;

      // Passed center when distance increases from the previous step
      const passedCenter = i > 0 && d2 > prevD2;

      // Direct hit - immediate
      if (d2 <= coreThresh * coreThresh) {
        this.minHitDist = minDist;
        this.directHit = true;
        this.hitAt(sx, sy, sz, t);
        return true;
      }

      // Wake hit - track distance, only trigger when passed center and moving away
      if (d2 <= wakeThresh * wakeThresh) {
        const prevMin = this.wakeBallDistances.get(ball) ?? Infinity;
        if (d < prevMin) {
          this.wakeBallDistances.set(ball, d);
        } else if (d > prevMin && passedCenter) {
          // Only trigger wake hit if we've passed the center (distance increasing after minimum)
          this.minHitDist = minDist;
          this.directHit = false;
          this.hitAt(sx, sy, sz, t);
          return true;
        }
      }

      prevD2 = d2;
    }

    return false;
  }

  // True continuous sphere sweep vs player capsule
  // playerPos is the networked EYE position (feet + EYE_OFFSET);
  // capsule center is at feet + CAPSULE_CENTER_Y
  private sweepPlayer(playerPos: THREE.Vector3, playerId: string): boolean {
    const centerY = playerPos.y - EYE_OFFSET + CAPSULE_CENTER_Y;

    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const pathLenSq = dx * dx + dy * dy + dz * dz;

    if (pathLenSq === 0) {
      const hx = this.pos.x - playerPos.x;
      const hz = this.pos.z - playerPos.z;
      const vy = this.pos.y - centerY;
      const clampedY = Math.max(-CAPSULE_HALF_HEIGHT, Math.min(CAPSULE_HALF_HEIGHT, vy));
      const yDelta = vy - clampedY;
      const totalDist = Math.sqrt(hx * hx + yDelta * yDelta + hz * hz);

      const directThresh = PLAYER_RADIUS + this.config.bodyRadius;
      if (totalDist <= PLAYER_RADIUS + this.hitRadius) {
        this.minHitDist = totalDist;
        this.directHit = totalDist <= directThresh;
        this.hitAt(this.pos.x, this.pos.y, this.pos.z, 1);
        return true;
      }
      return false;
    }

    const px = playerPos.x - this.prevPos.x;
    const py = centerY - this.prevPos.y;
    const pz = playerPos.z - this.prevPos.z;
    const t = (px * dx + py * dy + pz * dz) / pathLenSq;
    const tClamped = Math.max(0, Math.min(1, t));

    const closestX = this.prevPos.x + dx * tClamped;
    const closestY = this.prevPos.y + dy * tClamped;
    const closestZ = this.prevPos.z + dz * tClamped;

    const vx = closestX - playerPos.x;
    const vy = closestY - centerY;
    const vz = closestZ - playerPos.z;

    const clampedY = Math.max(-CAPSULE_HALF_HEIGHT, Math.min(CAPSULE_HALF_HEIGHT, vy));
    const yDelta = vy - clampedY;

    const totalDist = Math.sqrt(vx * vx + yDelta * yDelta + vz * vz);

    const directThresh = PLAYER_RADIUS + this.config.bodyRadius;
    if (totalDist <= PLAYER_RADIUS + this.hitRadius) {
      this.minHitDist = totalDist;

      if (totalDist <= directThresh) {
        this.directHit = true;
        this.hitAt(closestX, closestY, closestZ, tClamped);
        return true;
      }

      // Only consider wake hit if we've passed the closest point on the path
      const passedCenter = pathLenSq === 0 || t <= 1.0;
      const prevMin = this.wakePlayerDistances.get(playerId) ?? Infinity;
      if (totalDist < prevMin) {
        this.wakePlayerDistances.set(playerId, totalDist);
        return false;
      } else if (totalDist > prevMin && passedCenter) {
        this.directHit = false;
        logger.debug(`Wake hit at dist ${totalDist.toFixed(2)}, threshold ${(PLAYER_RADIUS + this.hitRadius).toFixed(2)}`);
        this.hitAt(closestX, closestY, closestZ, tClamped);
        return true;
      }
    }

    return false;
  }

  update(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>): void {
    if (this.dead) return;

    // First frame: just render at spawn position, don't apply physics yet
    if (this.spawnedThisFrame) {
      this.spawnedThisFrame = false;
      this.updateMesh();
      return;
    }

    if (!this.exploded) this.updateAlive(dt, terrain, balls, remotePlayers);

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
  private updateAlive(dt: number, terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>): void {
    this.prevPos.copy(this.pos);
    this.lastDt = dt;
    this.age += dt;
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

    // Remote (server-authoritative/demo) projectiles skip all collision.
    // Exception: bouncing shells (GL) still bounce off terrain — the bounce
    // is deterministic from spawn state, so it matches the shooter's arc
    // and keeps remote shells from tunneling through the ground.
    if (this.isRemote) {
      if (this.canBounce && this.sweepTerrain(terrain) && !this.bounceOffTerrain(terrain)) {
        this.explode(); // bounce budget/graze exhausted — die like a local shard
        return;
      }
      if (!this.canBounce && this.config.armTime !== undefined && this.sweepTerrain(terrain)) {
        this.explode(); // armed mortar shell touching terrain on a remote client
        return;
      }
    } else if (this.checkCollisions(terrain, balls, remotePlayers)) {
      return; // exploded inside checkCollisions
    }

    this.updateMesh();
    this.trail.emitSegment();
    for (const r of this.ribbons) r.push(this.pos, this.vel);
  }

  // Runs all swept collision checks; returns true if the projectile hit
  // something and exploded (records hit target + accuracy data).
  private checkCollisions(terrain: Terrain, balls?: Targetable[], remotePlayers?: Map<string, THREE.Vector3>): boolean {
    if (this.sweepTerrain(terrain)) {
      // arming fuse (T2 mortar): bounces only apply BEFORE the shell is armed
      if (this.canBounce && this.bounceOffTerrain(terrain)) {
        return false; // bounced — still live, fuse keeps running
      }
      this.explode();
      return true;
    }
    return this.checkBalls(balls) || this.checkPlayers(remotePlayers);
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
  private get canBounce(): boolean {
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
    // Grazing/resting contact: armed shells detonate; unarmed (mortar
    // pre-arm) shells bleed off the normal component and slide until the
    // fuse arms them — the T2 mortar bounces off dirt before it can pop.
    if (vn >= -2) {
      if (this.armed) return false;
      this.vel.addScaledVector(_tNormal, -vn);
      this.pos.copy(this.hitPoint).addScaledVector(_tNormal, this.config.terrainOffset + 0.05);
      this.prevPos.copy(this.pos);
      return true;
    }
    this.vel.addScaledVector(_tNormal, -(1 + (this.config.bounceRestitution ?? 0.5)) * vn);
    const fr = this.config.bounceFriction ?? 0.7;
    this.vel.x *= fr;
    this.vel.z *= fr;
    // Sit just above the surface so the next sweep doesn't immediately retrigger
    this.pos.copy(this.hitPoint).addScaledVector(_tNormal, this.config.terrainOffset + 0.05);
    this.prevPos.copy(this.pos);
    return true;
  }

  private checkBalls(balls?: Targetable[]): boolean {
    if (!balls) return false;
    for (const ball of balls) {
      if (ball.dead) continue;
      if (this.sweepBall(ball)) {
        this.recordHit(this.minHitDist - ball.radius);
        this.hitBall = ball;
        this.explode();
        return true;
      }
    }
    return false;
  }

  private checkPlayers(remotePlayers?: Map<string, THREE.Vector3>): boolean {
    if (!remotePlayers) return false;
    for (const [playerId, playerPos] of remotePlayers) {
      if (this.sweepPlayer(playerPos, playerId)) {
        this.recordHit(this.minHitDist - PLAYER_RADIUS);
        this.hitPlayerId = playerId;
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
  private hitAt(x: number, y: number, z: number, t: number): void {
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

  private updateMesh(): void {
    this.mesh.position.copy(this.pos);
    if (this.glowMesh) {
      this.glowMesh.position.copy(this.pos);
      // Glow scales with hitRadius (wake hitbox) so they always match
      const glowMultiplier = this.config.glowScale ?? 1.0;
      this.glowMesh.scale.setScalar(this.hitRadius * glowMultiplier);
    }

    const scale = this.config.meshRampIn
      ? this.config.meshStartScale + (1.0 - this.config.meshStartScale) * Math.min(this.age / this.config.meshRampInDuration, 1.0)
      : 1.0;
    this.mesh.scale.setScalar(scale);

    if (this.vel.lengthSq() > 0.01) {
      _velDir.copy(this.vel).normalize();
      if (this.config.meshType === 'disc') {
        _lookTarget.copy(this.pos).add(_velDir);
        this.mesh.lookAt(_lookTarget);
      } else {
        this.mesh.quaternion.setFromUnitVectors(_FORWARD, _velDir);
      }
    }
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
