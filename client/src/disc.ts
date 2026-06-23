import * as THREE from 'three';
import { Terrain } from './terrain.js';
import type { Ball } from './balls.js';
import { PLAYER_RADIUS, PLAYER_HEIGHT, DISC_SPEED, DISC_RADIUS, DISC_FORCE, DISC_HITBOX } from './config.js';
import { ChildLogger } from './Logger.js';

const logger = new ChildLogger('Disc');

const TRAIL_INTERVAL = 0.02;
const TRAIL_EMISSION = 3;
const TRAIL_LIFE_MIN = 0.8;
const TRAIL_LIFE_MAX = 1.2;
const TRAIL_SPEED = 10;
const TRAIL_SPREAD = 0.2;
const TRAIL_GEO = new THREE.SphereGeometry(1, 4, 4);

// Blue/cyan gradient for disc trail
const TRAIL_COLORS = [
  new THREE.Color(0.0, 0.8, 1.0),   // bright cyan
  new THREE.Color(0.0, 0.5, 0.9),   // medium blue
  new THREE.Color(0.0, 0.3, 0.7),   // deep blue
  new THREE.Color(0.2, 0.2, 0.5),   // purple-grey
];

interface TrailParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseSize: number;
}

export class Disc {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  exploded = false;
  age = 0.0;
  hitBall: Ball | null = null;
  hitPlayerId: string | null = null;
  minHitDist = 0.0;
  hitAccuracy = 0.0;
  hitAge = 0.0;
  hitDistance = 0.0;
  readonly explosionRadius = DISC_RADIUS;
  readonly pullForce = DISC_FORCE; // reverse knockback
  public explosionProcessed = false;

  private scene: THREE.Scene;
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private prevPos: THREE.Vector3;
  private shotOrigin: THREE.Vector3;
  private trailTimer = 0;
  private particles: TrailParticle[] = [];
  private projectileRemoved = false;
  private disposed = false;

  constructor(scene: THREE.Scene, origin: THREE.Vector3, dir: THREE.Vector3, playerVel: THREE.Vector3) {
    this.scene = scene;
    this.pos = origin.clone();
    this.prevPos = origin.clone();
    this.shotOrigin = origin.clone();
    // 50% player velocity inheritance (same as rocket)
    this.vel = dir.clone().normalize().multiplyScalar(DISC_SPEED).addScaledVector(playerVel, 0.5);

    // Disc geometry: flat cylinder - default has flat faces on XZ plane (facing Y)
    const geo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
  }

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
      if (sy <= terrain.getHeight(sx, sz) + 0.2) return true;
    }
    return false;
  }

  private sweepBall(ball: Ball): boolean {
    const STEP = 0.1;
    const dx = this.pos.x - this.prevPos.x;
    const dy = this.pos.y - this.prevPos.y;
    const dz = this.pos.z - this.prevPos.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const steps = Math.max(1, Math.ceil(dist / STEP));
    const thresh = ball.radius + DISC_HITBOX;
    let minDist = Infinity;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const sx = this.prevPos.x + dx * t;
      const sy = this.prevPos.y + dy * t;
      const sz = this.prevPos.z + dz * t;
      const ex = sx - ball.pos.x, ey = sy - ball.pos.y, ez = sz - ball.pos.z;
      const d = Math.sqrt(ex*ex + ey*ey + ez*ez);
      if (d < minDist) minDist = d;
      if (d <= thresh) {
        // Calculate surface-to-surface distance (center distance minus ball radius)
        this.hitAccuracy = Math.max(0, minDist - ball.radius);
        this.hitAge = this.age;
        this.hitDistance = this.pos.distanceTo(this.shotOrigin);
        return true;
      }
    }
    return false;
  }

  // Simple sphere sweep vs player capsule
  private sweepPlayer(playerPos: THREE.Vector3): boolean {
    const halfHeight = PLAYER_HEIGHT / 2;

    // Disc path vector
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

      if (inHeightRange && hDist <= PLAYER_RADIUS + DISC_HITBOX) {
        this.minHitDist = hDist;
        return true;
      }
      return false;
    }

    // Project player onto disc path
    const px = playerPos.x - this.prevPos.x;
    const py = playerPos.y - this.prevPos.y;
    const pz = playerPos.z - this.prevPos.z;
    const t = (px*dx + py*dy + pz*dz) / pathLenSq;
    const tClamped = Math.max(0, Math.min(1, t));

    // Closest point on disc segment
    const closestX = this.prevPos.x + dx * tClamped;
    const closestY = this.prevPos.y + dy * tClamped;
    const closestZ = this.prevPos.z + dz * tClamped;

    // Vector from closest point to player
    const vx = closestX - playerPos.x;
    const vy = closestY - playerPos.y;
    const vz = closestZ - playerPos.z;

    // Clamp Y to capsule height
    const clampedY = Math.max(-halfHeight, Math.min(halfHeight, vy));

    // Horizontal distance
    const hx = closestX - playerPos.x;
    const hz = closestZ - playerPos.z;
    const hDist = Math.sqrt(hx*hx + hz*hz);

    // Total distance
    const totalDist = Math.sqrt(hx*hx + clampedY*clampedY + hz*hz);

    if (totalDist <= PLAYER_RADIUS + DISC_HITBOX) {
      this.minHitDist = hDist;
      logger.debug(`Hit at dist ${hDist.toFixed(2)}, threshold ${(PLAYER_RADIUS + DISC_HITBOX).toFixed(2)}`);
      return true;
    }

    return false;
  }

  update(dt: number, terrain: Terrain, balls?: Ball[], remotePlayers?: Map<string, THREE.Vector3>): void {
    if (this.dead) return;

    if (!this.exploded) {
      this.prevPos.copy(this.pos);
      this.age += dt;
      // No gravity - straight flight
      this.pos.addScaledVector(this.vel, dt);

      if (this.sweepTerrain(terrain)) {
        this.explode();
        return;
      }

      if (balls) {
        for (const ball of balls) {
          if (ball.dead) continue;
          if (this.sweepBall(ball)) {
            this.hitBall = ball;
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

      // Align mesh to velocity - cylinder axis (Y) points forward (edge-first like frisbee)
      const velDir = this.vel.clone().normalize();
      if (this.vel.lengthSq() > 0.01) {
        const target = this.pos.clone().add(velDir);
        this.mesh.lookAt(target);
      }

      // Emit trail
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
      const offset = new THREE.Vector3()
        .addScaledVector(right, u)
        .addScaledVector(up, v);
      const pos = this.pos.clone().addScaledVector(dir, -0.3).add(offset);

      // Particles stay in place with minimal drift
      const drift = new THREE.Vector3((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.2);
      const vel = drift;

      const life = TRAIL_LIFE_MIN + Math.random() * (TRAIL_LIFE_MAX - TRAIL_LIFE_MIN);
      const size = 0.06 + Math.random() * 0.15;
      this.particles.push(this.spawnTrailParticle(pos, vel, life, size));
    }
  }

  private spawnTrailParticle(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): TrailParticle {
    const mat = new THREE.MeshBasicMaterial({
      color: TRAIL_COLORS[0],
      transparent: true,
      opacity: 0.5,
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
      
      // Color gradient
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
      
      p.mat.opacity = t * 0.5;
      p.mesh.scale.setScalar(p.baseSize * (0.5 + 1.0 * ft));
    }
  }

  private removeProjectileMesh(): void {
    if (this.projectileRemoved) return;
    this.scene.remove(this.mesh);
    this.mat.dispose();
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
