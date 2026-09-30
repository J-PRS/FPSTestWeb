import * as THREE from 'three';

import { LIFE_BASE, LIFE_RAND, PLAYER_RADIUS } from '../core/config.js';
import { pickShardGeo, shardLaunch, type DebrisOptions, type DebrisPart } from './debrisShards.js';

type Vec3Like = { x: number; y: number; z: number };

import { Terrain } from '../world/terrain.js';
import { stepShard, emitTrail, greyShard, shrinkLanded } from './debrisStep.js';


export interface Shard {
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
  brush: boolean;
  goo: boolean;
  /** Geometry borrowed from the dying body — never dispose it. */
  sharedGeo: boolean;
}

// Generic tumbling-shard debris burst. BallDebris/PlayerDebris are just
// different counts/spreads of the same effect.
export class Debris {
  dead = false;
  private shards: Shard[] = [];
  scene: THREE.Scene;
  terrain: Terrain;
  // Ghost shell — the body's own silhouette, burning out over ~0.15s.
  // Masks the pop frame entirely: eye sees the ball flash-bright, expand,
  // and become the shard cloud.
  private ghost: THREE.Mesh | null = null;
  private ghostMat: THREE.MeshBasicMaterial | null = null;
  private ghostT = 0;
  private static readonly GHOST_LIFE = 0.15;
  private static readonly GHOST_GROW = 1.6;
  private static ghostPool: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];

  constructor(
    scene: THREE.Scene, terrain: Terrain,
    pos: Vec3Like,
    color: THREE.Color, opts: DebrisOptions
  ) {
    const { x: px, y: py, z: pz } = pos;
    this.scene   = scene;
    this.terrain = terrain;

    if (opts.shellRadius) this.allocGhost(scene, opts.shellRadius, color, px, py, pz);

    this.spawnShards(px, py, pz, color, opts);
  }

  /** Icosahedron detail 0 matches the ball's faceted silhouette.
   *  Mesh+mat pooled (geometry is radius-dependent → rebuilt each use). */
  private allocGhost(scene: THREE.Scene, shellRadius: number, color: THREE.Color, px: number, py: number, pz: number): void {
    const pooled = Debris.ghostPool.pop();
    this.ghostMat = pooled ? pooled.mat : new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.ghostMat.color.setRGB(Math.min(1, color.r + 0.6), Math.min(1, color.g + 0.6), Math.min(1, color.b + 0.6));
    this.ghostMat.opacity = 0.95;
    this.ghost = pooled ? pooled.mesh : new THREE.Mesh();
    this.ghost.geometry = new THREE.IcosahedronGeometry(shellRadius, 0);
    if (this.ghost.material !== this.ghostMat) this.ghost.material = this.ghostMat;
    this.ghost.scale.setScalar(1);
    this.ghost.position.set(px, py, pz);
    scene.add(this.ghost);
  }

  private spawnShards(px: number, py: number, pz: number, color: THREE.Color, opts: DebrisOptions): void {
    const count = opts.parts?.length ?? opts.count;
    for (let i = 0; i < count; i++) {
      this.spawnShard(opts.parts?.[i], opts, px, py, pz, color);
    }
  }

  private spawnShard(part: DebrisPart | undefined, opts: DebrisOptions,
      px: number, py: number, pz: number, color: THREE.Color): void {
    const sw = 0.25 + Math.random() * 0.55;
    const sh = 0.18 + Math.random() * 0.45;
    const sd = 0.20 + Math.random() * 0.50;
    const geo = pickShardGeo(part, opts, sw, sh, sd);

    const v   = 0.75 + Math.random() * 0.25;
    const cr  = color.r * v;
    const cg  = color.g * v;
    const cb  = color.b * v;
    const { mesh, mat } = this.allocShardMesh(geo, cr, cg, cb);

    const { o, vel } = shardLaunch(part, opts, px, py, pz);
    mesh.position.set(px + o.x, py + o.y, pz + o.z);
    mesh.castShadow = false;
    this.scene.add(mesh);

    const sharedGeo = !!opts.shardGeos?.length;
    const tumble = 4.0 + Math.random() * 8.0;

    this.shards.push({
      mesh, mat,
      x: px + o.x, y: py + o.y, z: pz + o.z,
      vx: vel.x, vy: vel.y, vz: vel.z,
      rx: (Math.random() - 0.5) * 2 * tumble,
      ry: (Math.random() - 0.5) * 2 * tumble,
      rz: (Math.random() - 0.5) * 2 * tumble,
      life: (opts.kind === 'brush' ? 0.7 : 1) * (LIFE_BASE + Math.random() * LIFE_RAND),
      elapsed: 0,
      radius: part ? (geo.boundingSphere?.radius ?? 0.3) * 0.35
        : sharedGeo ? (geo.boundingSphere?.radius ?? 0.3) * 0.5
        : opts.kind === 'brush' ? 0.08 : opts.kind === 'goo' ? 0.06 : Math.max(sw, sh, sd),
      landed: false, landedAt: 0,
      cr, cg, cb, dead: false,
      trailTimer: 0,
      brush: opts.kind === 'brush',
      goo: opts.kind === 'goo',
      sharedGeo,
    });
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
        Debris.ghostPool.push({ mesh: this.ghost, mat: this.ghostMat });
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

  private stepShard(s: Shard, dt: number): boolean { return stepShard(this, s, dt); }
  private emitTrail(s: Shard, dt: number): void { emitTrail(s, dt); }
  private greyShard(s: Shard): void { greyShard(s); }
  private shrinkLanded(s: Shard): boolean { return shrinkLanded(this, s); }

  // Shared free-list — shard mesh+material outlive the Debris instance;
  // random geometries are still per-shard and disposed at release.
  private static shardPool: { mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial }[] = [];

  /** Mesh+mat pooled — a kill used to allocate ~20 materials. The
   *  pooled mesh's old random geo was already disposed on release,
   *  so assigning here is safe. */
  private allocShardMesh(geo: THREE.BufferGeometry, cr: number, cg: number, cb: number) {
    const pooled = Debris.shardPool.pop();
    const mesh = pooled ? pooled.mesh : new THREE.Mesh();
    const mat = pooled ? pooled.mat : new THREE.MeshLambertMaterial();
    mesh.geometry = geo;
    if (mesh.material !== mat) mesh.material = mat;
    mat.color.setRGB(cr, cg, cb);
    mesh.scale.setScalar(1);
    mesh.rotation.set(0, 0, 0);
    return { mesh, mat };
  }

  removeShard(s: Shard): void {
    this.scene.remove(s.mesh);
    if (!s.sharedGeo) s.mesh.geometry.dispose();
    s.dead = true;
    Debris.shardPool.push({ mesh: s.mesh, mat: s.mat });
  }

  dispose(): void {
    if (this.ghost && this.ghostMat) {
      this.scene.remove(this.ghost);
      this.ghost.geometry.dispose();
      Debris.ghostPool.push({ mesh: this.ghost, mat: this.ghostMat });
      this.ghost = null; this.ghostMat = null;
    }
    for (const s of this.shards) {
      if (!s.dead) this.removeShard(s);
    }
  }
}

