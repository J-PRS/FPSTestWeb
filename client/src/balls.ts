import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { GRAVITY, BALL_MAX_DIST, BALL_TELE_MIN, BALL_TELE_MAX, BALL_TELE_HEIGHT, BALL_BASE_RADIUS } from './config.js';

const BALL_GRAVITY   = GRAVITY;
const BOUNCE         = 1.0;
const TRAIL_COUNT    = 14;
const TRAIL_LIFE     = 1.2;
const TRAIL_INTERVAL = 0.04;

const BALL_COLORS = [
  new THREE.Color(1.0, 0.25, 0.25),
  new THREE.Color(0.25, 0.85, 0.25),
  new THREE.Color(0.25, 0.55, 1.0),
  new THREE.Color(1.0, 0.85, 0.1),
  new THREE.Color(0.9, 0.25, 0.9),
  new THREE.Color(0.15, 0.9, 0.9),
  new THREE.Color(1.0, 0.5, 0.1),
];

interface TrailDot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
}

export class Ball {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  dead = false;
  health: number;
  radius: number;
  color: THREE.Color;

  private mesh: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private scene: THREE.Scene;
  scale: number;
  private trailDots: TrailDot[] = [];
  private trailTimer = 0;
  private flashTimer = 0;
  private meshRemoved = false;
  private disposed = false;

  constructor(scene: THREE.Scene, terrain: Terrain, variant: 0 | 1 | 2 = 0) {
    this.scene = scene;

    if (variant === 2) {
      this.scale = 3.0; this.health = 3;
      this.color = new THREE.Color(1.0, 0.25, 0.25);
    } else if (variant === 1) {
      this.scale = 2.0; this.health = 2;
      this.color = new THREE.Color(0.25, 0.85, 0.25);
    } else {
      this.scale = 1.0; this.health = 1;
      this.color = BALL_COLORS[Math.floor(Math.random() * BALL_COLORS.length)].clone();
    }
    this.radius = BALL_BASE_RADIUS * this.scale;

    const rx = (Math.random() - 0.5) * 400;
    const rz = (Math.random() - 0.5) * 400;
    const gy = terrain.getHeight(rx, rz);
    this.pos = new THREE.Vector3(rx, gy + 80 + Math.random() * 60, rz);

    const ang = Math.random() * Math.PI * 2;
    const spd = Math.random() * 20;
    this.vel = new THREE.Vector3(Math.cos(ang) * spd, -2, Math.sin(ang) * spd);

    const geo = new THREE.IcosahedronGeometry(BALL_BASE_RADIUS, 0);
    this.mat = new THREE.MeshLambertMaterial({ color: this.color });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.scale.setScalar(this.scale);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  update(dt: number, terrain: Terrain, playerPos: THREE.Vector3): void {
    if (this.dead) {
      // When dead, only update trails to fade them out
      if (!this.meshRemoved) {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mat.dispose();
        this.meshRemoved = true;
      }

      for (let i = this.trailDots.length - 1; i >= 0; i--) {
        const d = this.trailDots[i];
        d.age += dt;
        if (d.age >= TRAIL_LIFE) {
          this.scene.remove(d.mesh);
          d.mesh.geometry.dispose();
          d.mat.dispose();
          this.trailDots.splice(i, 1);
        } else {
          const t = 1.0 - d.age / TRAIL_LIFE;
          d.mat.opacity = t * 0.6;
          d.mesh.scale.setScalar(t);
        }
      }

      // Mark as truly dead when trails are gone
      if (this.trailDots.length === 0) {
        this.disposed = true;
      }
      return;
    }

    this.vel.y += BALL_GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    const gy = terrain.getHeight(this.pos.x, this.pos.z);
    if (this.pos.y - this.radius <= gy) {
      this.pos.y = gy + this.radius;
      const n = terrain.getNormal(this.pos.x, this.pos.z);
      const dot = this.vel.dot(n);
      this.vel.addScaledVector(n, -2.0 * dot * BOUNCE);

      const dx = this.pos.x - playerPos.x;
      const dz = this.pos.z - playerPos.z;
      if (dx * dx + dz * dz > BALL_MAX_DIST * BALL_MAX_DIST) {
        const ang = Math.random() * Math.PI * 2;
        const dist = BALL_TELE_MIN + Math.random() * (BALL_TELE_MAX - BALL_TELE_MIN);
        this.pos.x = playerPos.x + Math.cos(ang) * dist;
        this.pos.z = playerPos.z + Math.sin(ang) * dist;
        this.pos.y = terrain.getHeight(this.pos.x, this.pos.z) + BALL_TELE_HEIGHT;
        this.vel.set(
          (Math.random() - 0.5) * 10,
          5.0,
          (Math.random() - 0.5) * 10
        );
      }
    }

    this.mesh.position.copy(this.pos);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.mat.color.copy(this.color);
    }

    // Trail
    this.trailTimer += dt;
    if (this.trailTimer >= TRAIL_INTERVAL) {
      this.trailTimer = 0;
      const spd2 = this.vel.lengthSq();
      if (spd2 > 0.5) {
        const tgeo = new THREE.IcosahedronGeometry(this.radius * 0.9, 0); // reduced by 10% to prevent sticking out
        const tmat = new THREE.MeshBasicMaterial({ color: this.color.clone(), transparent: true, opacity: 0.8 });
        const tm = new THREE.Mesh(tgeo, tmat);
        tm.position.copy(this.pos);
        this.scene.add(tm);
        if (this.trailDots.length >= TRAIL_COUNT) {
          const old = this.trailDots.shift()!;
          this.scene.remove(old.mesh);
          old.mesh.geometry.dispose();
          old.mat.dispose();
        }
        this.trailDots.push({ mesh: tm, mat: tmat, age: 0 });
      }
    }

    for (let i = this.trailDots.length - 1; i >= 0; i--) {
      const d = this.trailDots[i];
      d.age += dt;
      if (d.age >= TRAIL_LIFE) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        d.mat.dispose();
        this.trailDots.splice(i, 1);
      } else {
        const t = 1.0 - d.age / TRAIL_LIFE;
        d.mat.opacity = t * 0.6;
        d.mesh.scale.setScalar(t);
      }
    }
  }

  hitTest(px: number, py: number, pz: number, extraRadius = 0): boolean {
    const dx = px - this.pos.x;
    const dy = py - this.pos.y;
    const dz = pz - this.pos.z;
    const r = this.radius + extraRadius;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  takeDamage(): boolean {
    this.health--;
    this.flashTimer = 0.15;
    this.mat.color.set(0xffffff);
    if (this.health <= 0) { this.dead = true; return true; }
    return false;
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    const dir = this.pos.clone().sub(from).normalize();
    this.vel.addScaledVector(dir, force);
  }

  applyPull(to: THREE.Vector3, force: number): void {
    const dir = to.clone().sub(this.pos).normalize();
    this.vel.addScaledVector(dir, force);
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
    for (const d of this.trailDots) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mat.dispose();
    }
    this.trailDots = [];
  }
}

export function pickVariant(): 0 | 1 | 2 {
  const r = Math.random();
  if (r < 0.1) return 2;
  if (r < 0.3) return 1;
  return 0;
}
