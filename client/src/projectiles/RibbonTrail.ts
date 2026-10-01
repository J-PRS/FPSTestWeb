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

export class TrailBatch {
  geo = new THREE.BufferGeometry();
  mesh: THREE.Mesh;
  scene: THREE.Scene;
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
    this.scene = scene;
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
    // Aim-probe tag — the crosshair raycast resolves a slot via faceIndex
    // back to whichever RibbonTrail owns it (or proves it ownerless).
    this.mesh.userData.dbg = { kind: 'trailBatch', batch: this };
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

// A scene's trails live in a LIST of batches — 512 slots each. Overflow
// spawns another batch (one more draw call) instead of starving ribbons;
// emptied overflow batches shrink back away on release.
const batches = new Map<THREE.Scene, TrailBatch[]>();

/** Camera position for callers that can't thread one into update() —
 *  updateProjectiles stamps this once per frame so projectile ribbons can
 *  billboard (ball ribbons get theirs via an explicit argument instead). */
let sharedCamPos: THREE.Vector3 | null = null;
export function setRibbonCamera(pos: THREE.Vector3 | null): void { sharedCamPos = pos; }

function claimableBatch(scene: THREE.Scene): TrailBatch {
  let list = batches.get(scene);
  if (!list) { list = [new TrailBatch(scene)]; batches.set(scene, list); }
  for (const b of list) if (b.free.length > 0) return b;
  const b = new TrailBatch(scene);
  list.push(b);
  return b;
}

/** Triangles per ribbon slot — the aim probe maps faceIndex → slot. */
export const RIBBON_TRIS_PER_SLOT = IDX / 3;

/** Any nonzero float in a slot's color span = pixels still on screen.
 *  Scans are bounded by the high-water mark — slots above it were never
 *  used, so they're provably black. */
function slotLit(b: TrailBatch, s: number): boolean {
  const base = s * VERTS * 3;
  for (let i = 0; i < VERTS * 3; i++) if (b.col[base + i] !== 0) return true;
  return false;
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
  private _camX = NaN;
  private _camY = NaN;
  private _camZ = NaN;
  private stopped = false;
  // Wall-clock of the last update() call — the orphan detector: every
  // owner ticks its ribbons each frame, so a stale stamp means the owner
  // died without dispose (leaked slot + frozen streak on screen).
  private lastUpdateAt = 0;

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

  private static liveSet = new Set<RibbonTrail>();
  /** Debug dump for __trailDump — one row per live ribbon. */
  static dump(): Record<string, unknown>[] {
    const now = performance.now();
    const out: Record<string, unknown>[] = [];
    for (const r of RibbonTrail.liveSet) {
      // head pos + a centroid over live samples — enough to point at the
      // on-screen streak a slot is actually drawing.
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < r.count; i++) { cx += r.px[i]; cy += r.py[i]; cz += r.pz[i]; }
      const n = Math.max(1, r.count);
      out.push({
        slot: r.slot, count: r.count, pushed: r.pushed, stopped: r.stopped,
        life: r.life, bb: r.billboard, done: r.done,
        lit: r.slot >= 0 && slotLit(r.batch, r.slot),
        starved: r.starvedPushes,
        time: +r.time.toFixed(1),
        head: r.head >= 0
          ? `${r.px[r.head].toFixed(0)},${r.py[r.head].toFixed(0)},${r.pz[r.head].toFixed(0)}` : '-',
        mid: `${(cx / n).toFixed(0)},${(cy / n).toFixed(0)},${(cz / n).toFixed(0)}`,
        updMs: Math.round(now - r.lastUpdateAt),
      });
    }
    return out;
  }

  /** Aim-probe lookup: the RibbonTrail holding (batch, slot), or a
 *  {owner:false, lit} verdict proving a lit slot nobody owns. */
  static identify(batch: TrailBatch, slot: number): Record<string, unknown> {
    for (const r of RibbonTrail.liveSet) {
      if (r.batch !== batch || r.slot !== slot) continue;
      return {
        slot, owner: true, stopped: r.stopped, done: r.done, bb: r.billboard,
        life: r.life, count: r.count, time: +r.time.toFixed(1),
        head: r.head >= 0
          ? `${r.px[r.head].toFixed(0)},${r.py[r.head].toFixed(0)},${r.pz[r.head].toFixed(0)}` : '-',
        updMs: Math.round(performance.now() - r.lastUpdateAt),
      };
    }
    return { slot, owner: false, lit: slotLit(batch, slot) };
  }

