import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { GRAVITY } from './config.js';

const BOUNCE_Y        = 0.35;
const FRICTION_XZ     = 0.80;
const BASE_CHUNK_COUNT = 14;
const BASE_SPEED      = 9.0;
const EXTRA_SPEED     = 14.0;
const LIFE_BASE       = 6.0;
const LIFE_RAND       = 2.0;
const SHRINK_DUR      = 0.5;
const GREY_DUR        = 1.0;
const TRAIL_INTERVAL  = 0.03; // seconds between trail emission
const TRAIL_LIFE      = 0.8;  // trail particle lifetime
const TRAIL_GEO       = new THREE.SphereGeometry(1, 4, 4);

interface TrailParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  baseSize: number;
}

interface Shard {
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  life: number;
  elapsed: number;
  radius: number;
  landed: boolean;
  landedAt: number;
  cr: number; cg: number; cb: number;
  dead: boolean;
  trailTimer: number;
  trails: TrailParticle[];
}

export class BallDebris {
  dead = false;
  private shards: Shard[] = [];
  private scene: THREE.Scene;
  private terrain: Terrain;

  constructor(
    scene: THREE.Scene, terrain: Terrain,
    px: number, py: number, pz: number,
    color: THREE.Color, scale: number = 1.0
  ) {
    this.scene   = scene;
    this.terrain = terrain;

    const count = Math.floor(BASE_CHUNK_COUNT * scale);

    for (let i = 0; i < count; i++) {
      const sw = 0.25 + Math.random() * 0.55;
      const sh = 0.18 + Math.random() * 0.45;
      const sd = 0.20 + Math.random() * 0.50;

      const geoType = Math.random();
      let geo: THREE.BufferGeometry;
      if (geoType < 0.4) {
        geo = new THREE.TetrahedronGeometry(Math.max(sw, sh, sd), 0);
      } else if (geoType < 0.7) {
        geo = new THREE.DodecahedronGeometry(Math.max(sw, sh, sd), 0);
      } else {
        geo = new THREE.IcosahedronGeometry(Math.max(sw, sh, sd), 0);
      }
      geo.scale(sw / Math.max(sw, sh, sd), sh / Math.max(sw, sh, sd), sd / Math.max(sw, sh, sd));

      const v   = 0.75 + Math.random() * 0.25;
      const cr  = color.r * v;
      const cg  = color.g * v;
      const cb  = color.b * v;
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(cr, cg, cb) });
      const mesh = new THREE.Mesh(geo, mat);

      const ox = (Math.random() - 0.5) * 0.6 * scale;
      const oy = (Math.random() - 0.5) * 0.6 * scale;
      const oz = (Math.random() - 0.5) * 0.6 * scale;
      mesh.position.set(px + ox, py + oy, pz + oz);
      mesh.castShadow = false;
      scene.add(mesh);

      const ang  = Math.random() * Math.PI * 2;
      const elv  = Math.random() * Math.PI * 0.65;
      const spd  = BASE_SPEED + Math.random() * EXTRA_SPEED;
      const vx   = Math.cos(elv) * Math.cos(ang) * spd;
      const vy   = Math.sin(elv) * spd + 2.0;
      const vz   = Math.cos(elv) * Math.sin(ang) * spd;

      const tumble = 4.0 + Math.random() * 8.0;
      const rx = (Math.random() - 0.5) * 2 * tumble;
      const ry = (Math.random() - 0.5) * 2 * tumble;
      const rz = (Math.random() - 0.5) * 2 * tumble;

      const radius = Math.max(sw, sh, sd);
      const life   = LIFE_BASE + Math.random() * LIFE_RAND;

      this.shards.push({
        mesh, mat,
        x: px + ox, y: py + oy, z: pz + oz,
        vx, vy, vz, rx, ry, rz,
        life, elapsed: 0, radius,
        landed: false, landedAt: 0,
        cr, cg, cb, dead: false,
        trailTimer: 0, trails: [],
      });
    }
  }

  update(dt: number): void {
    let alive = 0;

    for (const s of this.shards) {
      if (s.dead) continue;
      s.elapsed += dt;

      if (s.elapsed >= s.life) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mat.dispose();
        s.dead = true;
        continue;
      }
      alive++;

      // Physics
      s.vy += GRAVITY * dt;
      s.x  += s.vx * dt;
      s.y  += s.vy * dt;
      s.z  += s.vz * dt;

      // Terrain bounce
      const gy = this.terrain.getHeight(s.x, s.z);
      if (s.y - s.radius <= gy) {
        s.y   = gy + s.radius;
        s.vy  = -s.vy * BOUNCE_Y;
        s.vx *= FRICTION_XZ;
        s.vz *= FRICTION_XZ;
        s.rx *= 0.3; s.ry *= 0.3; s.rz *= 0.3;
        if (!s.landed) { s.landed = true; s.landedAt = s.elapsed; }
      }

      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.rotation.x += s.rx * dt;
      s.mesh.rotation.y += s.ry * dt;
      s.mesh.rotation.z += s.rz * dt;

      // Emit trail particles
      if (!s.landed) {
        s.trailTimer += dt;
        while (s.trailTimer >= TRAIL_INTERVAL) {
          s.trailTimer -= TRAIL_INTERVAL;
          const size = s.radius * 0.4;
          const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(s.cr, s.cg, s.cb),
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          const mesh = new THREE.Mesh(TRAIL_GEO, mat);
          mesh.position.set(s.x, s.y, s.z);
          mesh.scale.setScalar(size);
          this.scene.add(mesh);
          s.trails.push({ mesh, mat, life: TRAIL_LIFE, maxLife: TRAIL_LIFE, baseSize: size });
        }
      }

      // Update trail particles
      for (let i = s.trails.length - 1; i >= 0; i--) {
        const p = s.trails[i];
        p.life -= dt;
        if (p.life <= 0) {
          this.scene.remove(p.mesh);
          p.mat.dispose();
          s.trails.splice(i, 1);
          continue;
        }
        const t = p.life / p.maxLife;
        p.mat.opacity = t * 0.5;
        p.mesh.scale.setScalar(p.baseSize * t);
      }

      // Grayscale fade
      const gt   = Math.min(s.elapsed / GREY_DUR, 1.0);
      const grey = s.cr * 0.299 + s.cg * 0.587 + s.cb * 0.114;
      s.mat.color.setRGB(
        s.cr + (grey - s.cr) * gt,
        s.cg + (grey - s.cg) * gt,
        s.cb + (grey - s.cb) * gt,
      );

      // Shrink after landing
      if (s.landed) {
        const ft = 1.0 - (s.elapsed - s.landedAt) / SHRINK_DUR;
        if (ft <= 0) {
          this.scene.remove(s.mesh);
          s.mesh.geometry.dispose();
          s.mat.dispose();
          s.dead = true;
          continue;
        }
        s.mesh.scale.setScalar(ft);
      }
    }

    if (alive === 0) this.dead = true;
  }

  dispose(): void {
    for (const s of this.shards) {
      if (!s.dead) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mat.dispose();
      }
      // Clean up trail particles
      for (const p of s.trails) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
      }
    }
  }
}
