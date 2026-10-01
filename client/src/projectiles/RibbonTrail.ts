import * as THREE from 'three';

import { BLOOM_LAYER, EMIT_GAIN } from '../core/config.js';

const MAX_SAMPLES = 48;
const VERTS = MAX_SAMPLES * 2;
const IDX = (MAX_SAMPLES - 1) * 6;

const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();

/**
 * Flat ribbon trail — a triangle strip following the projectile.
 *
 * Every ribbon shares ONE merged BufferGeometry (a slot each) under a
 * single Mesh: 240+ live trails used to cost 240 draw calls — the top
 * Mesh family in the LOW-FPS dumps. Now the whole layer is one call;
 * freed slots just zero their slice (degenerate tris cost nothing).
 */
const MAX_TRAILS = 512;

class TrailBatch {
  geo = new THREE.BufferGeometry();
  mesh: THREE.Mesh;
  pos: Float32Array;
  col: Float32Array;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  free: number[] = [];
  used = new Set<number>();
  dirty = false;
  // Dirty span in float-array indices — a single live trail used to
  // re-upload the whole 512-slot buffer every frame (~1.2MB).
  dirtyLo = Infinity;
  dirtyHi = 0;

  mark(lo: number, hi: number): void {
    if (lo < this.dirtyLo) this.dirtyLo = lo;
    if (hi > this.dirtyHi) this.dirtyHi = hi;
    this.dirty = true;
  }

