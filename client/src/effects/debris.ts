import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ, SHRINK_DUR, GREY_DUR, BASE_SPEED, EXTRA_SPEED, LIFE_BASE, LIFE_RAND } from '../core/config.js';

import { Terrain } from '../world/terrain.js';

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

interface DebrisOptions {
  count: number;
  spreadX: number;
  spreadY: number;
  spreadZ: number;
  /** Shatter-from-shell: shard origins sit on this radius so frame 0's
   *  silhouette is the original body, not a box of chunks. */
  shellRadius?: number;
  /** Projectile direction — shards bias along it so force reads as
   *  traveling THROUGH the body. */
  impulseDir?: THREE.Vector3;
  /** The dead body's velocity — debris inherits momentum. */
  inheritVel?: THREE.Vector3;
}

// Generic tumbling-shard debris burst. BallDebris/PlayerDebris are just
// different counts/spreads of the same effect.
export class Debris {
  dead = false;
  private shards: Shard[] = [];
  private scene: THREE.Scene;
  private terrain: Terrain;
  // Ghost shell — the body's own silhouette, burning out over ~0.15s.
  // Masks the pop frame entirely: eye sees the ball flash-bright, expand,
  // and become the shard cloud.
  private ghost: THREE.Mesh | null = null;
  private ghostMat: THREE.MeshBasicMaterial | null = null;
  private ghostT = 0;
  private static readonly GHOST_LIFE = 0.15;
  private static readonly GHOST_GROW = 1.6;

  constructor(
    scene: THREE.Scene, terrain: Terrain,
    px: number, py: number, pz: number,
    color: THREE.Color, opts: DebrisOptions
  ) {
    this.scene   = scene;
    this.terrain = terrain;

    if (opts.shellRadius) {
      // Icosahedron detail 0 matches the ball's faceted silhouette
      this.ghostMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(Math.min(1, color.r + 0.6), Math.min(1, color.g + 0.6), Math.min(1, color.b + 0.6)),
        transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this.ghost = new THREE.Mesh(new THREE.IcosahedronGeometry(opts.shellRadius, 0), this.ghostMat);
      this.ghost.position.set(px, py, pz);
      scene.add(this.ghost);
    }

    for (let i = 0; i < opts.count; i++) {
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

      let ox: number, oy: number, oz: number;
      let vx: number, vy: number, vz: number;
      if (opts.shellRadius) {
        // Surface-sampled: random unit direction, shard sits ON the shell
        // (0.55–0.95R so pieces overlap — no gaps in the first frame) and
        // flies along that normal — the body bursts outward, not just apart.
        const dx = Math.random() * 2 - 1;
        const dz = Math.random() * 2 - 1;
        const dy = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        const ndx = dx / len, ndy = dy / len, ndz = dz / len;
        const r = opts.shellRadius * (0.55 + Math.random() * 0.4);
        ox = ndx * r; oy = ndy * r; oz = ndz * r;
        // Speed gradient: shards on the far side (aligned with the shot)
        // fly fastest — the burst wave travels THROUGH the body.
        let spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
        if (opts.impulseDir) {
          const align = ndx * opts.impulseDir.x + ndy * opts.impulseDir.y + ndz * opts.impulseDir.z;
          spd *= 1 + Math.max(0, align) * 0.9;
        }
        vx = ndx * spd; vy = ndy * spd + 1.5; vz = ndz * spd;
        if (opts.impulseDir) {
          // ~40% of the shot's push carried through the shards
          vx += opts.impulseDir.x * 6; vy += opts.impulseDir.y * 6; vz += opts.impulseDir.z * 6;
        }
        if (opts.inheritVel) {
          vx += opts.inheritVel.x * 0.7; vy += opts.inheritVel.y * 0.7; vz += opts.inheritVel.z * 0.7;
        }
      } else {
        ox = (Math.random() - 0.5) * opts.spreadX;
        oy = (Math.random() - 0.5) * opts.spreadY;
        oz = (Math.random() - 0.5) * opts.spreadZ;
        const ang  = Math.random() * Math.PI * 2;
        const elv  = Math.random() * Math.PI * 0.65;
        const spd  = BASE_SPEED + Math.random() * EXTRA_SPEED;
        vx = Math.cos(elv) * Math.cos(ang) * spd;
        vy = Math.sin(elv) * spd + 2.0;
        vz = Math.cos(elv) * Math.sin(ang) * spd;
      }
      mesh.position.set(px + ox, py + oy, pz + oz);
      mesh.castShadow = false;
      scene.add(mesh);

      const tumble = 4.0 + Math.random() * 8.0;

      this.shards.push({
        mesh, mat,
        x: px + ox, y: py + oy, z: pz + oz,
        vx, vy, vz,
        rx: (Math.random() - 0.5) * 2 * tumble,
        ry: (Math.random() - 0.5) * 2 * tumble,
        rz: (Math.random() - 0.5) * 2 * tumble,
        life: LIFE_BASE + Math.random() * LIFE_RAND,
        elapsed: 0,
        radius: Math.max(sw, sh, sd),
        landed: false, landedAt: 0,
        cr, cg, cb, dead: false,
        trailTimer: 0, trails: [],
      });
    }
  }

