import * as THREE from 'three';

import { LIFE_BASE, LIFE_RAND, PLAYER_RADIUS } from '../core/config.js';
import { pickShardGeo, pickShardPrim, shardLaunch, type DebrisOptions, type DebrisPart } from './debrisShards.js';

type Vec3Like = { x: number; y: number; z: number };

const _tmpColor = new THREE.Color();
const _tmpMat = new THREE.Matrix4();
const _tmpQ = new THREE.Quaternion();
const _tmpE = new THREE.Euler();
const _tmpP = new THREE.Vector3();
const _tmpS = new THREE.Vector3();
const _zeroM = new THREE.Matrix4().makeScale(0, 0, 0);

import { Terrain } from '../world/terrain.js';
import { stepShard, emitTrail, greyShard, shrinkLanded } from './debrisStep.js';


export interface Shard {
  /** Set only on the mesh path (real body parts / custom shardGeos —
   *  unique geometries can't instance). Primitive shards are null here
   *  and live in this.insts instead. */
  mesh: THREE.Mesh | null;
  mat: THREE.MeshLambertMaterial | null;
  /** Instanced slot: which bucket + index, or -1 on the mesh path. */
  inst: number;
  slot: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  /** Accumulated tumble angles + flatten/shrink factors — folded into
   *  the instance matrix each step (mesh path mutates mesh directly). */
  ex: number; ey: number; ez: number;
  flatY: number;
  shrink: number;
  sw: number; sh: number; sd: number;
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

  readonly ox: number; readonly oy: number; readonly oz: number;

  constructor(
    scene: THREE.Scene, terrain: Terrain,
    pos: Vec3Like,
    color: THREE.Color, opts: DebrisOptions
  ) {
    const { x: px, y: py, z: pz } = pos;
    this.scene   = scene;
    this.terrain = terrain;
    this.ox = px; this.oy = py; this.oz = pz;

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
    this.instanced = !opts.parts?.length && !opts.shardGeos?.length;
    this.instCap = count;
    for (let i = 0; i < count; i++) {
      this.spawnShard(opts.parts?.[i], opts, px, py, pz, color);
    }
  }

  // Primitive shards ride one InstancedMesh per shape family — a 14-shard
  // ball kill was 14 draw calls + 14 material writes; now it's ≤1 call.
  // Real body parts and caller-supplied shardGeos keep the mesh path
  // (unique geometries can't share a bucket).
  private instanced = false;
  private insts: { mesh: THREE.InstancedMesh; free: number[] }[] = [];
  private static primGeos = [
    new THREE.TetrahedronGeometry(1, 0),
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.CylinderGeometry(1, 1, 1, 3),  // brush twig — tapered via x/z scale
    new THREE.SphereGeometry(1, 5, 4),       // goo droplet
  ];
  private static primMat = new THREE.MeshLambertMaterial();
  private instCap = 32;
  // Kill bursts used to build+dispose up to 5 InstancedMesh per death —
  // a 9-11ms spike under throttle. Buckets pool like shardPool above:
  // capacity persists, count/free reset between Debris instances.
  private static instPool: Map<number, THREE.InstancedMesh[]> = new Map();

  private instAlloc(prim: number): { inst: number; slot: number } {
    let b = this.insts[prim];
    if (!b) {
      const pooled = Debris.instPool.get(prim)?.pop();
      const mesh = pooled ?? new THREE.InstancedMesh(Debris.primGeos[prim]!, Debris.primMat, this.instCap);
      mesh.matrixWorldAutoUpdate = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.frustumCulled = false; // shards scatter; unit-geo bounds don't cover instances
      mesh.count = 0;
      b = this.insts[prim] = { mesh, free: [] };
      this.scene.add(mesh);
    }
    const slot = b.free.length ? b.free.pop()! : b.mesh.count++;
    return { inst: prim, slot };
  }

  private allocShard(prim: number, part: DebrisPart | undefined, opts: DebrisOptions,
      s: { sw: number; sh: number; sd: number; cr: number; cg: number; cb: number;
           x: number; y: number; z: number; sharedGeo: boolean }) {
    const { sw, sh, sd, cr, cg, cb } = s;
    if (this.instanced) {
      const a = this.instAlloc(prim);
      const m = this.insts[prim]!.mesh;
      m.setColorAt(a.slot, _tmpColor.setRGB(cr, cg, cb));
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      return { mesh: null, mat: null, inst: a.inst, slot: a.slot,
        radius: opts.kind === 'brush' ? 0.08 : opts.kind === 'goo' ? 0.06 : Math.max(sw, sh, sd) };
    }
    const geo = pickShardGeo(part, opts, sw, sh, sd);
    const am = this.allocShardMesh(geo, cr, cg, cb);
    am.mesh.position.set(s.x, s.y, s.z);
    am.mesh.castShadow = false;
    this.scene.add(am.mesh);
    const radius = part ? (geo.boundingSphere?.radius ?? 0.3) * 0.35
      : s.sharedGeo ? (geo.boundingSphere?.radius ?? 0.3) * 0.5
      : Math.max(sw, sh, sd);
    return { mesh: am.mesh, mat: am.mat, inst: -1, slot: -1, radius };
  }