  // Slots alloc lowest-first so the used range stays dense; the highest-
  // watermark only changes on alloc/free, not per flush.
  hw = 0;
  slotsDirty = true;

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(MAX_TRAILS * VERTS * 3);
    this.col = new Float32Array(MAX_TRAILS * VERTS * 3);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('color', this.colAttr);
    const idx = new Uint32Array(MAX_TRAILS * IDX);
    for (let r = 0; r < MAX_TRAILS; r++) {
      const base = r * VERTS, io = r * IDX;
      for (let i = 0; i < MAX_SAMPLES - 1; i++) {
        const o = io + i * 6, v = base + i * 2;
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
        idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(BLOOM_LAYER);
    for (let s = MAX_TRAILS - 1; s >= 0; s--) this.free.push(s);
    scene.add(this.mesh);
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.dirtyHi - this.dirtyLo;
    if (n > 0) {
      this.posAttr.clearUpdateRanges();
      this.posAttr.addUpdateRange(this.dirtyLo, n);
      this.posAttr.needsUpdate = true;
      this.colAttr.clearUpdateRanges();
      this.colAttr.addUpdateRange(this.dirtyLo, n);
      this.colAttr.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = 0;
    if (this.slotsDirty) {
      this.slotsDirty = false;
      let hw = 0;
      for (const s of this.used) if (s + 1 > hw) hw = s + 1;
      this.hw = hw;
    }
    this.geo.setDrawRange(0, this.hw * IDX);
  }
}

const batches = new Map<THREE.Scene, TrailBatch>();
function batchFor(scene: THREE.Scene): TrailBatch {
  let b = batches.get(scene);
  if (!b) { b = new TrailBatch(scene); batches.set(scene, b); }
  return b;
}

export class RibbonTrail {
  private batch!: TrailBatch;
  private slot = -1;

  // Ring buffer of samples: position + side vector + emit time
  private px = new Float32Array(MAX_SAMPLES);
  private py = new Float32Array(MAX_SAMPLES);
  private pz = new Float32Array(MAX_SAMPLES);
  private sx = new Float32Array(MAX_SAMPLES);
  private sy = new Float32Array(MAX_SAMPLES);
  private sz = new Float32Array(MAX_SAMPLES);
  private st = new Float32Array(MAX_SAMPLES);
  private head = -1;
  private count = 0;
  // Samples appended since the last update() — only those move; older
  // samples keep their positions and just fade.
  private pushed = 0;
  private time = 0;
  private _far = 0;
  private _camX = NaN;
  private _camY = NaN;
  private _camZ = NaN;
  private stopped = false;

  // Direction per sample — needed by billboard mode to derive the camera-facing
  // side vector at update time (side can't be frozen at push since view moves)
  private dx = new Float32Array(MAX_SAMPLES);
  private dy = new Float32Array(MAX_SAMPLES);
  private dz = new Float32Array(MAX_SAMPLES);
  // Last written fade bucket per ribbon position (-1 = never written).
  // Fades only need rewriting when they cross a 1/255 step — a parked
  // camera + mature trail writes nothing at all.
  private _lf = new Int16Array(MAX_SAMPLES).fill(-1);
  // Scan floor for the update loop — tail slots past it are provably
  // fq===0 forever (fades only decrease with time).
  private liveFrom = 0;

  private baseColor: THREE.Color;
  private width: number;
  private life: number;
  private vOffset: number; // offset along the ribbon's in-plane "up" (⊥ side)
  private billboard: boolean; // width axis faces the camera each frame

  // Free-list — projectiles churn ribbons constantly; sample buffers are
  // fixed-size so reuse is free.
  private static poolFixed: RibbonTrail[] = [];
  private static poolBillboard: RibbonTrail[] = [];

  static acquire(scene: THREE.Scene, color: number, width = 0.5, life = 0.3, vOffset = 0, billboard = false): RibbonTrail {
    const pool = billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    const r = pool.pop();
    if (r) {
      r.reinit(scene, color, width, life, vOffset);
      return r;
    }
    return new RibbonTrail(scene, color, width, life, vOffset, billboard);
  }

  private claimSlot(scene: THREE.Scene): void {
    this.batch = batchFor(scene);
    this.slot = this.batch.free.pop() ?? -1;
    if (this.slot >= 0) { this.batch.used.add(this.slot); this.batch.slotsDirty = true; this._lf.fill(-1); }
  }

  private releaseSlot(): void {
    if (this.slot < 0) return;
    const b = this.slot * VERTS * 3;
    this.batch.pos.fill(0, b, b + VERTS * 3);
    this.batch.col.fill(0, b, b + VERTS * 3);
    this.batch.mark(b, b + VERTS * 3);
    this.batch.used.delete(this.slot);
    this.batch.slotsDirty = true;
    this.batch.free.push(this.slot);
    // Keep descending so pop() hands out the smallest slot — used slots
    // stay packed at the front of the index buffer for drawRange.
    this.batch.free.sort((x, y) => y - x);
    this.slot = -1;
  }

  private reinit(scene: THREE.Scene, color: number, width: number, life: number, vOffset: number): void {
    this.width = width;
    this.life = life;
    this.vOffset = vOffset;
    this.baseColor.setHex(color);
    this.stopped = false;
    this.time = 0;
    this.head = -1;
    this.count = 0;
    this.pushed = 0;
    this.liveFrom = 0;
    this._lf.fill(-1);
    this.claimSlot(scene);
  }

  private constructor(scene: THREE.Scene, color: number, width = 0.5, life = 0.3, vOffset = 0, billboard = false) {
    this.width = width;
    this.life = life;
    this.vOffset = vOffset;
    this.billboard = billboard;
    this.baseColor = new THREE.Color(color);
    this.claimSlot(scene);
  }

  /** Record a new sample at the projectile's current position/facing. */
  push(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.stopped) return;
    _dir.copy(vel);
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();
    // Side vector: perpendicular to velocity, biased to the world-horizontal plane
    _side.crossVectors(_dir, Math.abs(_dir.y) < 0.95 ? _up : _fwd).normalize();

    // Lane offset along the ribbon plane's "up" (⊥ both dir and side)
    let ox = 0, oy = 0, oz = 0;
    if (this.vOffset !== 0) {
      ox = (_dir.y * _side.z - _dir.z * _side.y) * -this.vOffset;
      oy = (_dir.z * _side.x - _dir.x * _side.z) * -this.vOffset;
      oz = (_dir.x * _side.y - _dir.y * _side.x) * -this.vOffset;
    }

    this.head = (this.head + 1) % MAX_SAMPLES;
    this.px[this.head] = pos.x + ox; this.py[this.head] = pos.y + oy; this.pz[this.head] = pos.z + oz;
    this.sx[this.head] = _side.x; this.sy[this.head] = _side.y; this.sz[this.head] = _side.z;
    this.dx[this.head] = _dir.x; this.dy[this.head] = _dir.y; this.dz[this.head] = _dir.z;
    this.st[this.head] = this.time;
    if (this.count < MAX_SAMPLES) this.count++;
    this.pushed++;
  }

  /** Stop emitting — ribbon fades out where it is. */
  stop(): void { this.stopped = true; }

  /** Drop all samples — call after a position discontinuity (teleport/respawn)
   *  so the ribbon doesn't stretch a streak across the jump. */
  clear(): void {
    this.head = -1;
    this.count = 0;
    this.pushed = 0;
    this.liveFrom = 0;
    if (this.slot >= 0) {
      const b = this.slot * VERTS * 3;
      this.batch.col.fill(0, b, b + VERTS * 3);
      this.batch.mark(b, b + VERTS * 3);
    }
  }

  /** True once the last sample has fully faded — safe to dispose. */
  get done(): boolean {
    if (this.count === 0) return true;
    return this.time - this.st[this.head] > this.life;
  }

  /** Cadence gate: EVERY ribbon rewrites at ~30Hz — trails live <0.5s,
   *  so half-rate fades are invisible and the per-sample loop halves.
   *  Returns whether the caller should early-out, and (via out-far)
   *  whether the trail counts as far for the billboard freeze. */
  private skipThisFrame(camPos: THREE.Vector3 | undefined, outFar: { v: boolean }): boolean {
    if (!camPos) return (this._far ^= 1) === 1;
    const dx = camPos.x - this.px[this.head], dy = camPos.y - this.py[this.head], dz = camPos.z - this.pz[this.head];
    outFar.v = dx * dx + dy * dy + dz * dz > 200 * 200;
    return (this._far ^= 1) === 1;
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    this.time += dt;
    if (this.slot < 0 || this.count < 2) return;
    const outFar = { v: false };
    if (this.skipThisFrame(camPos, outFar)) return;
    const far = outFar.v;

    // Billboard sides only change when the camera moves — a parked camera
    // makes the per-sample cross-product + position rewrite a pure no-op.
    const camMoved = !camPos
      || this._camX !== camPos.x || this._camY !== camPos.y || this._camZ !== camPos.z;
    if (camPos) { this._camX = camPos.x; this._camY = camPos.y; this._camZ = camPos.z; }

    const pos = this.batch.pos;
    const base = this.slot * VERTS * 3;
    // Positions only move when new samples arrive (or a billboard needs
    // re-siding as the camera moves) — the rest of the ribbon is static,
    // only its colors fade.
    const freshFrom = this.freshFromIndex(camMoved);
    this.pushed = 0;
    const rebillboard = camPos && camMoved && !far ? camPos : undefined;
    let dirty = false;
    for (let i = this.liveFrom; i < this.count; i++) {
      // oldest -> newest
      const s = (this.head - this.count + 1 + i + MAX_SAMPLES) % MAX_SAMPLES;
      const fade = Math.max(0, 1 - (this.time - this.st[s]) / this.life);
      const o = base + i * 6;
      if (i >= freshFrom) { this.writeSample(s, o, fade, rebillboard, pos); dirty = true; }
      if (this.applyFadeBucket(i, o, fade)) dirty = true;
    }
    if (dirty) {
      this.batch.mark(base, base + this.count * 6);
      this.batch.flush();
    }
  }

  /** Fade-bucket write for one slot. Fully-faded tail samples stay at 0
   *  forever (fades only fall), so the scan floor advances past them and
   *  dead slots stop costing iterations. */
  private applyFadeBucket(i: number, o: number, fade: number): boolean {
    const fq = (fade * 255) | 0;
    if (fq === 0 && i === this.liveFrom) this.liveFrom = i + 1;
    if (this._lf[i] === fq) return false;
    this._lf[i] = fq;
    const col = this.batch.col;
    const e = EMIT_GAIN * fade;
    col[o] = this.baseColor.r * e; col[o + 1] = this.baseColor.g * e; col[o + 2] = this.baseColor.b * e;
    col[o + 3] = col[o]; col[o + 4] = col[o + 1]; col[o + 5] = col[o + 2];
    return true;
  }

  private freshFromIndex(camMoved: boolean): number {
    if (this.billboard && camMoved) return 0;
    if (this.stopped) return this.count;
    return this.count - Math.min(this.pushed, this.count);
  }

  // EMIT_GAIN: vertex colors go HDR-hot so the ribbon clears the bloom
  // threshold; ACES brings the display color back to the authored hue.
  private writeSample(s: number, o: number, fade: number, rebillboard: THREE.Vector3 | undefined, pos: Float32Array): void {
    let sx = this.sx[s], sy = this.sy[s], sz = this.sz[s];
    if (rebillboard) {
      const s3 = this.sideFor(s, rebillboard);
      if (s3) { sx = s3[0]!; sy = s3[1]!; sz = s3[2]!; }
    }
    const w = this.width * 0.5 * fade;
    pos[o] = this.px[s] - sx * w;
    pos[o + 1] = this.py[s] - sy * w;
    pos[o + 2] = this.pz[s] - sz * w;
    pos[o + 3] = this.px[s] + sx * w;
    pos[o + 4] = this.py[s] + sy * w;
    pos[o + 5] = this.pz[s] + sz * w;
  }

  // Side = dir x (dir to camera): ribbon plane always faces the viewer.
  private static _s3 = new Float32Array(3);
  private sideFor(s: number, camPos: THREE.Vector3): Float32Array | null {
    const vx = camPos.x - this.px[s], vy = camPos.y - this.py[s], vz = camPos.z - this.pz[s];
    let sx = this.dy[s] * vz - this.dz[s] * vy;
    let sy = this.dz[s] * vx - this.dx[s] * vz;
    let sz = this.dx[s] * vy - this.dy[s] * vx;
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len <= 1e-6) return null;
    const o = RibbonTrail._s3;
    o[0] = sx / len; o[1] = sy / len; o[2] = sz / len;
    return o;
  }

  /** Release back to the pool — buffers/slot kept for reuse. */
  dispose(_scene: THREE.Scene): void {
    this.releaseSlot();
    const pool = this.billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    pool.push(this);
  }
}