  /** Ribbons no owner has updated within `staleMs` — leaked slots. */
  static orphans(staleMs = 1000): { count: number; slots: number[]; rows: Record<string, unknown>[] } {
    const now = performance.now();
    const slots: number[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const r of RibbonTrail.liveSet) {
      if (now - r.lastUpdateAt <= staleMs) continue;
      if (r.slot >= 0) slots.push(r.slot);
      rows.push({ slot: r.slot, bb: r.billboard, count: r.count, stopped: r.stopped, updMs: Math.round(now - r.lastUpdateAt) });
    }
    return { count: rows.length, slots, rows };
  }
  /** Slots lit in the batch color buffer — and, more importantly, slots
   *  lit WITHOUT a `used` owner. orphans() only sees stale RibbonTrail
   *  objects; a slot leaked by a path that bypassed releaseSlot keeps its
   *  last pixels on screen forever with no object left to blame. */
  static litAudit(): { lit: number; unowned: number[] } {
    const unowned: number[] = [];
    let lit = 0;
    for (const list of batches.values()) {
      for (const b of list) {
        for (let s = 0; s < b.hw; s++) {
          if (!slotLit(b, s)) continue;
          lit++;
          if (!b.used.has(s)) unowned.push(s);
        }
      }
    }
    return { lit, unowned };
  }

  static reapedLit = 0;
  /** Sweep unowned lit slots to black — the auto-heal half of litAudit,
   *  so any undiscovered leak path self-cleans instead of freezing a
   *  streak midair. Runs once per frame from updateProjectiles. */
  static sweepLit(): void {
    for (const list of batches.values()) {
      for (const b of list) {
        let dirty = false;
        for (let s = 0; s < b.hw; s++) {
          if (b.used.has(s) || !slotLit(b, s)) continue;
          const base = s * VERTS * 3;
          b.col.fill(0, base, base + VERTS * 3);
          b.mark(base, base + VERTS * 3);
          dirty = true;
          RibbonTrail.reapedLit++;
        }
        if (dirty) b.flush();
      }
    }
  }

