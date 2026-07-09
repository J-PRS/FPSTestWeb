import * as THREE from 'three';
import { Terrain } from '../terrain.js';
import type { Ball } from '../balls.js';
import { PLAYER_RADIUS, CAPSULE_HALF_HEIGHT, CAPSULE_CENTER_Y } from '../config.js';
import { ChildLogger } from '../Logger.js';
import type { ProjectileConfig } from './types.js';

const logger = new ChildLogger('Projectile');

interface TrailParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseSize: number;
}

const TRAIL_GEO = new THREE.SphereGeometry(1, 8, 6);

/**
 * Wake Hit Distance Tracking Logic:
 *
 * Projectiles have two hit detection zones:
 * 1. Core (direct hit): center passes through target's actual radius
 * 2. Wake (proxy hit): center passes through expanding wake radius
 *
 * Track minimum distance to each target. Only trigger wake hit when distance
 * starts increasing (projectile has passed the target). This allows core hits
 * to register first if the projectile continues approaching.
 */
export class Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
  age = 0.0;
  isRemote = false; // true for server-authoritative/demo projectiles
  hitBall: Ball | null = null;
  hitPlayerId: string | null = null;
  serverProjectileId: string | null = null; // remote player hit tracking
  demoProjectileId = 0; // demo recording tracking ID
  hitAccuracy = 0.0; // actual center-to-center dist at moment of hit
  hitAge = 0.0; // projectile age at hit (airtime)
  hitDistance = 0.0; // travel distance from shot origin
  directHit = false; // true = hit with core hitbox, false = expanding wake hitbox
  minHitDist = 0.0; // minimum distance during sweep (for accurate accuracy)
  explosionProcessed = false;

  readonly config: ProjectileConfig;

  // Wake hit tracking: only trigger when distance increases (projectile passed target)
  private wakeBallDistances = new Map<Ball, number>(); // ball -> min distance seen
  private wakePlayerDistances = new Map<string, number>(); // playerId -> min distance seen

  get hitRadius(): number {
    const t = Math.min(this.age / this.config.hitGrow, 1.0);
    return this.config.hitMin + (this.config.hitMax - this.config.hitMin) * t;
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

  // Particle trail
  private particles: TrailParticle[] = [];
  private trailAccum = 0; // fractional carry-over for even particle spacing
  private projectileRemoved = false;
  private disposed = false;

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3, config: ProjectileConfig) {
    this.scene = scene;
    this.config = config;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    // 50% player velocity inheritance (Tribes Ascend style)
    this.vel = dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(playerVel, 0.5);

    if (config.meshType === 'disc') {
      // Disc geometry: flat cylinder - default faces Y, orient to velocity
      const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
      this.mat = new THREE.MeshBasicMaterial({ color: config.meshColor });
      this.mesh = new THREE.Mesh(geo, this.mat);
      this.mesh.position.copy(this.pos);
      scene.add(this.mesh);
    } else {
      // Rocket (or other forward-facing) geometry: cone-like cylinder
      const geo = new THREE.CylinderGeometry(0.08, config.bodyRadius, 0.7, 6);
      geo.rotateX(Math.PI / 2);
      this.mat = new THREE.MeshBasicMaterial({ color: config.meshColor });
      this.mesh = new THREE.Mesh(geo, this.mat);
      this.mesh.position.copy(this.pos);
      scene.add(this.mesh);

      if (config.glowShell) {
        const glowGeo = new THREE.SphereGeometry(1.0, 6, 6);
        this.glowMat = new THREE.MeshBasicMaterial({ color: config.glowColor, transparent: true, opacity: config.glowOpacity, depthWrite: false });
        this.glowMesh = new THREE.Mesh(glowGeo, this.glowMat);
        this.glowMesh.position.copy(this.pos);
        scene.add(this.glowMesh);
      }
    }
  }

  // Swept sphere terrain check: sample along path, step size = visual radius
  private sweepTerrain(terrain: Terrain): boolean {
    const STEP = 0.5;
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      if (sy <= terrain.getHeight(sx, sz) + this.config.terrainOffset) return true;
    }
    return false;
  }

  // Swept sphere vs ball — checks core (direct) then expanding (wake) hitbox
  private sweepBall(ball: Ball): boolean {
    const STEP = 0.1; // smaller step for precise core hit detection
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    const coreThresh = ball.radius + this.config.bodyRadius; // direct hit = body overlaps target
    const wakeThresh = ball.radius + this.hitRadius; // expanding wake
    let minDist = Infinity;
    let passedCenter = false; // Track if we've passed the ball's center

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      const ex = sx - ball.pos.x, ey = sy - ball.pos.y, ez = sz - ball.pos.z;
      const d2 = ex * ex + ey * ey + ez * ez;
      const d = Math.sqrt(d2);
      if (d < minDist) minDist = d;

      // Direct hit - immediate
      if (d2 <= coreThresh * coreThresh) {
        this.minHitDist = minDist;
        this.directHit = true;
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
          return true;
        }
      }

      // Check if we've passed the center (dot product of velocity and direction to ball)
      if (i > 0) {
        const prevT = (i - 1) / steps;
        const prevSx = this.prevPos.x + dx * prevT;
        const prevSy = this.prevPos.y + dy * prevT;
        const prevSz = this.prevPos.z + dz * prevT;
        const prevEx = prevSx - ball.pos.x;
        const prevEy = prevSy - ball.pos.y;
        const prevEz = prevSz - ball.pos.z;
        const prevD2 = prevEx * prevEx + prevEy * prevEy + prevEz * prevEz;

        // If distance is increasing, we've passed the closest point
        if (d2 > prevD2) {
          passedCenter = true;
        }
      }
    }

    return false;
  }

  // True continuous sphere sweep vs player capsule
  // playerPos is the FEET position; capsule center is at feet + CAPSULE_CENTER_Y
  private sweepPlayer(playerPos: THREE.Vector3, playerId: string): boolean {
    const centerY = playerPos.y + CAPSULE_CENTER_Y;

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
        return true;
      }

      const prevMin = this.wakePlayerDistances.get(playerId) ?? Infinity;
      if (totalDist < prevMin) {
        this.wakePlayerDistances.set(playerId, totalDist);
        return false;
      } else if (totalDist > prevMin) {
        this.directHit = false;
        logger.debug(`Wake hit at dist ${totalDist.toFixed(2)}, threshold ${(PLAYER_RADIUS + this.hitRadius).toFixed(2)}`);
        return true;
      }
    }

    return false;
  }

  update(dt: number, terrain: Terrain, balls?: Ball[], remotePlayers?: Map<string, THREE.Vector3>): void {
    if (this.dead) return;

    if (!this.exploded) {
      this.prevPos.copy(this.pos);
      this.age += dt;
      this.vel.y += this.config.gravity * dt;
      this.pos.addScaledVector(this.vel, dt);

      // Remote (server-authoritative/demo) projectiles skip all collision
      if (this.isRemote) {
        this.updateMesh();
        this.emitTrailSegment();
        this.updateTrail(dt);
        return;
      }

      if (this.sweepTerrain(terrain)) {
        this.explode();
        return;
      }

      if (balls) {
        for (const ball of balls) {
          if (ball.dead) continue;
          if (this.sweepBall(ball)) {
            this.hitBall = ball;
            this.hitAccuracy = Math.max(0, this.minHitDist - ball.radius);
            this.hitAge = this.age;
            this.hitDistance = this.pos.distanceTo(this.shotOrigin);
            this.explode();
            return;
          }
        }
      }

      if (remotePlayers) {
        for (const [playerId, playerPos] of remotePlayers) {
          if (this.sweepPlayer(playerPos, playerId)) {
            this.hitPlayerId = playerId;
            this.hitAccuracy = Math.max(0, this.minHitDist - PLAYER_RADIUS);
            this.hitAge = this.age;
            this.hitDistance = this.pos.distanceTo(this.shotOrigin);
            this.explode();
            return;
          }
        }
      }

      this.updateMesh();
      this.emitTrailSegment();
    }

    if (this.exploded && !this.projectileRemoved) this.removeProjectileMesh();
    this.updateTrail(dt);

    if (this.exploded && this.particles.length === 0) {
      this.dead = true;
    }
  }

  private updateMesh(): void {
    this.mesh.position.copy(this.pos);
    if (this.glowMesh) {
      this.glowMesh.position.copy(this.pos);
      this.glowMesh.scale.setScalar(this.hitRadius);
    }

    const scale = this.config.meshRampIn
      ? this.config.meshStartScale + (1.0 - this.config.meshStartScale) * Math.min(this.age / this.config.meshRampInDuration, 1.0)
      : 1.0;
    this.mesh.scale.setScalar(scale);

    if (this.vel.lengthSq() > 0.01) {
      const velDir = this.vel.clone().normalize();
      if (this.config.meshType === 'disc') {
        const target = this.pos.clone().add(velDir);
        this.mesh.lookAt(target);
      } else {
        this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), velDir);
      }
    }
  }

  private emitTrailSegment(): void {
    const trailDist = this.pos.distanceTo(this.prevPos);
    if (trailDist < 1e-6) return;
    const spacing = 1 / this.config.trailParticlesPerUnit;
    this.trailAccum += trailDist;
    while (this.trailAccum >= spacing) {
      this.trailAccum -= spacing;
      const t = 1 - this.trailAccum / trailDist;
      const spawnPos = this.prevPos.clone().lerp(this.pos, Math.max(0, Math.min(1, t)));
      this.emitTrail(spawnPos);
    }
  }

  private emitTrail(spawnPos: THREE.Vector3): void {
    const dir = this.vel.lengthSq() > 0.0001
      ? this.vel.clone().normalize()
      : new THREE.Vector3(0, 1, 0);

    const arbitrary = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(dir, arbitrary).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();

    const emitterRamp = this.config.trailRampIn > 0 ? Math.min(this.age / this.config.trailRampIn, 1.0) : 1.0;

    const u = (Math.random() - 0.5) * this.config.trailSpread * emitterRamp;
    const v = (Math.random() - 0.5) * this.config.trailSpread * emitterRamp;
    const w = (Math.random() - 0.5) * this.config.trailForwardSpread * emitterRamp;
    const offset = new THREE.Vector3()
      .addScaledVector(right, u)
      .addScaledVector(up, v)
      .addScaledVector(dir, w);
    const pos = spawnPos.clone().add(offset);

    const drift = new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);
    const vel = drift;

    const life = this.config.trailLifeMin + Math.random() * (this.config.trailLifeMax - this.config.trailLifeMin);
    const size = (this.config.trailBaseSize + Math.random() * this.config.trailSizeRange) * emitterRamp;
    this.particles.push(this.spawnTrailParticle(pos, vel, life, size));
  }

  private spawnTrailParticle(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): TrailParticle {
    const mat = new THREE.MeshBasicMaterial({
      color: this.config.trailColors[0],
      transparent: true,
      opacity: this.config.trailOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(TRAIL_GEO, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);
    return { mesh, mat, vel, life, maxLife: life, baseSize: size };
  }

  private updateTrail(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const t = p.life / p.maxLife;
      const ft = 1 - t;

      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.y += this.config.trailParticleGravity * dt;

      const colors = this.config.trailColors;
      const gradientT = ft;
      const colorIdx = gradientT * (colors.length - 1);
      const idx0 = Math.floor(colorIdx);
      const idx1 = Math.min(idx0 + 1, colors.length - 1);
      const blend = colorIdx - idx0;
      const c0 = colors[idx0];
      const c1 = colors[idx1];
      p.mat.color.setRGB(
        c0.r + (c1.r - c0.r) * blend,
        c0.g + (c1.g - c0.g) * blend,
        c0.b + (c1.b - c0.b) * blend
      );

      p.mat.opacity = t * this.config.trailOpacity;
      p.mesh.scale.setScalar(p.baseSize * (this.config.trailScaleMin + (this.config.trailScaleMax - this.config.trailScaleMin) * ft));
    }
  }

  private removeProjectileMesh(): void {
    if (this.projectileRemoved) return;
    this.scene.remove(this.mesh);
    this.mat.dispose();
    if (this.glowMesh) {
      this.scene.remove(this.glowMesh);
      this.glowMat?.dispose();
    }
    this.projectileRemoved = true;
  }

  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    this.removeProjectileMesh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.removeProjectileMesh();
    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      p.mat.dispose();
    }
    this.particles.length = 0;
    this.disposed = true;
  }
}
