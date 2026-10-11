import * as THREE from 'three';

import { GRAVITY, BOUNCE_Y, FRICTION_XZ, SHRINK_DUR, GREY_DUR, BASE_SPEED, EXTRA_SPEED, LIFE_BASE, LIFE_RAND } from '../core/config.js';
import { markProbe } from '../core/fxDiag.js';
import { CapGovernor } from '../core/poolPolicy.js';
import { fxPuff } from './vfx.js';
import type { Terrain } from '../world/terrain.js';
import type { SpeciesSwarm } from '../entities/swarm.js';

/**
 * Gib pool — seamless enemy shatter for instanced species.
 *
 * On death, every part INSTANCE of the body is copied into a matching gib
 * InstancedMesh at the identical world transform, so the corpse on frame 0
 * is pixel-identical to the living enemy — no pop, no swap seam (the
 * "pre-fractured swap" trick, except instanced bodies come pre-fractured
 * for free). Gibs then fly outward along their offset from the body
 * center, tumble, bounce off terrain, and shrink away once landed.
 *
 * Cheap by construction: gibs reuse the swarm's own geometries/materials,
 * one InstancedMesh per part — a whole dying swarm costs a handful of draw
 * calls and zero geometry allocation.
 */

// Cap per PART mesh. Crawler legs are 8/owner, so this is ~24 bodies' worth
// of simultaneous gibbage per part — a queue, not a budget.
const GIB_CAP = 192;
// Held under quarter-occupancy this long → buffers contract back to the
// nearest GIB_CAP multiple covering 2× live (same keep-alive contract
// as the quarks pool).

const UP_BIAS = 2;
const IMPULSE_CARRY = 6; // matches Debris — the shot's push travels through
// Smoke trail: one quarks puff per GIB_PUFF_DT per airborne gib — the
// batch absorbs it (jet/ski trails ride the same pool), landed gibs shed
// nothing. Dark wisp, slight up-drift, shed opposite velocity.
const GIB_PUFF_DT = 0.07;
const _smoke = new THREE.Vector3();

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();

