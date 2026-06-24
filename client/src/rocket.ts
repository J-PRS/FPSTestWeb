import * as THREE from 'three';
import { Terrain } from './terrain.js';
import type { Ball } from './balls.js';
import { GRAVITY, PLAYER_RADIUS, PLAYER_HEIGHT, ROCKET_SPEED, ROCKET_RADIUS, ROCKET_FORCE, HIT_MIN, HIT_MAX, HIT_GROW } from './config.js';
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

const TRAIL_INTERVAL = 0.015; // seconds between particle emission
const TRAIL_EMISSION = 6;     // particles per emission
const TRAIL_LIFE_MIN = 1.2;
const TRAIL_LIFE_MAX = 1.8;
const TRAIL_SPREAD   = 0.25;  // lateral spawn spread
const TRAIL_GEO = new THREE.SphereGeometry(1, 4, 4);

// Gradient colors: orange → red → brown → smoke
const TRAIL_COLORS = [
  new THREE.Color(1.0, 0.7, 0.1),   // bright orange
  new THREE.Color(1.0, 0.4, 0.0),   // red-orange
  new THREE.Color(0.8, 0.2, 0.1),   // deep red
  new THREE.Color(0.5, 0.25, 0.2),  // brown
  new THREE.Color(0.35, 0.35, 0.4), // smoke grey
];

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
  private trailTimer = 0;
  private particles: TrailParticle[] = [];
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

    const geo = new THREE.CylinderGeometry(0.08, 0.18, 0.7, 6);
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
    const coreThresh  = ball.radius + HIT_MIN; // small fixed core
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
      if (d2 <= coreThresh * coreThresh) {
        this.minHitDist = minDist;
        this.directHit = true;
        return true;
      }
      if (d2 <= wakeThresh * wakeThresh) {
        this.minHitDist = minDist;
        this.directHit = false;
        return true;
      }
    }
    return false;
  }

  // True continuous sphere sweep vs player capsule
  private sweepPlayer(playerPos: THREE.Vector3): boolean {
    const halfHeight = PLAYER_HEIGHT / 2;

    // Rocket path vector
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const pathLenSq = dx*dx + dy*dy + dz*dz;

    if (pathLenSq === 0) {
      // No movement, check static distance
      const hx = this.pos.x - playerPos.x;
      const hz = this.pos.z - playerPos.z;
      const hDist = Math.sqrt(hx*hx + hz*hz);
      const vy = this.pos.y - playerPos.y;
      const inHeightRange = vy >= -halfHeight && vy <= halfHeight;

      if (inHeightRange && hDist <= PLAYER_RADIUS + this.hitRadius) {
        this.minHitDist = hDist;
        this.directHit = hDist <= PLAYER_RADIUS + HIT_MIN;
        return true;
      }
      return false;
    }

    // Proper sphere-capsule sweep:
    // 1. Find closest point on rocket segment to capsule center line
    // 2. Clamp to capsule height to handle hemispherical ends
    // 3. Check distance at that point

    // Project player onto rocket path
    const px = playerPos.x - this.prevPos.x;
    const py = playerPos.y - this.prevPos.y;
    const pz = playerPos.z - this.prevPos.z;
    const t = (px*dx + py*dy + pz*dz) / pathLenSq;
    const tClamped = Math.max(0, Math.min(1, t));

    // Closest point on rocket segment
    const closestX = this.prevPos.x + dx * tClamped;
    const closestY = this.prevPos.y + dy * tClamped;
    const closestZ = this.prevPos.z + dz * tClamped;

    // Vector from closest point to player
    const vx = closestX - playerPos.x;
    const vy = closestY - playerPos.y;
    const vz = closestZ - playerPos.z;

    // Clamp Y to capsule height (this handles the hemispherical ends)
    const clampedY = Math.max(-halfHeight, Math.min(halfHeight, vy));

    // Horizontal distance after Y clamping
    const hx = vx;
    const hz = vz;
    const hDist = Math.sqrt(hx*hx + hz*hz);

    // Total distance (accounting for Y clamping)
    const totalDist = Math.sqrt(hx*hx + clampedY*clampedY + hz*hz);

    if (totalDist <= PLAYER_RADIUS + this.hitRadius) {
      this.minHitDist = hDist;

      // Core hit (direct hit)
      if (hDist <= PLAYER_RADIUS + HIT_MIN) {
        this.directHit = true;
        logger.debug(`Core hit at dist ${hDist.toFixed(2)}, playerPos: ${playerPos.x.toFixed(1)},${playerPos.y.toFixed(1)},${playerPos.z.toFixed(1)}`);
        return true;
      }

      // Wake hit (expanding hitbox)
      this.directHit = false;
      logger.debug(`Wake hit at dist ${hDist.toFixed(2)}, threshold ${(PLAYER_RADIUS + this.hitRadius).toFixed(2)}`);
      return true;
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
        this.mesh.position.copy(this.pos);
        this.glowMesh.position.copy(this.pos);
        this.glowMesh.scale.setScalar(this.hitRadius);
        if (this.vel.lengthSq() > 0.01) {
          this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.vel.clone().normalize());
        }
        this.trailTimer += dt;
        while (this.trailTimer >= TRAIL_INTERVAL) {
          this.trailTimer -= TRAIL_INTERVAL;
          this.emitTrail();
        }
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
          if (this.sweepPlayer(playerPos)) {
            this.hitPlayerId = playerId;
            // Calculate surface-to-surface distance (center distance minus player radius)
            this.hitAccuracy = Math.max(0, this.minHitDist - 0.8); // PLAYER_RADIUS = 0.8
            this.hitAge = this.age;
            this.hitDistance = this.pos.distanceTo(this.shotOrigin);
            this.explode();
            return;
          }
        }
      }

      this.mesh.position.copy(this.pos);
      this.glowMesh.position.copy(this.pos);
      this.glowMesh.scale.setScalar(this.hitRadius);

      // Align mesh to velocity
      const velDir = this.vel.clone().normalize();
      if (this.vel.lengthSq() > 0.01) {
        this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), velDir);
      }

      // Emit particle trail
      this.trailTimer += dt;
      while (this.trailTimer >= TRAIL_INTERVAL) {
        this.trailTimer -= TRAIL_INTERVAL;
        this.emitTrail();
      }
    }

    if (this.exploded && !this.projectileRemoved) this.removeProjectileMesh();

    this.updateTrail(dt);

    if (this.exploded && this.particles.length === 0) {
      this.dead = true;
    }
  }

  private emitTrail(): void {
    const dir = this.vel.lengthSq() > 0.0001
      ? this.vel.clone().normalize()
      : new THREE.Vector3(0, 1, 0);

    let right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 0.01) right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(1, 0, 0));
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();

    for (let i = 0; i < TRAIL_EMISSION; i++) {
      const u = (Math.random() - 0.5) * TRAIL_SPREAD;
      const v = (Math.random() - 0.5) * TRAIL_SPREAD;
      const w = (Math.random() - 0.5) * 0.2;
      const offset = new THREE.Vector3()
        .addScaledVector(right, u)
        .addScaledVector(up, v)
        .addScaledVector(dir, w);
      const pos = this.pos.clone().addScaledVector(dir, -0.5).add(offset);

      // Particles stay in place with minimal drift
      const drift = new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);
      const vel = drift;

      const life = TRAIL_LIFE_MIN + Math.random() * (TRAIL_LIFE_MAX - TRAIL_LIFE_MIN);
      const size = 0.08 + Math.random() * 0.25; // more size variation
      this.particles.push(this.spawnTrailParticle(pos, vel, life, size));
    }
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
