import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ, SHRINK_DUR, GREY_DUR, BASE_SPEED, EXTRA_SPEED, LIFE_BASE, LIFE_RAND, PLAYER_RADIUS } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { fxPuff } from './vfx.js';

const TRAIL_INTERVAL  = 0.03; // seconds between trail emission
const TRAIL_LIFE      = 0.8;  // trail particle lifetime
const _trailPos = new THREE.Vector3();

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
  brush: boolean;
  goo: boolean;
  /** Geometry borrowed from the dying body — never dispose it. */
  sharedGeo: boolean;
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
  /** 'brush' = thin sticks that flutter; 'goo' = organic splat blobs that
   *  hit the ground and STICK. */
  kind?: 'rock' | 'brush' | 'goo';
  /** Real fragments of the dying body (tumbleweed twigs) — shards use
   *  these geometries so the burst is made of the thing that died. */
  shardGeos?: THREE.BufferGeometry[];
  /** Posed body parts — one shard per part, spawned AT its world
   *  centroid (pos is absolute, px/py/pz only seed the outward burst
   *  direction). Owned geometries: disposed when the shard dies. */
  parts?: { geo: THREE.BufferGeometry; pos: THREE.Vector3 }[];
}

type DebrisPart = NonNullable<DebrisOptions['parts']>[number];
type Vec3Like = { x: number; y: number; z: number };

function pickShardGeo(part: DebrisPart | undefined, opts: DebrisOptions, sw: number, sh: number, sd: number): THREE.BufferGeometry {
  if (part) return part.geo;
  if (opts.shardGeos?.length) {
    return opts.shardGeos[Math.floor(Math.random() * opts.shardGeos.length)]!;
  }
  if (opts.kind === 'brush') {
    // Splintered twig — thin tapered stick, random length
    return new THREE.CylinderGeometry(0.008, 0.014, 0.2 + Math.random() * 0.35, 3);
  }
  if (opts.kind === 'goo') {
    // Splat blob — organic pop into droplets
    return new THREE.SphereGeometry(0.05 + Math.random() * 0.1, 5, 4);
  }
  const geoType = Math.random();
  const m = Math.max(sw, sh, sd);
  const geo = geoType < 0.4 ? new THREE.TetrahedronGeometry(m, 0)
    : geoType < 0.7 ? new THREE.DodecahedronGeometry(m, 0)
    : new THREE.IcosahedronGeometry(m, 0);
  geo.scale(sw / m, sh / m, sd / m);
  return geo;
}

function partLaunch(part: DebrisPart, opts: DebrisOptions, px: number, py: number, pz: number):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  // Body part: spawn at its own centroid, fly outward from the
  // burst center along the part's offset (a head pops UP off the
  // neck, an arm goes sideways — dismemberment, not shrapnel).
  const o = new THREE.Vector3(part.pos.x - px, part.pos.y - py, part.pos.z - pz);
  const l = Math.hypot(o.x, o.y, o.z);
  const dx = l > 0.01 ? o.x / l : Math.random() * 2 - 1;
  const dy = l > 0.01 ? o.y / l : Math.random() * 0.5 + 0.5;
  const dz = l > 0.01 ? o.z / l : Math.random() * 2 - 1;
  const spd = (BASE_SPEED * 0.6) + Math.random() * EXTRA_SPEED * 0.6;
  const vel = new THREE.Vector3(dx * spd, dy * spd + 1.5, dz * spd);
  if (opts.impulseDir) vel.addScaledVector(opts.impulseDir, 6);
  if (opts.inheritVel) vel.addScaledVector(opts.inheritVel, 0.7);
  return { o, vel };
}

