import * as THREE from 'three';

import { EMIT_GAIN } from '../core/config.js';
import { registerDiag } from '../core/fxDiag.js';
import type {
  TrailBatch} from './trailBatch.js';
import { RIBBON_SAMPLES, RIBBON_FLOATS_PER_SLOT, claimableBatch,
  retireBatchIfOverflow, slotLit, litAudit, sweepLit, reapedLit,
  batchStats,
} from './trailBatch.js';
export { TrailBatch, RIBBON_TRIS_PER_SLOT } from './trailBatch.js';

const MAX_SAMPLES = RIBBON_SAMPLES;

const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(1, 0, 0);
const _dir = new THREE.Vector3();

export interface RibbonOpts {
  color: number;
  width?: number;
  life?: number;
  vOffset?: number;
  billboard?: boolean;
  /** Owning subsystem for the census/aim probe — 'proj:disc', 'ball',
   *  'sentry'. A frozen streak names its owner, not a mystery slot. */
  tag?: string;
}

/**
 * Flat ribbon trail — a triangle strip following the projectile.
 * Buffer/slot ownership lives in trailBatch.ts; this file is the
 * per-ribbon ring buffer + fade/billboard logic.
 */

/** Camera position for callers that can't thread one into update() —
 *  updateProjectiles stamps this once per frame so projectile ribbons can
 *  billboard (ball ribbons get theirs via an explicit argument instead). */
let sharedCamPos: THREE.Vector3 | null = null;
export function setRibbonCamera(pos: THREE.Vector3 | null): void { sharedCamPos = pos; }

export class RibbonTrail {
  private batch!: TrailBatch;
  private slot = -1;
  // Generation word from TrailBatch.claim — a stale instance whose slot
  // got re-issued to a new owner mismatches here and is refused at push
  // (double-ownership dies at the check, not via sweeps).
  private slotGen = 0;

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
  private _camX = Number.NaN;
  private _camY = Number.NaN;
  private _camZ = Number.NaN;
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
  // Per-sample width multiplier — default 1. Slash/swipe callers pinch
  // the ends to 0 so strokes read as blades, not constant-width bars.
  private ws = new Float32Array(MAX_SAMPLES).fill(1);
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
  // Emitter ramp — spawn-scale for streaks: the trail starts at `from`
  // of its life AND width, growing to full over `dur`. Lives on the
  // emitter: fade windows and write widths evaluate against the CURRENT
  // scale each update, so samples aren't re-tuned after spawn.
  private rampDur = 0;
  private rampFrom = 1;
  emitScale = 1; // public — census/diag reads it
  private vOffset: number; // offset along the ribbon's in-plane "up" (⊥ side)
  private billboard: boolean; // width axis faces the camera each frame
  // Live emitter anchor: the head sample is one tick old by the time it
  // renders (drivers push from updateVfx AFTER the host's own update), so
  // the tip vertex trails a fast shell by a full frame of travel. When a
  // host binds `follow`, update() re-pins the head sample to the live
  // position before verts are written — the strip stays welded to the
  // body instead of floating one frame behind.
  follow: THREE.Vector3 | null = null;
  private _ox = 0; private _oy = 0; private _oz = 0; // last lane offset — re-applied on follow re-pin
  // Owning subsystem ('proj:disc', 'ball', 'sentry') — every census/probe
  // row names the owner so a frozen streak is identified, not hunted.
  private tag!: string;

  // Free-list — projectiles churn ribbons constantly; sample buffers are
  // fixed-size so reuse is free.
  private static poolFixed: RibbonTrail[] = [];
  private static poolBillboard: RibbonTrail[] = [];

  static acquire(scene: THREE.Scene, o: RibbonOpts): RibbonTrail {
    const pool = o.billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    const r = pool.pop();
    if (r) {
      r.reinit(scene, o);
      return r;
    }
    return new RibbonTrail(scene, o);
  }

