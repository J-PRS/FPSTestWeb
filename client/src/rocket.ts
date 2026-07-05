import * as THREE from 'three';
import { Terrain } from './terrain.js';
import type { Ball } from './balls.js';
import { GRAVITY, PLAYER_RADIUS, PLAYER_HEIGHT, CAPSULE_HALF_HEIGHT, CAPSULE_CENTER_Y, ROCKET_SPEED, ROCKET_RADIUS, ROCKET_BODY_RADIUS, ROCKET_FORCE, HIT_MIN, HIT_MAX, HIT_GROW } from './config.js';
import { ChildLogger } from './Logger.js';

const logger = new ChildLogger('Rocket');

interface TrailParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseSize: number;
}

const TRAIL_PARTICLES_PER_UNIT = 2; // particle density along travel path
const TRAIL_LIFE_MIN = 1.2;
const TRAIL_LIFE_MAX = 1.8;
const TRAIL_SPREAD   = 0.25;  // lateral spawn spread
const TRAIL_RAMP_IN  = 0.1;   // seconds for emitter to reach full size
const MESH_RAMP_IN   = 0.2;   // seconds for mesh to reach full size
const MESH_START_SCALE = 0.2; // starting scale for rocket mesh
const TRAIL_GEO = new THREE.SphereGeometry(1, 8, 6);

// Gradient colors: orange → red → brown → smoke
const TRAIL_COLORS = [
  new THREE.Color(1.0, 0.7, 0.1),   // bright orange
  new THREE.Color(1.0, 0.4, 0.0),   // red-orange
  new THREE.Color(0.8, 0.2, 0.1),   // deep red
  new THREE.Color(0.5, 0.25, 0.2),  // brown
  new THREE.Color(0.35, 0.35, 0.4), // smoke grey
];

/**
 * Wake Hit Distance Tracking Logic:
 *
 * Rockets have two hit detection zones:
 * 1. Core (direct hit): Rocket center passes through target's actual radius
 * 2. Wake (proxy hit): Rocket center passes through expanding wake radius (grows from 0.3 to 8.0 over 2 seconds)
 *
 * Problem: If wake radius grazes target from front, it could trigger before core hit registers,
 *          causing direct hits to be missed.
 *
 * Solution: Track minimum distance to each target. Only trigger wake hit when distance starts
 *           increasing (projectile has passed the target). This allows core hits to register
 *           first if the rocket continues approaching.
 *
 * Example:
 * - Frame 1: Wake enters zone, distance=5.0, minDist=5.0 (approaching, no trigger)
 * - Frame 2: Distance=3.0, minDist=3.0 (still approaching, no trigger)
 * - Frame 3: Core hit at distance=1.2 (direct hit triggers, rocket explodes)
 *
 * Without core hit:
 * - Frame 1: Wake enters zone, distance=5.0, minDist=5.0 (approaching, no trigger)
 * - Frame 2: Distance=3.0, minDist=3.0 (still approaching, no trigger)
 * - Frame 3: Distance=4.0, minDist=3.0 (increasing! wake hit triggers)
 */
export class Rocket {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
  age = 0.0;
  isRemote = false; // true for server-authoritative remote rockets
  hitBall: Ball | null = null;
  hitPlayerId: string | null = null;
  serverProjectileId: string | null = null; // remote player hit
  hitAccuracy  = 0.0;  // actual center-to-center dist at moment of hit
  hitAge       = 0.0;  // rocket age at hit (airtime)
  hitDistance  = 0.0;  // travel distance from shot origin
  directHit    = false; // true = hit with core hitbox, false = expanding wake hitbox
  minHitDist   = 0.0;  // minimum distance during sweep (for accurate accuracy)
  readonly explosionRadius = ROCKET_RADIUS;
  readonly knockbackForce = ROCKET_FORCE;

  // Wake hit tracking: only trigger when distance increases (projectile passed target)
  private wakeBallDistances = new Map<Ball, number>(); // ball -> min distance seen
  private wakePlayerDistances = new Map<string, number>(); // playerId -> min distance seen

  get hitRadius(): number {
    const t = Math.min(this.age / HIT_GROW, 1.0);
    return HIT_MIN + (HIT_MAX - HIT_MIN) * t;
  }

  private scene: THREE.Scene;
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private glowMesh: THREE.Mesh;
  private glowMat: THREE.MeshBasicMaterial;
  private prevPos: THREE.Vector3;
  private shotOrigin: THREE.Vector3;

