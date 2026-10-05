import * as THREE from 'three';

import { BLOOM_LAYER } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { markProbe } from '../core/fxDiag.js';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';

// Samples per ribbon slot — the batch's index/vertex layout is built
// around it, and RibbonTrail's ring buffer is the same length.
export const RIBBON_SAMPLES = 48;
const VERTS = RIBBON_SAMPLES * 2;
const IDX = (RIBBON_SAMPLES - 1) * 6;
/** Floats (xyz) one slot spans in the position/color buffers. */
export const RIBBON_FLOATS_PER_SLOT = VERTS * 3;
/** Triangles per ribbon slot — the aim probe maps faceIndex → slot. */
export const RIBBON_TRIS_PER_SLOT = IDX / 3;

/**
 * One merged BufferGeometry holding MAX_TRAILS ribbon slots under a
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
    if (lo < this.dirtyLo) {this.dirtyLo = lo;}
    if (hi > this.dirtyHi) {this.dirtyHi = hi;}
    this.dirty = true;
  }

  /** Generation per slot (VFX P2). claim() bumps it, so a stale handle
   *  holding (slot, oldGen) after the slot got re-issued is refused at
   *  owns() — double-ownership dies at the check, not via sweeps. */
  readonly gen = new Uint32Array(MAX_TRAILS);

  claim(): number {
    const s = this.free.pop()!;
    this.gen[s] = this.gen[s]! + 1;
    this.used.add(s);
    this.slotsDirty = true;
    return s;
  }

  /** True while (slot, gen) is the slot's current owner. */
  owns(slot: number, gen: number): boolean {
    return this.used.has(slot) && this.gen[slot] === gen;
  }

  release(slot: number): void {
    if (!this.used.delete(slot)) {return;} // stale release can't double-free
    const b = slot * RIBBON_FLOATS_PER_SLOT;
    this.pos.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
    this.col.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
    this.mark(b, b + RIBBON_FLOATS_PER_SLOT);
    // Upload NOW — mark() alone defers to the next ribbon's update(), and
    // if this was the last live ribbon nothing ever flushes: the slot's
    // stale verts stay lit as a frozen streak across the map.
    this.flush();
    this.slotsDirty = true;
    this.free.push(slot);
    // Keep descending so pop() hands out the smallest slot — used slots
    // stay packed at the front of the index buffer for drawRange.
    this.free.sort((x, y) => y - x);
  }

  // Union of what's already queued on the attrs since the last render.
  // flush() runs per ribbon, and clearUpdateRanges() would erase the
  // spans earlier ribbons queued this frame — three only drains the
  // list at upload — so re-flushes must EXTEND the pending union, not
  // replace it. Empty updateRanges = renderer consumed them last draw.
  private qLo = Infinity;
  private qHi = 0;

  private queueDirty(): void {
    if (this.posAttr.updateRanges.length === 0) {
      this.qLo = Infinity; this.qHi = 0;
    }
    const lo = Math.min(this.qLo, this.dirtyLo);
    const hi = Math.max(this.qHi, this.dirtyHi);
    if (lo === this.qLo && hi === this.qHi) {
      // Span already covered by the pending queue — a version bump is
      // enough; re-adding would just grow the range list.
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      return;
    }
    for (const a of [this.posAttr, this.colAttr]) {
      a.clearUpdateRanges();
      a.addUpdateRange(lo, hi - lo);
      a.needsUpdate = true;
    }
    this.qLo = lo; this.qHi = hi;
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
      for (let i = 0; i < RIBBON_SAMPLES - 1; i++) {
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
    markProbe(this.mesh, { kind: 'trailBatch', batch: this });
    for (let s = MAX_TRAILS - 1; s >= 0; s--) {this.free.push(s);}
    scene.add(this.mesh);
  }

  flush(): void {
    if (!this.dirty) {return;}
    this.dirty = false;
    const n = this.dirtyHi - this.dirtyLo;
    if (n > 0) {
      if (urlParams.fxfull) {
        // Full upload — bypasses the partial-range path entirely so a
        // silent updateRanges break shows as "trails back with ?fxfull".
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
      } else {
        this.queueDirty();
      }
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = 0;
    if (this.slotsDirty) {
      this.slotsDirty = false;
      let hw = 0;
      for (const s of this.used) {if (s + 1 > hw) hw = s + 1;}
      this.hw = hw;
    }
    this.geo.setDrawRange(0, this.hw * IDX);
  }
}

// A scene's trails live in a LIST of batches — 512 slots each. Overflow
// spawns another batch (one more draw call) instead of starving ribbons;
// emptied overflow batches shrink back away on release.
const batches: BatchMap<THREE.Scene, TrailBatch> = new Map();

export function claimableBatch(scene: THREE.Scene): TrailBatch {
  return acquireBatch(batches, scene, s => new TrailBatch(s), b => b.free.length > 0);
}

/** Retire an emptied overflow batch — batch 0 is the floor. */
export function retireBatchIfOverflow(b: TrailBatch): void {
  retireBatch(batches, b.scene, b, x => x.used.size === 0, x => { x.scene.remove(x.mesh); x.geo.dispose(); });
}

/** Any nonzero float in a slot's color span = pixels still on screen.
 *  Scans are bounded by the high-water mark — slots above it were never
 *  used, so they're provably black. */
export function slotLit(b: TrailBatch, s: number): boolean {
  const base = s * VERTS * 3;
  for (let i = 0; i < VERTS * 3; i++) {if (b.col[base + i] !== 0) return true;}
  return false;
}

function* allBatches(): Generator<TrailBatch> {
  for (const list of batches.values()) {yield* list;}
}

/** Slots lit in the batch color buffer — and, more importantly, slots
 *  lit WITHOUT a `used` owner. orphans() only sees stale RibbonTrail
 *  objects; a slot leaked by a path that bypassed releaseSlot keeps its
 *  last pixels on screen forever with no object left to blame. */
export function litAudit(): { lit: number; unowned: number[] } {
  const unowned: number[] = [];
  let lit = 0;
  for (const b of allBatches()) {
    for (let s = 0; s < b.hw; s++) {
      if (!slotLit(b, s)) {continue;}
      lit++;
      if (!b.used.has(s)) {unowned.push(s);}
    }
  }
  return { lit, unowned };
}

export let reapedLit = 0;
/** Sweep unowned lit slots to black — the auto-heal half of litAudit,
 *  so any undiscovered leak path self-cleans instead of freezing a
 *  streak midair. Runs once per frame from updateProjectiles. */
export function sweepLit(): void {
  for (const b of allBatches()) {
    let dirty = false;
    for (let s = 0; s < b.hw; s++) {
      if (b.used.has(s) || !slotLit(b, s)) {continue;}
      const base = s * VERTS * 3;
      b.col.fill(0, base, base + VERTS * 3);
      b.mark(base, base + VERTS * 3);
      dirty = true;
      reapedLit++;
    }
    if (dirty) {b.flush();}
  }
}

/** Batch census — a slot that's "live" but past drawRange or in an
 *  invisible mesh explains ribbons that exist but never render. */
export function batchStats(): Record<string, unknown>[] {
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