/** One gib InstancedMesh for a single species part + its instance state. */
class GibMeshPool {
  readonly mesh: THREE.InstancedMesh;
  readonly per: number;
  private freeIdx: number[];
  // Parallel state arrays, indexed by gib slot
  private px = new Float32Array(GIB_CAP); private py = new Float32Array(GIB_CAP); private pz = new Float32Array(GIB_CAP);
  private vx = new Float32Array(GIB_CAP); private vy = new Float32Array(GIB_CAP); private vz = new Float32Array(GIB_CAP);
  private rx = new Float32Array(GIB_CAP); private ry = new Float32Array(GIB_CAP); private rz = new Float32Array(GIB_CAP);
  private wx = new Float32Array(GIB_CAP); private wy = new Float32Array(GIB_CAP); private wz = new Float32Array(GIB_CAP);
  private sx = new Float32Array(GIB_CAP); private sy = new Float32Array(GIB_CAP); private sz = new Float32Array(GIB_CAP);
  private cr = new Float32Array(GIB_CAP); private cg = new Float32Array(GIB_CAP); private cb = new Float32Array(GIB_CAP);
  private age = new Float32Array(GIB_CAP);
  private life = new Float32Array(GIB_CAP);
  private landedAt = new Float32Array(GIB_CAP).fill(-1);
  private puffT = new Float32Array(GIB_CAP); // next smoke-emit age per slot
  private bodyR = new Float32Array(GIB_CAP); // world-space radius for terrain hits
  live = 0;
  get cap(): number { return this.freeIdx.length + this.live; }
  private capGov = new CapGovernor();

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, per: number) {
    this.per = per;
    this.mesh = new THREE.InstancedMesh(geo, mat, GIB_CAP);
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GIB_CAP * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    markProbe(this.mesh, { kind: 'gib', label: `gib/${per}`, gib: this });
    scene.add(this.mesh);
    this.freeIdx = Array.from({ length: GIB_CAP }, (_, i) => GIB_CAP - 1 - i);
    if (!geo.boundingSphere) {geo.computeBoundingSphere();}
  }

  /** Realloc every parallel state array + the instance buffers at `cap`.
   *  Growing hands the fresh indices to freeIdx; shrinking re-packs live
   *  slots first (sparse) so nothing live is truncated. */
  private resize(cap: number): void {
    const growA = (a: Float32Array): Float32Array<ArrayBuffer> => {
      const n = new Float32Array(cap); n.set(a.subarray(0, cap)); return n; // subarray — set() throws when the source outlives the target
    };
    this.px = growA(this.px); this.py = growA(this.py); this.pz = growA(this.pz);
    this.vx = growA(this.vx); this.vy = growA(this.vy); this.vz = growA(this.vz);
    this.rx = growA(this.rx); this.ry = growA(this.ry); this.rz = growA(this.rz);
    this.wx = growA(this.wx); this.wy = growA(this.wy); this.wz = growA(this.wz);
    this.sx = growA(this.sx); this.sy = growA(this.sy); this.sz = growA(this.sz);
    this.cr = growA(this.cr); this.cg = growA(this.cg); this.cb = growA(this.cb);
    this.age = growA(this.age); this.life = growA(this.life);
    this.bodyR = growA(this.bodyR); this.puffT = growA(this.puffT);
    const la = new Float32Array(cap).fill(-1); la.set(this.landedAt); this.landedAt = la;
    const oldCap = cap / 2;
    for (let i = cap - 1; i >= oldCap; i -= 1) {this.freeIdx.push(i);}
    const mat = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    mat.array.set(this.mesh.instanceMatrix.array.subarray(0, cap * 16));
    mat.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix = mat;
    const c = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    c.array.set(this.mesh.instanceColor!.array.subarray(0, cap * 3));
    c.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = c;
  }

  private grow(): void { this.resize((this.freeIdx.length + this.live) * 2); }

  /** Pack live slots to [0, live) and realloc at the smallest GIB_CAP
   *  multiple covering 2× live — mirrors the swarm's idle-shrink so a
   *  burst spike doesn't pin peak buffers forever. Sparse slots mean a
   *  remap pass, not a truncate. */
  checkShrink(now: number): void {
    const cap = this.freeIdx.length + this.live;
    const target = this.capGov.shrinkTarget(this.live, cap, GIB_CAP, now);
    if (target === null) {return;}
    // Repack: live slots (life > 0) move down in index order.
    const remap = new Int32Array(cap).fill(-1);
    let next = 0;
    for (let i = 0; i < cap; i += 1) {if (this.life[i]! > 0) {remap[i] = ((next += 1) - 1);}}
    const moveA = (a: Float32Array): Float32Array<ArrayBuffer> => {
      const n = new Float32Array(target);
      for (let i = 0; i < cap; i += 1) {if (remap[i]! >= 0) {n[remap[i]!] = a[i]!;}}
      return n;
    };
    const npx = moveA(this.px); const npy = moveA(this.py); const npz = moveA(this.pz);
    const nvx = moveA(this.vx); const nvy = moveA(this.vy); const nvz = moveA(this.vz);
    const nrx = moveA(this.rx); const nry = moveA(this.ry); const nrz = moveA(this.rz);
    const nwx = moveA(this.wx); const nwy = moveA(this.wy); const nwz = moveA(this.wz);
    const nsx = moveA(this.sx); const nsy = moveA(this.sy); const nsz = moveA(this.sz);
    const ncr = moveA(this.cr); const ncg = moveA(this.cg); const ncb = moveA(this.cb);
    const nage = moveA(this.age); const nlife = moveA(this.life);
    const nbodyR = moveA(this.bodyR); const npuffT = moveA(this.puffT);
    const nla = new Float32Array(target).fill(-1);
    for (let i = 0; i < cap; i += 1) {if (remap[i]! >= 0) {nla[remap[i]!] = this.landedAt[i]!;}}
    this.px = npx; this.py = npy; this.pz = npz;
    this.vx = nvx; this.vy = nvy; this.vz = nvz;
    this.rx = nrx; this.ry = nry; this.rz = nrz;
    this.wx = nwx; this.wy = nwy; this.wz = nwz;
    this.sx = nsx; this.sy = nsy; this.sz = nsz;
    this.cr = ncr; this.cg = ncg; this.cb = ncb;
    this.age = nage; this.life = nlife; this.bodyR = nbodyR;
    this.landedAt = nla; this.puffT = npuffT;
    // Rebuild the mesh buffers at target, remapping each live instance.
    const mat = new THREE.InstancedBufferAttribute(new Float32Array(target * 16), 16);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(target * 3).fill(1), 3);
    const srcM = this.mesh.instanceMatrix, srcC = this.mesh.instanceColor!;
    for (let i = 0; i < cap; i += 1) {
      const j = remap[i]!;
      if (j < 0) {continue;}
      mat.array.set(srcM.array.subarray(i * 16, i * 16 + 16), j * 16);
      col.array.set(srcC.array.subarray(i * 3, i * 3 + 3), j * 3);
    }
    mat.setUsage(THREE.DynamicDrawUsage); col.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix = mat;
    this.mesh.instanceColor = col;
    mat.needsUpdate = true; col.needsUpdate = true;
    // Dead slots vanish — everything past live is a fresh free index.
    this.freeIdx = [];
    for (let i = target - 1; i >= this.live; i -= 1) {this.freeIdx.push(i);}
    this.mesh.count = Math.max(this.mesh.count, this.live);
    this.capGov.shrunk(now);
  }

  /** Take a gib slot at this exact world transform/color; grows when full. */
  spawn(matrix: THREE.Matrix4, col: THREE.Color, radius: number): number {
    let i = this.freeIdx.pop();
    if (i === undefined) { this.grow(); i = this.freeIdx.pop()!; }
    matrix.decompose(_p, _q, _s);
    _e.setFromQuaternion(_q);
    this.px[i] = _p.x; this.py[i] = _p.y; this.pz[i] = _p.z;
    this.rx[i] = _e.x; this.ry[i] = _e.y; this.rz[i] = _e.z;
    this.sx[i] = _s.x; this.sy[i] = _s.y; this.sz[i] = _s.z;
    this.cr[i] = col.r; this.cg[i] = col.g; this.cb[i] = col.b;
    const tumble = 4 + Math.random() * 8;
    this.wx[i] = (Math.random() - 0.5) * 2 * tumble;
    this.wy[i] = (Math.random() - 0.5) * 2 * tumble;
    this.wz[i] = (Math.random() - 0.5) * 2 * tumble;
    this.age[i] = 0;
    this.life[i] = LIFE_BASE + Math.random() * LIFE_RAND;
    this.landedAt[i] = -1;
    // Stagger the first puff so a 24-part burst doesn't emit in lockstep.
    this.puffT[i] = Math.random() * GIB_PUFF_DT;
    this.bodyR[i] = radius;
    this.mesh.instanceColor!.setXYZ(i, col.r, col.g, col.b);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
this.live += 1;
    return i;
  }

  setVel(i: number, vx: number, vy: number, vz: number): void {
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
  }

  update(dt: number, terrain: Terrain): void {
    // Nothing alive: skip the slot walk AND the GPU buffer upload — with
    // ~20 species pools this is 20 dead matrix writes per frame otherwise
    if (this.live === 0) {return;}
    // Walk live slots via the count bound; dead slots get compacted lazily
    // by skip (they're in freeIdx already).
    let wrote = false;
    for (let i = 0; i < this.mesh.count; i += 1) {
      if (this.life[i]! <= 0) {continue;} // dead slot
      this.age[i]! += dt;
      const landed = this.landedAt[i]! >= 0;
      const dead = this.age[i]! >= this.life[i]! || (landed && (this.age[i]! - this.landedAt[i]!) >= SHRINK_DUR);
      if (dead) {
        // Hide by collapsing the instance, recycle the slot.
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        this.life[i] = 0;
        this.freeIdx.push(i);
this.live -= 1;
        wrote = true;
        continue;
      }

      if (!landed) {
        this.vy[i]! += GRAVITY * dt;
        this.px[i]! += this.vx[i]! * dt;
        this.py[i]! += this.vy[i]! * dt;
        this.pz[i]! += this.vz[i]! * dt;
        if (this.age[i]! >= this.puffT[i]!) {
          this.puffT[i] = this.age[i]! + GIB_PUFF_DT;
          _smoke.set(this.px[i]!, this.py[i]!, this.pz[i]!);
          fxPuff(_smoke, {
            count: 1,
            velMin: [-0.4, 0.2, -0.4], velMax: [0.4, 0.8, 0.4],
            shed: [-this.vx[i]! * 0.08, 0, -this.vz[i]! * 0.08],
            lifeMin: 0.4, lifeMax: 0.7,
            sizeScale: Math.max(0.3, this.bodyR[i]! * 1.4),
            colA: [0.22, 0.2, 0.18], colB: [0.3, 0.28, 0.26],
            gravity: false,
          });
        }
        const gy = terrain.getHeight(this.px[i]!, this.pz[i]!);
        if (this.py[i]! - this.bodyR[i]! <= gy) {
          this.py[i] = gy + this.bodyR[i]!;
          this.vy[i] = -this.vy[i]! * BOUNCE_Y;
          this.vx[i]! *= FRICTION_XZ; this.vz[i]! *= FRICTION_XZ;
          this.wx[i]! *= 0.3; this.wy[i]! *= 0.3; this.wz[i]! *= 0.3;
          this.landedAt[i] = this.age[i]!;
        }
      }
      this.rx[i]! += this.wx[i]! * dt;
      this.ry[i]! += this.wy[i]! * dt;
      this.rz[i]! += this.wz[i]! * dt;

      // Landed gibs shrink away on the same clock as shard debris
      let shrink = 1;
      if (this.landedAt[i]! >= 0) {
        shrink = 1 - (this.age[i]! - this.landedAt[i]!) / SHRINK_DUR;
      }
      // Grey-out toward flat ash like shard debris
      const gt = Math.min(this.age[i]! / GREY_DUR, 1);
      const grey = this.cr[i]! * 0.299 + this.cg[i]! * 0.587 + this.cb[i]! * 0.114;
      this.mesh.instanceColor!.setXYZ(i,
        this.cr[i]! + (grey - this.cr[i]!) * gt,
        this.cg[i]! + (grey - this.cg[i]!) * gt,
        this.cb[i]! + (grey - this.cb[i]!) * gt);

      _p.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      _q.setFromEuler(_e.set(this.rx[i]!, this.ry[i]!, this.rz[i]!));
      _s.set(this.sx[i]! * shrink, this.sy[i]! * shrink, this.sz[i]! * shrink);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    // Upload only the live slot span — capacity is far larger than the
    // gib count in play, and idle pools skip the transfer entirely.
    if (this.live > 0 || wrote) {
      this.mesh.instanceMatrix.addUpdateRange(0, this.mesh.count * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor!.addUpdateRange(0, this.mesh.count * 3);
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }
}

/** Per-species: one GibMeshPool per swarm part, sharing geo+material. */
export class GibPool {
  private pools: GibMeshPool[] = [];
  private swarm: SpeciesSwarm;

  constructor(scene: THREE.Scene, swarm: SpeciesSwarm) {
    this.swarm = swarm;
    for (let i = 0; i < swarm.partCount; i += 1) {
      const src = swarm.meshes[i]!;
      const mat = Array.isArray(src.material) ? src.material[0]! : src.material;
      this.pools.push(new GibMeshPool(scene, src.geometry, mat, swarm.perFor(i)));
    }
  }

  get totalPartsPerBody(): number {
    let n = 0;
    for (const p of this.pools) {n += p.per;}
    return n;
  }

  /** Live gib slots across all part pools — dump census. */
  get live(): number {
    let n = 0;
    for (const p of this.pools) {n += p.live;}
    return n;
  }

  /** Idle-shrink pass — delegates to each part pool's compaction check. */
  checkShrink(now: number): void {
    for (const p of this.pools) {p.checkShrink(now);}
  }

  /** Allocated gib slots across part pools — census pair for `live`. */
  get cap(): number {
    let n = 0;
    for (const p of this.pools) {n += p.cap;}
    return n;
  }

  /**
   * Snapshot a live owner's part instances into gibs at their exact current
   * transforms, fling them outward from `center` (+ impulse + momentum), then
   * free the swarm slot. Returns false when the species is single-part
   * (a lone chunk flying off reads worse than the shard burst).
   */
  burst(
    ownerSlot: number, center: THREE.Vector3,
    impulseDir: THREE.Vector3 | null, inheritVel: THREE.Vector3 | null,
  ): boolean {
    if (this.totalPartsPerBody < 3) {return false;}
    let spawned = 0;
    for (let pi = 0; pi < this.pools.length; pi += 1) {
      const pool = this.pools[pi]!;
      const src = this.swarm.meshes[pi]!;
      for (let k = 0; k < pool.per; k += 1) {
        const idx = ownerSlot * pool.per + k;
        src.getMatrixAt(idx, _m);
        const c = src.instanceColor!;
        _c.setRGB(c.getX(idx), c.getY(idx), c.getZ(idx));
        // World radius ≈ geo bounding radius × max scale axis
        const geoR = pool.mesh.geometry.boundingSphere?.radius ?? 0.5;
        _m.decompose(_p, _q, _s);
        const bodyR = geoR * Math.max(_s.x, _s.y, _s.z);
        const gi = pool.spawn(_m, _c, bodyR * 0.5);
        if (gi < 0) {continue;}
        // Outward from the body center; tiny parts near the core take a
        // random dir so the burst doesn't collapse to a point
        let dx = _p.x - center.x, dy = _p.y - center.y, dz = _p.z - center.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.01) {
          dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5;
        } else { dx /= len; dy /= len; dz /= len; }
        let spd = BASE_SPEED + Math.random() * EXTRA_SPEED;
        if (impulseDir) {
          const align = dx * impulseDir.x + dy * impulseDir.y + dz * impulseDir.z;
          spd *= 1 + Math.max(0, align) * 0.9;
        }
        let vx = dx * spd, vy = dy * spd + UP_BIAS, vz = dz * spd;
        if (impulseDir) {
          vx += impulseDir.x * IMPULSE_CARRY; vy += impulseDir.y * IMPULSE_CARRY; vz += impulseDir.z * IMPULSE_CARRY;
        }
        if (inheritVel) {
          vx += inheritVel.x * 0.7; vy += inheritVel.y * 0.7; vz += inheritVel.z * 0.7;
        }
        pool.setVel(gi, vx, vy, vz);
spawned += 1;
      }
    }
    return spawned > 0;
  }

  update(dt: number, terrain: Terrain): void {
    for (const p of this.pools) {p.update(dt, terrain);}
  }
}