const BALL_CHUNK_COUNT = 14;

export class BallDebris extends Debris {
  constructor(
    scene: THREE.Scene, terrain: Terrain,
    pos: Vec3Like,
    color: THREE.Color, scale: number = 1.0,
    opts?: { bodyRadius?: number; impulseDir?: THREE.Vector3; inheritVel?: THREE.Vector3; kind?: 'rock' | 'brush' | 'goo'; shardGeos?: THREE.BufferGeometry[] }
  ) {
    const spread = 0.6 * scale;
    super(scene, terrain, pos, color, {
      count: Math.floor(BALL_CHUNK_COUNT * scale),
      spreadX: spread, spreadY: spread, spreadZ: spread,
      shellRadius: opts?.bodyRadius,
      impulseDir: opts?.impulseDir,
      inheritVel: opts?.inheritVel,
      kind: opts?.kind,
      shardGeos: opts?.shardGeos,
    });
  }
}

const PLAYER_CHUNK_COUNT = 20; // More chunks for players

export class PlayerDebris extends Debris {
  constructor(
    scene: THREE.Scene, terrain: Terrain,
    pos: Vec3Like,
    color: THREE.Color = new THREE.Color(0x4444ff), // Default player blue
    opts?: { impulseDir?: THREE.Vector3; inheritVel?: THREE.Vector3; parts?: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[] }
  ) {
    // shellRadius lifts this from "box of chunks" to "the body bursts":
    // shards start ON the capsule silhouette and fly along their own
    // normals, impulseDir carries the shot through them, inheritVel keeps
    // the dead skier's momentum — the same trio that sells ball deaths.
    super(scene, terrain, pos, color, {
      count: PLAYER_CHUNK_COUNT,
      spreadX: 0.8, spreadY: 1.0, spreadZ: 0.8, // larger/taller spread for players
      shellRadius: PLAYER_RADIUS,
      impulseDir: opts?.impulseDir,
      inheritVel: opts?.inheritVel,
      parts: opts?.parts,
    });
  }
}