  private static liveSet = new Set<RibbonTrail>();
  // Non-finite inputs rejected before they could poison the shared batch
  // buffers — surfaced in the ribbons census (see registerDiag below).
  static nanPushes = 0;
  static nanSides = 0;
  /** push() calls that arrived after release — the owner outlived its
   *  ribbon (swept/mass-disposed). Counted, not silent. */
  static zombiePushes = 0;
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
        slot: r.slot, tag: r.tag, count: r.count, pushed: r.pushed, stopped: r.stopped,
        life: r.life, bb: r.billboard, done: r.done,
        lit: r.slot >= 0 && slotLit(r.batch, r.slot),
        starved: r.starvedPushes,
        time: Number(r.time.toFixed(1)),
        // First vert actually sitting in the shared buffer — a lit slot
        // whose buffer verts are all zero/NaN is a write-vs-upload break,
        // invisible no matter how healthy the ribbon looks.
        v0: r.slot >= 0 ? (() => {
          const o = r.slot * RIBBON_FLOATS_PER_SLOT;
          return `${r.batch.pos[o]!.toFixed(1)},${r.batch.pos[o + 1]!.toFixed(1)},${r.batch.pos[o + 2]!.toFixed(1)}`;
        })() : '-',
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
      if (r.batch !== batch || r.slot !== slot) {continue;}
      return {
        slot, owner: r.tag, stopped: r.stopped, done: r.done, bb: r.billboard,
        life: r.life, count: r.count, time: Number(r.time.toFixed(1)),
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
      if (now - r.lastUpdateAt <= staleMs) {continue;}
      if (r.slot >= 0) {slots.push(r.slot);}
      rows.push({ slot: r.slot, tag: r.tag, bb: r.billboard, count: r.count, stopped: r.stopped, updMs: Math.round(now - r.lastUpdateAt) });
    }
    return { count: rows.length, slots, rows };
  }
  /** Done ribbons whose owner stopped updating them — a real slot leak
   *  (unlike orphans(), which also flags live ones mid-frame stall).
   *  sweepStale() reclaims them; reapedStale counts it in the census. */
  static reapedStale = 0;
  static sweepStale(staleMs = 2000): void {
    const now = performance.now();
    for (const r of RibbonTrail.liveSet) {
      if (!r.done || now - r.lastUpdateAt <= staleMs) {continue;}
      r.dispose();
      RibbonTrail.reapedStale++;
    }
  }

  static litAudit = litAudit;
  static sweepLit = sweepLit;
  // Live-binding getter — a static field would freeze the count at init.
  static get reapedLit(): number { return reapedLit; }
  static batchStats = batchStats;

  /** Per-ribbon state for the Alt+Q dump — pairs a dead lane with its shell. */
  dbg(): { slot: number; tag: string; count: number; stopped: boolean; lit: boolean; starved: number } {
    return {
      slot: this.slot, tag: this.tag, count: this.count, stopped: this.stopped,
      lit: this.slot >= 0 && slotLit(this.batch, this.slot),
      starved: this.starvedPushes,
    };
  }

  // Pool-residency flag — dispose() is NOT safe to call twice (it would
  // push the same instance into the free pool twice, handing one ribbon
  // to two owners). The stale-owner reaper in sweepStale makes a second
  // dispose possible, so the guard lives here, not at the call sites.
  private inPool = false;

  private claimSlot(scene: THREE.Scene): void {
    this.inPool = false;
    // Ownership resumes NOW — a pooled ribbon kept its previous owner's
    // lastUpdateAt, so sweepStale read it as a stale done corpse and
    // disposed it out from under the new owner: the still-referenced
    // object re-entered the pool, got acquired by a second projectile,
    // and the first owner's stop() killed both trails mid-flight.
    this.lastUpdateAt = performance.now();
    this.batch = claimableBatch(scene);
    this.slot = this.batch.claim();
    this.slotGen = this.batch.gen[this.slot]!;
    RibbonTrail.liveSet.add(this);
    this._lf.fill(-1);
  }

  /** Slot held AND generation-current — a stale instance whose slot was
   *  released out from under it and re-issued drops its handle for good
   *  (writing would paint the new owner's verts — the both-trails-killed
   *  sweep bug, now refused at the check instead of healed by sweeps). */
  private slotAlive(): boolean {
    if (this.slot < 0) {return false;}
    if (!this.batch.owns(this.slot, this.slotGen)) { this.slot = -1; return false; }
    return true;
  }

  private releaseSlot(): void {
    RibbonTrail.liveSet.delete(this);
    if (this.slot < 0) {return;}
    const b = this.batch;
    // owns() gates the free — a stale releaseSlot must not steal the slot
    // back out from under whoever claimed it after us.
    if (b.owns(this.slot, this.slotGen)) {b.release(this.slot);}
    this.slot = -1;
    retireBatchIfOverflow(b);
  }

  private reinit(scene: THREE.Scene, o: RibbonOpts): void {
    this.width = o.width ?? 0.5;
    this.life = o.life ?? 0.3;
    this.vOffset = o.vOffset ?? 0;
    this.tag = o.tag ?? '?';
    this.baseColor.setHex(o.color);
    this.stopped = false;
    this.time = 0;
    this.head = -1;
    this.count = 0;
    this.pushed = 0;
    this.liveFrom = 0;
    this.starvedPushes = 0;
    this._lf.fill(-1);
    this.ws.fill(1);
    this.rampDur = 0;
    this.rampFrom = 1;
    this.emitScale = 1;
    this.follow = null;
    this.claimSlot(scene);
  }

  private constructor(scene: THREE.Scene, o: RibbonOpts) {
    this.width = o.width ?? 0.5;
    this.life = o.life ?? 0.3;
    this.vOffset = o.vOffset ?? 0;
    this.billboard = o.billboard ?? false;
    this.tag = o.tag ?? '?';
    this.baseColor = new THREE.Color(o.color);
    this.claimSlot(scene);
  }

  // Pushes rejected for near-zero velocity — a ribbon whose starved count
  // climbs while count stays 0 emits nothing (silent no-trail bug).
  private starvedPushes = 0;

  /** Record a new sample at the projectile's current position/facing.
   *  `wScale` tapers the strip at this sample (0 = pin to a point). */
  push(pos: THREE.Vector3, vel: THREE.Vector3, wScale = 1): void {
    // Released ribbons refuse samples — a caller still pushing after
    // dispose (resync mass-drop, stale-owner sweep) used to keep filling
    // the ring with slot=-1: the census row looked alive, the trail
    // rendered nothing, and nobody could tell which owner lost it.
    if (!this.slotAlive()) { RibbonTrail.zombiePushes++; return; }
    if (this.stopped) {return;}
    // Reject NaN/Inf inputs at the door — one bad sample poisons px/py/pz
    // forever: every later sideFor/glueBoundary reuses it and the whole
    // slot's verts go NaN (the "radius is NaN" console spam).
    // NaN propagates through the sum — one check covers all six lanes.
    if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z)) {
      RibbonTrail.nanPushes++;
      return;
    }
    _dir.copy(vel);
    const spd = _dir.length();
    if (spd * spd < 1e-6) { this.starvedPushes++; return; }
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

    // Teleport guard — owners are supposed to clear() on a jump, but one
    // missed caller draws a chord from the last sample to wherever the
    // new owner/pos landed (the streak between two different projectiles).
    // Beyond ~0.5s of travel + slack this "sample" is a jump: cut the strip.
    if (this.count > 0) {
      const jx = pos.x + ox - this.px[this.head]!;
      const jy = pos.y + oy - this.py[this.head]!;
      const jz = pos.z + oz - this.pz[this.head]!;
      const jump = spd * 0.25 + 12;
      if (jx * jx + jy * jy + jz * jz > jump * jump) {this.clear();}
    }

    this._ox = ox; this._oy = oy; this._oz = oz;
    this.head = (this.head + 1) % MAX_SAMPLES;
    this.px[this.head] = pos.x + ox; this.py[this.head] = pos.y + oy; this.pz[this.head] = pos.z + oz;
    this.sx[this.head] = _side.x; this.sy[this.head] = _side.y; this.sz[this.head] = _side.z;
    this.dx[this.head] = _dir.x; this.dy[this.head] = _dir.y; this.dz[this.head] = _dir.z;
    this.st[this.head] = this.time;
    this.ws[this.head] = wScale;
    if (this.count < MAX_SAMPLES) {this.count++;}
    this.pushed++;
  }

  /** Ramp the emitter in over `dur` seconds starting at `from` scale —
   *  the projectile mesh's spawn-grow, applied to the streak. */
  rampIn(dur: number, from = 0): void { this.rampDur = dur; this.rampFrom = from; }

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
    this.ws.fill(1);
    // The fade buckets are stale after a clear — a reused index whose
    // fresh fq coincidentally matches the old bucket would skip its
    // color write and leave the segment black/invisible.
    this._lf.fill(-1);
    // Gen check too — a stale clear() wiping a slot that's since been
    // re-issued is exactly the both-trails-killed sweep bug.
    if (this.slot >= 0 && this.batch.owns(this.slot, this.slotGen)) {
      const b = this.slot * RIBBON_FLOATS_PER_SLOT;
      this.batch.col.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
      this.batch.mark(b, b + RIBBON_FLOATS_PER_SLOT);
      this.batch.flush(); // same as releaseSlot — a clear is unobservable otherwise
    }
  }

  /** True once the last sample has fully faded — safe to dispose. */
  get done(): boolean {
    if (this.count === 0) {return true;}
    return this.time - this.st[this.head] > this.life;
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    this.lastUpdateAt = performance.now();
    camPos = camPos ?? sharedCamPos ?? undefined;
    this.time += dt;
    this.emitScale = this.rampDur > 0 ? Math.min(1, this.rampFrom + (1 - this.rampFrom) * (this.time / this.rampDur)) : 1;
    if (this.follow && this.count > 0) {
      this.px[this.head] = this.follow.x + this._ox;
      this.py[this.head] = this.follow.y + this._oy;
      this.pz[this.head] = this.follow.z + this._oz;
    }
    if (!this.slotAlive() || this.count < 2) {return;}
    const { camMoved, rebillboard } = this.cameraState(camPos);
    const {pos} = this.batch;
    const base = this.slot * RIBBON_FLOATS_PER_SLOT;
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
    if (!camPos) {return { camMoved: true };}
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
    const effLife = this.life * Math.max(this.emitScale, 0.02);
    for (let i = this.liveFrom; i < this.count; i++) {
      // oldest -> newest
      const s = (this.head - this.count + 1 + i + MAX_SAMPLES) % MAX_SAMPLES;
      const fade = Math.max(0, 1 - (this.time - this.st[s]) / effLife);
      const o = base + i * 6;
      // The followed head re-pins every frame — it must be rewritten even
      // when no new sample pushed this tick, else the tip vertex sits at
      // last frame's pin while the body moved on.
      if (i >= freshFrom || (this.follow && i === this.count - 1)) { this.writeSample(s, o, fade, rebillboard, pos); dirty = true; }
      if (this.applyFadeBucket(i, o, fade)) {dirty = true;}
    }
    return dirty;
  }

  // The index buffer draws every quad in the slot — the one spanning the
  // last written sample and the next (zeroed 0,0,0) renders as a streak
  // from the head down to world origin. Gluing the boundary verts to the
  // head makes it degenerate instead.
  private glueBoundary(base: number, pos: Float32Array): boolean {
    if (this.count === 0 || this.count >= MAX_SAMPLES) {return false;}
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
    if (fq === 0 && i === this.liveFrom) {this.liveFrom = i + 1;}
    if (this._lf[i] === fq) {return false;}
    this._lf[i] = fq;
    const {col} = this.batch;
    const v = EMIT_GAIN * (fq / 255);
    col[o] = this.baseColor.r * v;
    col[o + 1] = this.baseColor.g * v;
    col[o + 2] = this.baseColor.b * v;
    col[o + 3] = col[o]; col[o + 4] = col[o + 1]; col[o + 5] = col[o + 2];
    return true;
  }

  private freshFromIndex(camMoved: boolean): number {
    if (this.billboard && camMoved) {return 0;}
    if (this.stopped) {return this.count;}
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
    const w = this.width * this.emitScale * 0.5 * fade * this.ws[s];
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
    const sx = this.dy[s] * vz - this.dz[s] * vy;
    const sy = this.dz[s] * vx - this.dx[s] * vz;
    const sz = this.dx[s] * vy - this.dy[s] * vx;
    const len = Math.hypot(sx, sy, sz);
    // isFinite, not just >eps: NaN len passes `<=` comparisons (NaN < x
    // is false), so a NaN cross product used to normalize into NaN verts.
    if (!Number.isFinite(len) || len <= 1e-6) { RibbonTrail.nanSides++; return null; }
    const o = RibbonTrail._s3;
    o[0] = sx / len; o[1] = sy / len; o[2] = sz / len;
    return o;
  }

  /** Release back to the pool — buffers/slot kept for reuse. */
  dispose(): void {
    if (this.inPool) {return;}
    this.inPool = true;
    // Truthful corpse: the ring is dead with the slot. Without this a
    // released ribbon still reported count>0 in the census — the
    // "slot=-1 but 17 samples" rows that hid who lost their trail.
    this.head = -1;
    this.count = 0;
    this.follow = null;
    this.releaseSlot();
    const pool = this.billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    pool.push(this);
  }
}

// One census section for the whole ribbon layer — registered once at
// module load so __trailDump needs no wiring changes when it grows.
registerDiag('ribbons', () => ({
  ribbons: RibbonTrail.dump(),
  ribbonBatch: batchStats(),
  ribbonOrphans: RibbonTrail.orphans(),
  litAudit: litAudit(),
  reapedLit,
  reapedStale: RibbonTrail.reapedStale,
  nanReject: { pushes: RibbonTrail.nanPushes, sides: RibbonTrail.nanSides },
  zombiePushes: RibbonTrail.zombiePushes,
}));

/** Shared 'stop → update until done → dispose' drain — detonation paths
 *  used to hand-roll this loop per owner (deployRockets kept its own
 *  dying[] list; the fade math is identical). */
export class DyingRibbons {
  private list: RibbonTrail[] = [];

  fadeAll(set: RibbonTrail[]): void {
    for (const t of set) {t.stop();}
    this.list.push(...set);
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i]!;
      t.update(dt, camPos);
      if (t.done) { t.dispose(); this.list.splice(i, 1); }
    }
  }

  disposeAll(): void {
    for (const t of this.list) {t.dispose();}
    this.list.length = 0;
  }
}