  private spawnShard(part: DebrisPart | undefined, opts: DebrisOptions,
      px: number, py: number, pz: number, color: THREE.Color): void {
    let sw = 0.25 + Math.random() * 0.55;
    let sh = 0.18 + Math.random() * 0.45;
    let sd = 0.20 + Math.random() * 0.50;
    // Unit-primitive scale: brush twigs are thin rods, goo is droplets —
    // same dims the old per-shard geometries baked in.
    const prim = this.instanced ? pickShardPrim(opts) : -1;
    if (prim === 3) [sw, sh, sd] = [0.011, 0.2 + Math.random() * 0.35, 0.011];
    else if (prim === 4) sw = sh = sd = 0.05 + Math.random() * 0.1;

    const v   = 0.75 + Math.random() * 0.25;
    const cr  = color.r * v;
    const cg  = color.g * v;
    const cb  = color.b * v;
    const sharedGeo = !!opts.shardGeos?.length;
    const tumble = 4.0 + Math.random() * 8.0;

    const { o, vel } = shardLaunch(part, opts, px, py, pz);
    const a = this.allocShard(prim, part, opts,
      { sw, sh, sd, cr, cg, cb, x: px + o.x, y: py + o.y, z: pz + o.z, sharedGeo });

    this.shards.push({
      mesh: a.mesh, mat: a.mat, inst: a.inst, slot: a.slot,
      x: px + o.x, y: py + o.y, z: pz + o.z,
      vx: vel.x, vy: vel.y, vz: vel.z,
      rx: (Math.random() - 0.5) * 2 * tumble,
      ry: (Math.random() - 0.5) * 2 * tumble,
      rz: (Math.random() - 0.5) * 2 * tumble,
      ex: 0, ey: 0, ez: 0, flatY: 1, shrink: 1,
      sw, sh, sd,
      life: (opts.kind === 'brush' ? 0.7 : 1) * (LIFE_BASE + Math.random() * LIFE_RAND),
      elapsed: 0,
      radius: a.radius,
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

  /** Distance gate — shards past ~260m are sub-pixel, so they just age
   *  out instead of paying per-shard physics + instance writes. */
  tickAge(dt: number): void {
    if (this.ghost) this.update(dt); // ghost fade is 0.15s, near or far it ends the same
    let alive = 0;
    for (const s of this.shards) {
      if (s.dead) continue;
      s.elapsed += dt;
      if (s.elapsed >= s.life) this.removeShard(s);
      else alive++;
    }
    if (alive === 0) this.dead = true;
  }

  /** Instanced shards have no Mesh — pos/tumble/scale fold into the
   *  slot's matrix; color folds into instanceColor. Called every step. */
  writeShard(s: Shard): void {
    const b = this.insts[s.inst];
    if (!b) return;
    _tmpE.set(s.ex, s.ey, s.ez);
    _tmpQ.setFromEuler(_tmpE);
    _tmpP.set(s.x, s.y, s.z);
    const k = s.shrink;
    _tmpS.set(s.sw * k, s.sh * s.flatY * k, s.sd * k);
    _tmpMat.compose(_tmpP, _tmpQ, _tmpS);
    b.mesh.setMatrixAt(s.slot, _tmpMat);
    b.mesh.instanceMatrix.needsUpdate = true;
  }

  writeShardColor(s: Shard, r: number, g: number, b: number): void {
    const bk = this.insts[s.inst];
    if (!bk) return;
    bk.mesh.setColorAt(s.slot, _tmpColor.setRGB(r, g, b));
    if (bk.mesh.instanceColor) bk.mesh.instanceColor.needsUpdate = true;
  }

  private stepShard(s: Shard, dt: number): boolean { return stepShard(this, s, dt); }
  private emitTrail(s: Shard, dt: number): void { emitTrail(s, dt); }
  private greyShard(s: Shard): void { greyShard(this, s); }
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
    if (s.mesh && s.mat) {
      this.scene.remove(s.mesh);
      if (!s.sharedGeo) s.mesh.geometry.dispose();
      Debris.shardPool.push({ mesh: s.mesh, mat: s.mat });
    } else {
      const b = this.insts[s.inst];
      if (b) { b.mesh.setMatrixAt(s.slot, _zeroM); b.mesh.instanceMatrix.needsUpdate = true; b.free.push(s.slot); }
    }
    s.dead = true;
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
    for (const b of this.insts) {
      if (!b) continue;
      this.scene.remove(b.mesh);
      let pool = Debris.instPool.get(this.insts.indexOf(b));
      if (!pool) Debris.instPool.set(this.insts.indexOf(b), pool = []);
      pool.push(b.mesh);
    }
    this.insts = [];
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