  /** Per-ribbon state for the Alt+Q dump — pairs a dead lane with its shell. */
  dbg(): { slot: number; count: number; stopped: boolean; lit: boolean; starved: number } {
    return {
      slot: this.slot, count: this.count, stopped: this.stopped,
      lit: this.slot >= 0 && slotLit(this.batch, this.slot),
      starved: this.starvedPushes,
    };
  }
  /** Batch census — a slot that's "live" but past drawRange or in an
   *  invisible mesh explains ribbons that exist but never render. */
  static batchStats(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const [scene, list] of batches) {
      for (const b of list) {
        out.push({
          idx: list.indexOf(b), free: b.free.length, used: b.used.size, hw: b.hw,
          drawRange: b.geo.drawRange.count, meshVisible: b.mesh.visible,
          inScene: b.mesh.parent === scene,
        });
      }
    }
    return out;
  }

  private claimSlot(scene: THREE.Scene): void {
    this.batch = claimableBatch(scene);
    this.slot = this.batch.free.pop()!;
    RibbonTrail.liveSet.add(this);
    this.batch.used.add(this.slot); this.batch.slotsDirty = true; this._lf.fill(-1);
  }

  private releaseSlot(): void {
    RibbonTrail.liveSet.delete(this);
    if (this.slot < 0) return;
    const b = this.slot * VERTS * 3;
    this.batch.pos.fill(0, b, b + VERTS * 3);
    this.batch.col.fill(0, b, b + VERTS * 3);
    this.batch.mark(b, b + VERTS * 3);
    // Upload NOW — mark() alone defers to the next ribbon's update(), and
    // if this was the last live ribbon nothing ever flushes: the slot's
    // stale verts stay lit as a frozen streak across the map.
    this.batch.flush();
    this.batch.used.delete(this.slot);
    this.batch.slotsDirty = true;
    this.batch.free.push(this.slot);
    // Keep descending so pop() hands out the smallest slot — used slots
    // stay packed at the front of the index buffer for drawRange.
    this.batch.free.sort((x, y) => y - x);
    this.slot = -1;
    // Shrink: an emptied overflow batch is retired — batch 0 is the floor.
    if (this.batch.used.size === 0) {
      const list = batches.get(this.batch.scene);
      if (list && list.length > 1 && list[0] !== this.batch) {
        list.splice(list.indexOf(this.batch), 1);
        this.batch.scene.remove(this.batch.mesh);
        this.batch.geo.dispose();
      }
    }
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
    this.starvedPushes = 0;
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

  // Pushes rejected for near-zero velocity — a ribbon whose starved count
  // climbs while count stays 0 emits nothing (silent no-trail bug).
  private starvedPushes = 0;

  /** Record a new sample at the projectile's current position/facing. */
  push(pos: THREE.Vector3, vel: THREE.Vector3): void {
    if (this.stopped) return;
    _dir.copy(vel);
    if (_dir.lengthSq() < 1e-6) { this.starvedPushes++; return; }
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
    this.starvedPushes = 0;
    if (this.slot >= 0) {
      const b = this.slot * VERTS * 3;
      this.batch.col.fill(0, b, b + VERTS * 3);
      this.batch.mark(b, b + VERTS * 3);
      this.batch.flush(); // same as releaseSlot — a clear is unobservable otherwise
    }
  }

  /** True once the last sample has fully faded — safe to dispose. */
  get done(): boolean {
    if (this.count === 0) return true;
    return this.time - this.st[this.head] > this.life;
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    this.lastUpdateAt = performance.now();
    camPos = camPos ?? sharedCamPos ?? undefined;
    this.time += dt;
    if (this.slot < 0 || this.count < 2) return;
    const { camMoved, rebillboard } = this.cameraState(camPos);
    const pos = this.batch.pos;
    const base = this.slot * VERTS * 3;
    // Positions only move when new samples arrive (or a billboard needs
    // re-siding as the camera moves) — the rest of the ribbon is static,
    // only its colors fade.
    const freshFrom = this.freshFromIndex(camMoved);
    this.pushed = 0;
    const wrote = this.rewriteSamples(base, pos, freshFrom, rebillboard);
    const dirty = this.glueBoundary(base, pos) || wrote;
    if (dirty) {
      this.batch.mark(base, base + this.count * 6);
      this.batch.flush();
    }
  }

  /** Billboard bookkeeping: camMoved gates whether OLD samples get
   *  re-sided (freshFrom=0), while rebillboard carries the camera for
   *  FRESH samples — those always need the camera-facing side even when
   *  the camera is parked, else new verts keep the spawn-plane side and
   *  render edge-on. Past 200m the strip is sub-pixel, so skip the
   *  cross-product entirely. */
  private cameraState(camPos?: THREE.Vector3): { camMoved: boolean; rebillboard?: THREE.Vector3 } {
    if (!camPos) return { camMoved: true };
    const dx = camPos.x - this.px[this.head];
    const dy = camPos.y - this.py[this.head];
    const dz = camPos.z - this.pz[this.head];
    const far = dx * dx + dy * dy + dz * dz > 200 * 200;
    const camMoved = this._camX !== camPos.x || this._camY !== camPos.y || this._camZ !== camPos.z;
    this._camX = camPos.x; this._camY = camPos.y; this._camZ = camPos.z;
    return { camMoved, rebillboard: this.billboard && !far ? camPos : undefined };
  }

  private rewriteSamples(base: number, pos: Float32Array, freshFrom: number, rebillboard?: THREE.Vector3): boolean {
    let dirty = false;
    for (let i = this.liveFrom; i < this.count; i++) {
      // oldest -> newest
      const s = (this.head - this.count + 1 + i + MAX_SAMPLES) % MAX_SAMPLES;
      const fade = Math.max(0, 1 - (this.time - this.st[s]) / this.life);
      const o = base + i * 6;
      if (i >= freshFrom) { this.writeSample(s, o, fade, rebillboard, pos); dirty = true; }
      if (this.applyFadeBucket(i, o, fade)) dirty = true;
    }
    return dirty;
  }

  // The index buffer draws every quad in the slot — the one spanning the
  // last written sample and the next (zeroed 0,0,0) renders as a streak
  // from the head down to world origin. Gluing the boundary verts to the
  // head makes it degenerate instead.
  private glueBoundary(base: number, pos: Float32Array): boolean {
    if (this.count === 0 || this.count >= MAX_SAMPLES) return false;
    const o = base + this.count * 6;
    const hx = this.px[this.head], hy = this.py[this.head], hz = this.pz[this.head];
    pos[o] = hx; pos[o + 1] = hy; pos[o + 2] = hz;
    pos[o + 3] = hx; pos[o + 4] = hy; pos[o + 5] = hz;
    this.batch.mark(base, base + (this.count + 1) * 6);
    return true;
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
    const v = EMIT_GAIN * (fq / 255);
    col[o] = this.baseColor.r * v;
    col[o + 1] = this.baseColor.g * v;
    col[o + 2] = this.baseColor.b * v;
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