function shellLaunch(opts: DebrisOptions):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  // Surface-sampled: random unit direction, shard sits ON the shell
  // (0.55–0.95R so pieces overlap — no gaps in the first frame) and
  // flies along that normal — the body bursts outward, not just apart.
  const dx = Math.random() * 2 - 1;
  const dy = Math.random() * 2 - 1;
  const dz = Math.random() * 2 - 1;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ndx = dx / len, ndy = dy / len, ndz = dz / len;
  const r = opts.shellRadius! * (0.55 + Math.random() * 0.4);
  const o = new THREE.Vector3(ndx * r, ndy * r, ndz * r);
  // Speed gradient: shards on the far side (aligned with the shot)
  // fly fastest — the burst wave travels THROUGH the body.
  let spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
  if (opts.impulseDir) {
    const align = ndx * opts.impulseDir.x + ndy * opts.impulseDir.y + ndz * opts.impulseDir.z;
    spd *= 1 + Math.max(0, align) * 0.9;
  }
  const vel = new THREE.Vector3(ndx * spd, ndy * spd + 1.5, ndz * spd);
  // ~40% of the shot's push carried through the shards
  if (opts.impulseDir) vel.addScaledVector(opts.impulseDir, 6);
  if (opts.inheritVel) vel.addScaledVector(opts.inheritVel, 0.7);
  return { o, vel };
}

// Shard origin offset (o) + launch velocity (vel) for the three spawn
// modes: posed body part, shell-sampled burst, or plain spread cone.
function shardLaunch(part: DebrisPart | undefined, opts: DebrisOptions, px: number, py: number, pz: number):
  { o: THREE.Vector3; vel: THREE.Vector3 } {
  if (part) return partLaunch(part, opts, px, py, pz);
  if (opts.shellRadius) return shellLaunch(opts);
  const o = new THREE.Vector3(
    (Math.random() - 0.5) * opts.spreadX,
    (Math.random() - 0.5) * opts.spreadY,
    (Math.random() - 0.5) * opts.spreadZ);
  const ang = Math.random() * Math.PI * 2;
  const elv = Math.random() * Math.PI * 0.65;
  const spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
  return {
    o,
    vel: new THREE.Vector3(
      Math.cos(elv) * Math.cos(ang) * spd,
      Math.sin(elv) * spd + 2.0,
      Math.cos(elv) * Math.sin(ang) * spd),
  };
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

  // Returns false when the shard has fully shrunk away after landing
  private stepShard(s: Shard, dt: number): boolean {
    // Physics — brush shards flutter: light gravity, air drag, soft bounce
    s.vy += GRAVITY * (s.brush ? 0.3 : 1) * dt;
    if (s.brush) {
      const drag = 1 - 1.2 * dt;
      s.vx *= drag; s.vz *= drag;
    }
    s.x  += s.vx * dt;
    s.y  += s.vy * dt;
    s.z  += s.vz * dt;

    // Terrain bounce
    const gy = this.terrain.getHeight(s.x, s.z);
    if (s.y - s.radius <= gy) {
      s.y   = gy + s.radius;
      if (s.goo) {
        // Splat — sticks where it lands, flattens, shrinks away fast
        s.vy = 0; s.vx *= 0.1; s.vz *= 0.1;
        s.mesh.scale.y = 0.25;
      } else {
        s.vy  = -s.vy * (s.brush ? 0.25 : BOUNCE_Y); // twigs flop, not bounce
        s.vx *= FRICTION_XZ;
        s.vz *= FRICTION_XZ;
      }
      s.rx *= 0.3; s.ry *= 0.3; s.rz *= 0.3;
      if (!s.landed) { s.landed = true; s.landedAt = s.elapsed; }
    }

    s.mesh.position.set(s.x, s.y, s.z);
    s.mesh.rotation.x += s.rx * dt;
    s.mesh.rotation.y += s.ry * dt;
    s.mesh.rotation.z += s.rz * dt;

    if (!s.landed) this.emitTrail(s, dt);
    this.greyShard(s);
    return this.shrinkLanded(s);
  }

  // Trail puffs ride the shared quarks batch — a kill storm used to be a
  // draw call per puff per shard per interval (the 5000+ draw-call spikes).
  private emitTrail(s: Shard, dt: number): void {
    s.trailTimer += dt;
    while (s.trailTimer >= TRAIL_INTERVAL) {
      s.trailTimer -= TRAIL_INTERVAL;
      _trailPos.set(s.x, s.y, s.z);
      fxPuff(_trailPos, {
        count: 1,
        velMin: [0, 0, 0], velMax: [0, 0, 0],
        lifeMin: TRAIL_LIFE, lifeMax: TRAIL_LIFE,
        sizeScale: s.radius * 0.4 / 0.15,
        colA: [s.cr, s.cg, s.cb], colB: [s.cr, s.cg, s.cb],
        additive: true,
        gravity: false,
      });
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

  private removeShard(s: Shard): void {
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
