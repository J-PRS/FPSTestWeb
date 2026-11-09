import * as THREE from 'three';

import { BLOOM_LAYER } from '../core/config.js';
import { urlParams } from '../core/params.js';
import { markProbe, glitch } from '../core/fxDiag.js';
import { acquireBatch, retireBatch, type BatchMap } from '../core/batchPool.js';

// Samples per ribbon slot - the batch's index/vertex layout is built
// around it, and RibbonTrail's ring buffer is the same length.
export const RIBBON_SAMPLES = 48;
const VERTS = RIBBON_SAMPLES * 2;
const IDX = (RIBBON_SAMPLES - 1) * 6;
/** Floats (xyz) one slot spans in the position/color buffers. */
export const RIBBON_FLOATS_PER_SLOT = VERTS * 3;
/** Triangles per ribbon slot - the aim probe maps faceIndex → slot. */
export const RIBBON_TRIS_PER_SLOT = IDX / 3;

/**
 * One merged BufferGeometry holding MAX_TRAILS ribbon slots under a
 * single Mesh: 240+ live trails used to cost 240 draw calls - the top
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
  // Dirty span in float-array indices - a single live trail used to
  // re-upload the whole 512-slot buffer every frame (~1.2MB).
  dirtyLo = Infinity;
  dirtyHi = 0;

  mark(lo: number, hi: number): void {
    if (lo < this.dirtyLo) {this.dirtyLo = lo;}
    if (hi > this.dirtyHi) {this.dirtyHi = hi;}
    this.dirty = true;
  }

  /** F1 (urlParams.debug) overlay: small cross gizmo at each lit sample
   *  center + a line between consecutive ones - the wireframe skeleton
   *  of what the strip actually draws, so a chord/twist is visible as
   *  geometry, not just numbers. LineSegments = ~1-2px, matches ask. */
  private debugMesh: THREE.LineSegments | null = null;
  private debugPos = new Float32Array(MAX_TRAILS * RIBBON_SAMPLES * 8 * 3);
  private debugFrame = -1;
  debugTick(frame: number): void {
    if (!urlParams.debug) {
      if (this.debugMesh) {this.debugMesh.visible = false;}
      if (this.ghostMesh) {this.ghostMesh.visible = false;}
      return;
    }
    if (frame === this.debugFrame) {return;}
    this.debugFrame = frame;
    const debugMesh = this.ensureDebugMesh();
    const C = 0.28; // half-size of the cross gizmo, meters - readable
    let w = 0;
    const put = (x: number, y: number, z: number): void => { this.debugPos[w++] = x; this.debugPos[w++] = y; this.debugPos[w++] = z; };
    const now = performance.now();
    this.debugDrawSlots(put, now, C);
    debugMesh.visible = true;
    (debugMesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    debugMesh.geometry.setDrawRange(0, w / 3);
    this.rebuildGhosts(now, C);
  }

  /** Per-slot debug scan: cross gizmo per lit sample + ghost pin. */
  private debugDrawSlots(put: (x: number, y: number, z: number) => void, now: number, C: number): void {
    for (const s of this.used) {
      const base = s * RIBBON_FLOATS_PER_SLOT;
      let px = 0, py = 0, pz = 0, hasPrev = false;
      for (let i = 0; i < RIBBON_SAMPLES; i += 1) {
        const c = base + i * 6;
        if (this.col[c] === 0 && this.col[c + 1] === 0 && this.col[c + 2] === 0) {continue;}
        // Sample center = midpoint of the two rail verts.
        const x = (this.pos[c]! + this.pos[c + 3]!) / 2;
        const y = (this.pos[c + 1]! + this.pos[c + 4]!) / 2;
        const z = (this.pos[c + 2]! + this.pos[c + 5]!) / 2;
        put(x - C, y, z); put(x + C, y, z);
        put(x, y - C, z); put(x, y + C, z);
        put(x, y, z - C); put(x, y, z + C);
        if (hasPrev) {put(px, py, pz); put(x, y, z);}
        // Ghost pin: once per newly-seen sample position - lingers
        // ~4s after the trail's own fade, so a vanished smear's
        // skeleton is still examinable.
        const g = this.ghostSlot.get(s);
        if (!g || g.x !== x || g.y !== y || g.z !== z) {
          if (this.ghosts.length >= 2000) {this.ghosts.shift();}
          this.ghosts.push({ x, y, z, t: now });
          this.ghostSlot.set(s, { x, y, z });
        }
        px = x; py = y; pz = z; hasPrev = true;
      }
    }
  }

  /** Ghost pins - every lit sample leaves a marker that fades over ~4s
   *  (additive black = gone). Ring-capped so long sessions don't grow. */
  private ghosts: { x: number; y: number; z: number; t: number }[] = [];
  private ghostSlot = new Map<number, { x: number; y: number; z: number }>();
  private ghostMesh: THREE.LineSegments | null = null;
  private ghostPos = new Float32Array(2000 * 6 * 3);
  private ghostCol = new Float32Array(2000 * 6 * 3);
  /** Lazily build the debug line mesh once (debug overlay only). */
  private ensureDebugMesh(): THREE.LineSegments {
    if (this.debugMesh) {return this.debugMesh;}
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.debugPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.debugMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x00_FF_F0, transparent: true, opacity: 0.9, depthTest: false }));
    this.debugMesh.frustumCulled = false;
    this.debugMesh.renderOrder = 999;
    this.scene.add(this.debugMesh);
    return this.debugMesh;
  }

  private rebuildGhosts(now: number, C: number): void {
    const LIFE = 4000;
    let keep = 0;
    for (let i = 0; i < this.ghosts.length; i += 1) {
      if (now - this.ghosts[i]!.t < LIFE) {this.ghosts[keep] = this.ghosts[i]!; keep += 1;}
    }
    this.ghosts.length = keep;
    if (!this.ghostMesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.ghostPos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(this.ghostCol, 3).setUsage(THREE.DynamicDrawUsage));
      this.ghostMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false }));
      this.ghostMesh.frustumCulled = false;
      this.ghostMesh.renderOrder = 998;
      this.scene.add(this.ghostMesh);
    }
    let w = 0;
    const put = (x: number, y: number, z: number, b: number): void => {
      this.ghostPos[w] = x; this.ghostPos[w + 1] = y; this.ghostPos[w + 2] = z;
      this.ghostCol[w] = 0; this.ghostCol[w + 1] = b; this.ghostCol[w + 2] = b * 0.9; w += 3;
    };
    for (const g of this.ghosts) {
      const b = Math.min(1, (LIFE - (now - g.t)) / 1000);
      put(g.x - C, g.y, g.z, b); put(g.x + C, g.y, g.z, b);
      put(g.x, g.y - C, g.z, b); put(g.x, g.y + C, g.z, b);
      put(g.x, g.y, g.z - C, b); put(g.x, g.y, g.z + C, b);
    }
    this.ghostMesh.visible = true;
    (this.ghostMesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.ghostMesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.ghostMesh.geometry.setDrawRange(0, w / 3);
  }

  /** Generation per slot (VFX P2). claim() bumps it, so a stale handle
   *  holding (slot, oldGen) after the slot got re-issued is refused at
   *  owns() - double-ownership dies at the check, not via sweeps. */
  readonly gen = new Uint32Array(MAX_TRAILS);
  /** slot -> live ribbon handle, so sweeps can kill the ring that
   *  writes a chord, not just black the chord it already wrote. */
  readonly owners = new Map<number, { clear(): void; tag: string }>();

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
    this.owners.delete(slot);
    const b = slot * RIBBON_FLOATS_PER_SLOT;
    this.pos.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
    this.col.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
    this.mark(b, b + RIBBON_FLOATS_PER_SLOT);
    // Upload NOW - mark() alone defers to the next ribbon's update(), and
    // if this was the last live ribbon nothing ever flushes: the slot's
    // stale verts stay lit as a frozen streak across the map.
    this.flush();
    this.slotsDirty = true;
    this.free.push(slot);
    // Keep descending so pop() hands out the smallest slot - used slots
    // stay packed at the front of the index buffer for drawRange.
    this.free.sort((x, y): number => y - x);
  }

  // Union of what's already queued on the attrs since the last render.
  // flush() runs per ribbon, and clearUpdateRanges() would erase the
  // spans earlier ribbons queued this frame - three only drains the
  // list at upload - so re-flushes must EXTEND the pending union, not
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
      // Span already covered by the pending queue - a version bump is
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
    for (let r = 0; r < MAX_TRAILS; r += 1) {
      const base = r * VERTS, io = r * IDX;
      for (let i = 0; i < RIBBON_SAMPLES - 1; i += 1) {
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
      // Same ghost class as TerrainRing: fades scale vertex RGB only, so
      // the fog mix repainted dead ribbon quads as fog-colored streaks.
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(BLOOM_LAYER);
    // Aim-probe tag - the crosshair raycast resolves a slot via faceIndex
    // back to whichever RibbonTrail owns it (or proves it ownerless).
    markProbe(this.mesh, { kind: 'trailBatch', batch: this });
    for (let s = MAX_TRAILS - 1; s >= 0; s -= 1) {this.free.push(s);}
    scene.add(this.mesh);
  }

  flush(): void {
    if (!this.dirty) {return;}
    this.dirty = false;
    const n = this.dirtyHi - this.dirtyLo;
    if (n > 0) {
      if (urlParams.fxfull) {
        // Full upload - bypasses the partial-range path entirely so a
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
      for (const s of this.used) {if (s + 1 > hw) {hw = s + 1;}}
      this.hw = hw;
    }
    this.geo.setDrawRange(0, this.hw * IDX);
  }
}

// A scene's trails live in a LIST of batches - 512 slots each. Overflow
// spawns another batch (one more draw call) instead of starving ribbons;
// emptied overflow batches shrink back away on release.
const batches: BatchMap<THREE.Scene, TrailBatch> = new Map();

export function claimableBatch(scene: THREE.Scene): TrailBatch {
  return acquireBatch(batches, scene,( s): TrailBatch => new TrailBatch(s),( b): boolean => b.free.length > 0);
}

/** Retire an emptied overflow batch - batch 0 is the floor. */
export function retireBatchIfOverflow(b: TrailBatch): void {
  retireBatch(batches, b.scene, b,( x): boolean => x.used.size === 0,( x): void => { x.scene.remove(x.mesh); x.geo.dispose(); });
}

/** Any nonzero float in a slot's color span = pixels still on screen.
 *  Scans are bounded by the high-water mark - slots above it were never
 *  used, so they're provably black. */
export function slotLit(b: TrailBatch, s: number): boolean {
  const base = s * VERTS * 3;
  for (let i = 0; i < VERTS * 3; i += 1) {if (b.col[base + i] !== 0) {return true;}}
  return false;
}

function* allBatches(): Generator<TrailBatch> {
  for (const list of batches.values()) {yield* list;}
}

/** Slots lit in the batch color buffer - and, more importantly, slots
 *  lit WITHOUT a `used` owner. orphans() only sees stale RibbonTrail
 *  objects; a slot leaked by a path that bypassed releaseSlot keeps its
 *  last pixels on screen forever with no object left to blame. */
export function litAudit(): { lit: number; unowned: number[] } {
  const unowned: number[] = [];
  let lit = 0;
  for (const b of allBatches()) {
    for (let s = 0; s < b.hw; s += 1) {
      if (!slotLit(b, s)) {continue;}
lit += 1;
      if (!b.used.has(s)) {unowned.push(s);}
    }
  }
  return { lit, unowned };
}

export let reapedLit = 0;

/** Consecutive lit verts beyond this gap can't lie on one trajectory -
 *  the chord IS the sky-smear. 60m matches RibbonTrail's cut budget. */
const SMEAR_GAP_M = 60;
export let smearCuts = 0;

/** Snapshot the longest consecutive-vert spans across every lit slot -
 *  Ctrl+Alt+Q reads this. Wherever a smear currently lives in a buffer,
 *  it lands here with slot + owner tag, no matter who wrote it. */
export function topSpans(n = 10): { slot: number; tag: string; gapM: number }[] {
  const out: { slot: number; tag: string; gapM: number }[] = [];
  for (const [s, chain] of litChains()) {
    for (const gapM of chain) {
      if (gapM > (out[n - 1]?.gapM ?? 0)) {
        out.push({ slot: s.slot, tag: s.tag, gapM });
        out.sort((a, b2): number => b2.gapM - a.gapM);
        if (out.length > n) {out.pop();}
      }
    }
  }
  return out;
}

/** Per-slot contiguous lit-vert gap lists - the unit every span metric
 *  and the chain-length report both walk. A "line" can be legal at every
 *  single segment while the CHAIN is world-long; per-segment scans are
 *  blind to it, chain length names it. */
function litChains(): Map<{ slot: number; tag: string }, number[]> {
  const m = new Map<{ slot: number; tag: string }, number[]>();
  for (const b of allBatches()) {
    for (const s of b.used) {
      const base = s * RIBBON_FLOATS_PER_SLOT;
      const key = { slot: s, tag: b.owners.get(s)?.tag ?? '?' };
      const gaps: number[] = [];
      // Per-RAIL gaps, not centerline: each sample writes two verts
      // (o, o+3) - a stale rail twists the strip into a chord while a
      // one-rail scan reads it clean. Max over both rails names it.
      let px0 = 0, py0 = 0, pz0 = 0, px1 = 0, py1 = 0, pz1 = 0, hasPrev = false;
      for (let i = 0; i < VERTS; i += 2) {
        const c = base + i * 3;
        if (b.col[c] === 0 && b.col[c + 1] === 0 && b.col[c + 2] === 0) {continue;}
        const x0 = b.pos[c]!, y0 = b.pos[c + 1]!, z0 = b.pos[c + 2]!;
        const x1 = b.pos[c + 3]!, y1 = b.pos[c + 4]!, z1 = b.pos[c + 5]!;
        if (hasPrev) {
          gaps.push(Math.max(
            Math.hypot(x0 - px0, y0 - py0, z0 - pz0),
            Math.hypot(x1 - px1, y1 - py1, z1 - pz1)));
        }
        px0 = x0; py0 = y0; pz0 = z0;
        px1 = x1; py1 = y1; pz1 = z1; hasPrev = true;
      }
      if (gaps.length > 0) {m.set(key, gaps);}
    }
  }
  return m;
}

/** Top-n longest contiguous LIT chains - total meters of connected
 *  ribbon per slot. A live trail is ≤~30m; a smear's stale tail reads
 *  as a hundred-meter chain of individually-legal segments. */
export function topChains(n = 10): { slot: number; tag: string; lenM: number }[] {
  const out: { slot: number; tag: string; lenM: number }[] = [];
  for (const [k, gaps] of litChains()) {
    let lenM = 0;
    for (const g of gaps) {lenM += g;}
    if (lenM > (out[n - 1]?.lenM ?? 0)) {
      out.push({ slot: k.slot, tag: k.tag, lenM });
      out.sort((a, b2): number => b2.lenM - a.lenM);
      if (out.length > n) {out.pop();}
    }
  }
  return out;
}

/** Writer-agnostic smear canary: any lit slot whose consecutive verts
 *  jump >SMEAR_GAP_M is painting a chord between unrelated points -
 *  whatever path wrote it, black the slot and count it. Diagnostics
 *  surface the count; the smear can't outlive a frame. */
export function sweepSmear(): void {
  for (const b of allBatches()) {
    let dirty = false;
    for (const s of b.used) {
      const base = s * RIBBON_FLOATS_PER_SLOT;
      let smeared = false, gapSq = 0;
      // Per-rail gaps - a stale second rail twists the strip into a
      // chord a single-rail scan can't see.
      let px0 = 0, py0 = 0, pz0 = 0, px1 = 0, py1 = 0, pz1 = 0, hasPrev = false;
      let prevI = -1, hitI = -1, ec: number[] = [];
      for (let i = 0; i < VERTS; i += 2) {
        const c = base + i * 3;
        if (b.col[c] === 0 && b.col[c + 1] === 0 && b.col[c + 2] === 0) {continue;}
        const x0 = b.pos[c], y0 = b.pos[c + 1], z0 = b.pos[c + 2];
        const x1 = b.pos[c + 3], y1 = b.pos[c + 4], z1 = b.pos[c + 5];
        if (hasPrev) {
          const dx0 = x0 - px0, dy0 = y0 - py0, dz0 = z0 - pz0;
          const dx1 = x1 - px1, dy1 = y1 - py1, dz1 = z1 - pz1;
          const g0 = dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
          const g1 = dx1 * dx1 + dy1 * dy1 + dz1 * dz1;
          if (g0 > SMEAR_GAP_M * SMEAR_GAP_M || g1 > SMEAR_GAP_M * SMEAR_GAP_M) {
            smeared = true; gapSq = Math.max(g0, g1); prevI = hitI; hitI = i;
            // Rail-midpoint endpoints: a sparse-chain smear shows two
            // nearby buffer slots far apart in world; a stale-vert chord
            // shows the same with a dark index run between them.
            ec = [
              Math.round(((px0 + px1) / 2) * 10) / 10, Math.round(((py0 + py1) / 2) * 10) / 10, Math.round(((pz0 + pz1) / 2) * 10) / 10,
              Math.round(((x0 + x1) / 2) * 10) / 10, Math.round(((y0 + y1) / 2) * 10) / 10, Math.round(((z0 + z1) / 2) * 10) / 10,
            ];
            break;
          }
        }
        px0 = x0; py0 = y0; pz0 = z0;
        px1 = x1; py1 = y1; pz1 = z1; hasPrev = true; hitI = i;
      }
      if (!smeared) {continue;}
      const owner = b.owners.get(s);
      // Forensics BEFORE clear() - it resets the ring the dump reads.
      const fore = (owner as { smearForensics?: () => Record<string, unknown> } | undefined)?.smearForensics?.();
      if (owner) {
        // Kill the writer, not just the chord - blacking the buffer left
        // the stale samples in the owner's ring and it repainted the
        // same smear every frame (the repeat-glitch spam).
        owner.clear();
      } else {
        b.col.fill(0, base, base + VERTS * 3);
        b.mark(base, base + VERTS * 3);
        dirty = true;
      }
smearCuts += 1;
      glitch('trail-smear', { slot: s, tag: b.owners.get(s)?.tag ?? '?', gapM: Math.round(Math.sqrt(gapSq)),
        idx: `${prevI}>${hitI}`, ends: ec, own: fore });
    }
    if (dirty) {b.flush();}
  }
}

/** Sweep unowned lit slots to black - the auto-heal half of litAudit,
 *  so any undiscovered leak path self-cleans instead of freezing a
 *  streak midair. Runs once per frame from updateProjectiles. */
export function sweepLit(): void {
  for (const b of allBatches()) {
    let dirty = false;
    for (let s = 0; s < b.hw; s += 1) {
      if (b.used.has(s) || !slotLit(b, s)) {continue;}
      const base = s * VERTS * 3;
      b.col.fill(0, base, base + VERTS * 3);
      b.mark(base, base + VERTS * 3);
      dirty = true;
reapedLit += 1;
    }
    if (dirty) {b.flush();}
  }
}

/** Batch census - a slot that's "live" but past drawRange or in an
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