  update(dt: number): void {
    if (this.ghost && this.ghostMat) {
      this.ghostT += dt;
      const t = Math.min(1, this.ghostT / Debris.GHOST_LIFE);
      this.ghost.scale.setScalar(1 + t * (Debris.GHOST_GROW - 1));
      this.ghostMat.opacity = 0.95 * (1 - t);
      if (t >= 1) {
        this.scene.remove(this.ghost);
        this.ghost.geometry.dispose();
        this.ghostMat.dispose();
        this.ghost = null; this.ghostMat = null;
      }
    }
    let alive = 0;
    for (const s of this.shards) {
      if (s.dead) continue;
      s.elapsed += dt;
      if (s.elapsed >= s.life) {
        this.removeShard(s);
        continue;
      }
      if (this.stepShard(s, dt)) alive++;
    }
    if (alive === 0) this.dead = true;
  }

  // Returns false when the shard has fully shrunk away after landing
  private stepShard(s: Shard, dt: number): boolean {
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

    if (!s.landed) this.emitTrail(s, dt);
    this.updateTrail(s, dt);
    this.greyShard(s);
    return this.shrinkLanded(s);
  }

  private emitTrail(s: Shard, dt: number): void {
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

  private updateTrail(s: Shard, dt: number): void {
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
  }

  private greyShard(s: Shard): void {
    const gt   = Math.min(s.elapsed / GREY_DUR, 1.0);
    const grey = s.cr * 0.299 + s.cg * 0.587 + s.cb * 0.114;
    s.mat.color.setRGB(
      s.cr + (grey - s.cr) * gt,
      s.cg + (grey - s.cg) * gt,
      s.cb + (grey - s.cb) * gt,
    );
  }

  private shrinkLanded(s: Shard): boolean {
    if (!s.landed) return true;
    const ft = 1.0 - (s.elapsed - s.landedAt) / SHRINK_DUR;
    if (ft <= 0) {
      this.removeShard(s);
      return false;
    }
    s.mesh.scale.setScalar(ft);
    return true;
  }

  private removeShard(s: Shard): void {
    this.scene.remove(s.mesh);
    s.mesh.geometry.dispose();
    s.mat.dispose();
    s.dead = true;
  }

  dispose(): void {
    if (this.ghost && this.ghostMat) {
      this.scene.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghostMat.dispose();
      this.ghost = null; this.ghostMat = null;
    }
    for (const s of this.shards) {
      if (!s.dead) this.removeShard(s);
      for (const p of s.trails) {
        this.scene.remove(p.mesh);
        p.mat.dispose();
      }
    }
  }
}

const BALL_CHUNK_COUNT = 14;

export class BallDebris extends Debris {
  constructor(
    scene: THREE.Scene, terrain: Terrain,
    px: number, py: number, pz: number,
    color: THREE.Color, scale: number = 1.0,
    opts?: { bodyRadius?: number; impulseDir?: THREE.Vector3; inheritVel?: THREE.Vector3 }
  ) {
    const spread = 0.6 * scale;
    super(scene, terrain, px, py, pz, color, {
      count: Math.floor(BALL_CHUNK_COUNT * scale),
      spreadX: spread, spreadY: spread, spreadZ: spread,
      shellRadius: opts?.bodyRadius,
      impulseDir: opts?.impulseDir,
      inheritVel: opts?.inheritVel,
    });
  }
}

const PLAYER_CHUNK_COUNT = 20; // More chunks for players

export class PlayerDebris extends Debris {
  constructor(
    scene: THREE.Scene, terrain: Terrain,
    px: number, py: number, pz: number,
    color: THREE.Color = new THREE.Color(0x4444ff) // Default player blue
  ) {
    super(scene, terrain, px, py, pz, color, {
      count: PLAYER_CHUNK_COUNT,
      spreadX: 0.8, spreadY: 1.0, spreadZ: 0.8, // larger/taller spread for players
    });
  }
}