  // Particle trail
  private particles: TrailParticle[] = [];
  private trailAccum = 0; // fractional carry-over for even particle spacing
  private projectileRemoved = false;
  private disposed = false;
  public explosionProcessed = false;

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3) {
    this.scene = scene;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    // 50% player velocity inheritance (Tribes Ascend style)
    this.vel = dir.clone().normalize().multiplyScalar(ROCKET_SPEED).addScaledVector(playerVel, 0.5);

    const geo = new THREE.CylinderGeometry(0.08, ROCKET_BODY_RADIUS, 0.7, 6);
    geo.rotateX(Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffdd44 });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);

    // Additive glow shell that grows with hitRadius
    const glowGeo = new THREE.SphereGeometry(1.0, 6, 6);
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.18, depthWrite: false });
    this.glowMesh = new THREE.Mesh(glowGeo, this.glowMat);
    this.glowMesh.position.copy(this.pos);
    scene.add(this.glowMesh);

  }

  // Swept sphere terrain check: sample along path, step size = visual radius
  private sweepTerrain(terrain: Terrain): boolean {
    const STEP = 0.5;
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      if (sy <= terrain.getHeight(sx, sz) + HIT_MIN) return true;
    }
    return false;
  }

  // Swept sphere vs ball — checks core (direct) then expanding (wake) hitbox
  private sweepBall(ball: Ball): boolean {
    const STEP = 0.1; // smaller step for precise core hit detection
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    const coreThresh  = ball.radius + ROCKET_BODY_RADIUS; // direct hit = rocket body overlaps ball body
    const wakeThresh  = ball.radius + this.hitRadius; // expanding wake
    let minDist = Infinity;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      const ex = sx - ball.pos.x, ey = sy - ball.pos.y, ez = sz - ball.pos.z;
      const d2 = ex*ex + ey*ey + ez*ez;
      const d = Math.sqrt(d2);
      if (d < minDist) minDist = d;

      // Direct hit - immediate
      if (d2 <= coreThresh * coreThresh) {
        this.minHitDist = minDist;
        this.directHit = true;
        return true;
      }

      // Wake hit - track distance, only trigger when increasing
      if (d2 <= wakeThresh * wakeThresh) {
        const prevMin = this.wakeBallDistances.get(ball) ?? Infinity;
        if (d < prevMin) {
          // Getting closer, update min distance
          this.wakeBallDistances.set(ball, d);
        } else if (d > prevMin) {
          // Distance increasing - projectile passed target, trigger wake hit
          this.minHitDist = minDist;
          this.directHit = false;
          return true;
        }
      }
    }

    // In wake but distance never increased (still approaching) - don't trigger yet
    return false;
  }

  // True continuous sphere sweep vs player capsule
  // playerPos is the FEET position; capsule center is at feet + CAPSULE_CENTER_Y
  private sweepPlayer(playerPos: THREE.Vector3, playerId: string): boolean {
    const centerY = playerPos.y + CAPSULE_CENTER_Y;

    // Rocket path vector
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const pathLenSq = dx*dx + dy*dy + dz*dz;

    if (pathLenSq === 0) {
      // No movement, check static distance to capsule center line
      const hx = this.pos.x - playerPos.x;
      const hz = this.pos.z - playerPos.z;
      const hDist = Math.sqrt(hx*hx + hz*hz);
      const vy = this.pos.y - centerY;
      const clampedY = Math.max(-CAPSULE_HALF_HEIGHT, Math.min(CAPSULE_HALF_HEIGHT, vy));
      const yDelta = vy - clampedY;
      const totalDist = Math.sqrt(hx*hx + yDelta*yDelta + hz*hz);

      const directThresh = PLAYER_RADIUS + ROCKET_BODY_RADIUS; // player radius + rocket body radius
      if (totalDist <= PLAYER_RADIUS + this.hitRadius) {
        this.minHitDist = totalDist;
        this.directHit = totalDist <= directThresh; // direct hit = rocket body overlaps player body
        return true;
      }
      return false;
    }

    // Proper sphere-capsule sweep:
    // 1. Find closest point on rocket segment to capsule center line
    // 2. Clamp to capsule height to handle hemispherical ends
    // 3. Check distance at that point

    // Project player center onto rocket path
    const px = playerPos.x - this.prevPos.x;
    const py = centerY - this.prevPos.y;
    const pz = playerPos.z - this.prevPos.z;
    const t = (px*dx + py*dy + pz*dz) / pathLenSq;
    const tClamped = Math.max(0, Math.min(1, t));

    // Closest point on rocket segment
    const closestX = this.prevPos.x + dx * tClamped;
    const closestY = this.prevPos.y + dy * tClamped;
    const closestZ = this.prevPos.z + dz * tClamped;

    // Vector from closest point to capsule center
    const vx = closestX - playerPos.x;
    const vy = closestY - centerY;
    const vz = closestZ - playerPos.z;

    // Distance to capsule center line segment:
    // Clamp Y to cylinder half-height, then measure from clamped point to actual point
    const clampedY = Math.max(-CAPSULE_HALF_HEIGHT, Math.min(CAPSULE_HALF_HEIGHT, vy));
    const yDelta = vy - clampedY; // 0 when inside cylinder, grows when above/below

    // Horizontal distance
    const hDist = Math.sqrt(vx*vx + vz*vz);

    // Total distance from closest point on rocket path to closest point on capsule center line
    const totalDist = Math.sqrt(vx*vx + yDelta*yDelta + vz*vz);

    const directThresh = PLAYER_RADIUS + ROCKET_BODY_RADIUS; // player radius + rocket body radius
    if (totalDist <= PLAYER_RADIUS + this.hitRadius) {
      this.minHitDist = totalDist;

      // Direct hit — rocket body overlaps player body (not just proximity)
      if (totalDist <= directThresh) {
        this.directHit = true;
        const dist = this.pos.distanceTo(playerPos);
        console.log(
          `[Rocket] DIRECT HIT on ${playerId}\n` +
          `  Projectile pos: (${this.pos.x.toFixed(2)}, ${this.pos.y.toFixed(2)}, ${this.pos.z.toFixed(2)})\n` +
          `  Player pos:     (${playerPos.x.toFixed(2)}, ${playerPos.y.toFixed(2)}, ${playerPos.z.toFixed(2)})\n` +
          `  Distance: ${dist.toFixed(2)} | hDist: ${hDist.toFixed(2)} | totalDist: ${totalDist.toFixed(2)}`
        );
        return true;
      }

      // Wake hit - track distance, only trigger when increasing
      const prevMin = this.wakePlayerDistances.get(playerId) ?? Infinity;
      if (totalDist < prevMin) {
        // Getting closer, update min distance
        this.wakePlayerDistances.set(playerId, totalDist);
        return false; // Don't trigger yet
      } else if (totalDist > prevMin) {
        // Distance increasing - projectile passed target, trigger wake hit
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
      this.vel.y += GRAVITY * dt;
      this.pos.addScaledVector(this.vel, dt);

      // Remote (server-authoritative) rockets skip all collision — server decides lifetime
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
            this.hitBall     = ball;
            // Calculate surface-to-surface distance (center distance minus ball radius)
            this.hitAccuracy = Math.max(0, this.minHitDist - ball.radius);
            this.hitAge      = this.age;
            this.hitDistance = this.pos.distanceTo(this.shotOrigin);
            this.explode();
            return;
          }
        }
      }

      // Check collision with remote players
      if (remotePlayers) {
        for (const [playerId, playerPos] of remotePlayers) {
          if (this.sweepPlayer(playerPos, playerId)) {
            this.hitPlayerId = playerId;
            // Calculate surface-to-surface distance (center distance minus player radius)
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
    this.glowMesh.position.copy(this.pos);
    this.glowMesh.scale.setScalar(this.hitRadius);
    const meshRamp = MESH_START_SCALE + (1.0 - MESH_START_SCALE) * Math.min(this.age / MESH_RAMP_IN, 1.0);
    this.mesh.scale.setScalar(meshRamp);
    if (this.vel.lengthSq() > 0.01) {
      this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.vel.clone().normalize());
    }
  }

  private emitTrailSegment(): void {
    const trailDist = this.pos.distanceTo(this.prevPos);
    if (trailDist < 1e-6) return;
    const spacing = 1 / TRAIL_PARTICLES_PER_UNIT;
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

    // Robust orthogonal basis calculation for consistent particle spread
    const arbitrary = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(dir, arbitrary).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();

    const emitterRamp = Math.min(this.age / TRAIL_RAMP_IN, 1.0);

    const u = (Math.random() - 0.5) * TRAIL_SPREAD * emitterRamp;
    const v = (Math.random() - 0.5) * TRAIL_SPREAD * emitterRamp;
    const w = (Math.random() - 0.5) * 0.2 * emitterRamp;
    const offset = new THREE.Vector3()
      .addScaledVector(right, u)
      .addScaledVector(up, v)
      .addScaledVector(dir, w);
    const pos = spawnPos.clone().add(offset);

    // Particles stay in place with minimal drift
    const drift = new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);
    const vel = drift;

    const life = TRAIL_LIFE_MIN + Math.random() * (TRAIL_LIFE_MAX - TRAIL_LIFE_MIN);
    const size = (0.08 + Math.random() * 0.25) * emitterRamp;
    this.particles.push(this.spawnTrailParticle(pos, vel, life, size));
  }

  private spawnTrailParticle(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): TrailParticle {
    const mat = new THREE.MeshBasicMaterial({
      color: TRAIL_COLORS[0],
      transparent: true,
      opacity: 0.4,
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
      p.vel.y += GRAVITY * 0.02 * dt;
      
      // Color gradient interpolation
      const gradientT = ft;
      const colorIdx = gradientT * (TRAIL_COLORS.length - 1);
      const idx0 = Math.floor(colorIdx);
      const idx1 = Math.min(idx0 + 1, TRAIL_COLORS.length - 1);
      const blend = colorIdx - idx0;
      const c0 = TRAIL_COLORS[idx0];
      const c1 = TRAIL_COLORS[idx1];
      p.mat.color.setRGB(
        c0.r + (c1.r - c0.r) * blend,
        c0.g + (c1.g - c0.g) * blend,
        c0.b + (c1.b - c0.b) * blend
      );
      
      p.mat.opacity = t * 0.4;
      p.mesh.scale.setScalar(p.baseSize * (0.6 + 1.2 * ft)); // grow as they cool
    }
  }

  private removeProjectileMesh(): void {
    if (this.projectileRemoved) return;
    this.scene.remove(this.mesh);
    this.mat.dispose();
    this.scene.remove(this.glowMesh);
    this.glowMat.dispose();
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
