import * as THREE from 'three';

import { EMIT_GAIN } from '../core/config.js';
import { settings } from '../core/settings.js';
import { registerDiag, glitch } from '../core/fxDiag.js';
import { type TrailBatch, RIBBON_SAMPLES, RIBBON_FLOATS_PER_SLOT, claimableBatch,
  retireBatchIfOverflow, slotLit, litAudit, sweepLit, reapedLit,
  batchStats, smearCuts,
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
  /** Owning subsystem for the census/aim probe - 'proj:disc', 'ball',
   *  'sentry'. A frozen streak names its owner, not a mystery slot. */
  tag?: string;
  /** Auxiliary lane (thin accent ribbon next to the main streak) -
   *  culled entirely past ~150m; the main ribbon only fades. */
  farCull?: boolean;
}

/**
 * Flat ribbon trail - a triangle strip following the projectile.
 * Buffer/slot ownership lives in trailBatch.ts; this file is the
 * per-ribbon ring buffer + fade/billboard logic.
 */

/** Camera position for callers that can't thread one into update() -
 *  updateProjectiles stamps this once per frame so projectile ribbons can
 *  billboard (ball ribbons get theirs via an explicit argument instead). */
let sharedCamPos: THREE.Vector3 | null = null;
export function setRibbonCamera(pos: THREE.Vector3 | null): void { sharedCamPos = pos; }

/** Discontinuity budget for push() and the follow re-pin - a few
 *  frames of travel plus slack. Pushes arrive per frame, so a gap
 *  beyond ~80ms of travel isn't a sample step, it's a host jump or a
 *  suppressed-emitter resume; either way a chord would paint. (The old
 *  `spd*0.25 + 12` - a quarter-second - let a 90m/s ball legitimately
 *  resume 22m away and painted exactly the sky streaks it guarded.) */
export const jumpBudget = (spd: number): number => spd * 0.08 + 3;

/* Wall-clock gap between pushes that severs the trail. Live emitters push
 * every frame, so >120ms of silence is never contiguous motion - the host
 * kept moving while emission was off, and joining across it paints a
 * chord. Generous for frame hitches, tighter than any deliberate pause. */
const PUSH_GAP_MS = 120;
/** Distance-quantized sampling: one committed sample per SAMPLE_SPACING
 *  meters of travel; a single push-call gap past BREAK_M is a run break,
 *  not a segment. Segment length is bounded by construction - no budget,
 *  no velocity math, nothing a caller can under- or over-estimate. */
const SAMPLE_SPACING = 0.5;
const BREAK_M = 30;

/** Top-10 longest adjacent-sample gaps seen on ANY ribbon - the diag
 *  reads this. Sorted descending, bounded; a legit long hop still earns
 *  its row (a jumpcut being prevented doesn't mean the gap is small). */
const MAX_GAPS = 10;
const topGaps: { tag: string; slot: number; gapM: number }[] = [];
function recordGap(tag: string, slot: number, gapM: number): void {
  if (topGaps.length === MAX_GAPS && gapM <= topGaps[MAX_GAPS - 1]!.gapM) {return;}
  topGaps.push({ tag, slot, gapM });
  topGaps.sort((a, b): number => b.gapM - a.gapM);
  if (topGaps.length > MAX_GAPS) {topGaps.pop();}
}
export function longestGaps(): { tag: string; slot: number; gapM: number }[] { return topGaps; }

export class RibbonTrail {
  private batch!: TrailBatch;
  private lastSpd = 0;
  private lastPushMs = 0;
  private slot = -1;
  // Generation word from TrailBatch.claim - a stale instance whose slot
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
  // Samples appended since the last update() - only those move; older
  // samples keep their positions and just fade.
  private pushed = 0;
  private time = 0;
  private _camX = Number.NaN;
  private _camY = Number.NaN;
  private _camZ = Number.NaN;
  private stopped = false;
  // Wall-clock of the last update() call - the orphan detector: every
  // owner ticks its ribbons each frame, so a stale stamp means the owner
  // died without dispose (leaked slot + frozen streak on screen).
  private lastUpdateAt = 0;

  // Direction per sample - needed by billboard mode to derive the camera-facing
  // side vector at update time (side can't be frozen at push since view moves)
  private dx = new Float32Array(MAX_SAMPLES);
  private dy = new Float32Array(MAX_SAMPLES);
  private dz = new Float32Array(MAX_SAMPLES);
  // Per-sample width multiplier - default 1. Slash/swipe callers pinch
  // the ends to 0 so strokes read as blades, not constant-width bars.
  private ws = new Float32Array(MAX_SAMPLES).fill(1);
  // Per-sample view-angle factor - billboard ribbons multiply width by
  // sin(dir-to-camera): a streak flying along the view axis presents its
  // whole face otherwise (the giant end-on wedge), so it shrinks to a
  // point instead. 1 for non-billboard ribbons and un-sided samples.
  private sf = new Float32Array(MAX_SAMPLES).fill(1);
  // Last written fade bucket per ribbon position (-1 = never written).
  // Fades only need rewriting when they cross a 1/255 step - a parked
  // camera + mature trail writes nothing at all.
  private _lf = new Int16Array(MAX_SAMPLES).fill(-1);
  // Scan floor for the update loop - tail slots past it are provably
  // fq===0 forever (fades only decrease with time).
  private liveFrom = 0;

  private baseColor: THREE.Color;
  private width: number;
  private life: number;
  // Emitter ramp - spawn-scale for streaks: the trail starts at `from`
  // of its life AND width, growing to full over `dur`. Lives on the
  // emitter: fade windows and write widths evaluate against the CURRENT
  // scale each update, so samples aren't re-tuned after spawn.
  private rampDur = 0;
  private rampFrom = 1;
  emitScale = 1; // public - census/diag reads it
  private vOffset: number; // offset along the ribbon's in-plane "up" (⊥ side)
  private billboard: boolean; // width axis faces the camera each frame
  // Live emitter anchor: the head sample is one tick old by the time it
  // renders (drivers push from updateVfx AFTER the host's own update), so
  // the tip vertex trails a fast shell by a full frame of travel. When a
  // host binds `follow`, update() re-pins the head sample to the live
  // position before verts are written - the strip stays welded to the
  // body instead of floating one frame behind.
  follow: THREE.Vector3 | null = null;
  /** Optional host-side context merged into a follow-jump payload - names
   *  which host state (blend offset, suppressed emit) a fired cut rode. */
  jumpHint?: () => Record<string, unknown>;
  /** True when a TrailDriver binds this follow - the driver's own maxStep
   *  gate is the jump policy for managed hosts, so the re-pin guard here
   *  stays a safety cut but stops reporting managed jumps as anomalies. */
  followManaged = false;
  private _ox = 0; private _oy = 0; private _oz = 0; // last lane offset - re-applied on follow re-pin
  // Owning subsystem ('proj:disc', 'ball', 'sentry') - every census/probe
  // row names the owner so a frozen streak is identified, not hunted.
  tag = '?';
  /** Aux-lane hard distance cull (RibbonOpts.farCull). */
  farCull = false;
  private static debugFrame = 0;

  // Free-list - projectiles churn ribbons constantly; sample buffers are
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
  // buffers - surfaced in the ribbons census (see registerDiag below).
  static nanPushes = 0;
  static nanSides = 0;
  /** push() calls that arrived after release - the owner outlived its
   *  ribbon (swept/mass-disposed). Counted, not silent. */
  static zombiePushes = 0;
  /** Zombie pushes by owner tag - 599 generic counts told us the class,
   *  not which owner outlived its ribbon. */
  static zombieByTag = new Map<string, number>();
  /** follow re-pins refused as discontinuities - orphaned ribbons
   *  stretching to a recycled host pos. Trends 0; the smear canary. */
  static followJumps = 0;
  /** Debug dump for __trailDump - one row per live ribbon. */
  static dump(): Record<string, unknown>[] {
    const now = performance.now();
    const out: Record<string, unknown>[] = [];
    for (const r of RibbonTrail.liveSet) {
      // head pos + a centroid over live samples - enough to point at the
      // on-screen streak a slot is actually drawing.
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < r.count; i += 1) { cx += r.px[i]; cy += r.py[i]; cz += r.pz[i]; }
      const n = Math.max(1, r.count);
      out.push({
        slot: r.slot, tag: r.tag, count: r.count, pushed: r.pushed, stopped: r.stopped,
        life: r.life, bb: r.billboard, done: r.done,
        lit: r.slot >= 0 && slotLit(r.batch, r.slot),
        starved: r.starvedPushes,
        time: Number(r.time.toFixed(1)),
        // First vert actually sitting in the shared buffer - a lit slot
        // whose buffer verts are all zero/NaN is a write-vs-upload break,
        // invisible no matter how healthy the ribbon looks.
        v0: r.slot >= 0 ? ((): string => {
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

  /** Ribbons no owner has updated within `staleMs` - leaked slots. */
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
  /** Stale ribbons - owner dead or stalled. A stale ribbon's `time` is
   *  frozen (update() is what advances it), so a reaper that waits for
   *  `done` can never fire: the slot burns a lit streak on screen
   *  forever. The sweep becomes the orphan's update loop instead - age
   *  the samples on wall-clock, keep it flagged stale (lastUpdateAt=0)
   *  so each pass drains further, then dispose once it goes done.
   *  A merely stalled live ribbon (hidden tab, frame hitch) absorbs one
   *  tick, its owner retakes update() the same frame, and lastUpdateAt
   *  refreshes - nothing is lost. */
  static reapedStale = 0;
  static sweepStale(staleMs = 2000): void {
    const now = performance.now();
    // Global-stall guard: a hidden tab/paused loop idles EVERY ribbon at
    // once, and the ms stamp can't tell owner-dead from loop-dead. The
    // freshest stamp can - if even it is stale, the frame loop stalled,
    // not the owners. Re-baseline instead of reaping live trails into
    // the pool: a mass re-issue while old owners still push is what made
    // zombiePushes and shared-slot trails after every alt-tab resync.
    // Real orphans stay at their pre-stall stamp and get reaped once
    // fresh stamps exist again next sweep.
    let freshest = 0;
    for (const r of RibbonTrail.liveSet) {if (r.lastUpdateAt > freshest) {freshest = r.lastUpdateAt;}}
    const globalStall = freshest > 0 && now - freshest > staleMs;
    for (const r of RibbonTrail.liveSet) {
      if (globalStall) {r.lastUpdateAt = now; continue;}
      const idleMs = now - r.lastUpdateAt;
      if (idleMs <= staleMs) {continue;}
      if (!r.done) {
        // An orphan whose owner died without stop() can never report
        // done - `done` requires stopped, so a plain update() loop would
        // drain it forever without finishing. Stop it first so the
        // sweep can actually reap it.
        if (!r.stopped) {r.stop();}
        r.update(Math.min(idleMs / 1000, 0.5));
        r.lastUpdateAt = 0;
        continue;
      }
      r.dispose();
RibbonTrail.reapedStale += 1;
    }
  }

  static litAudit = litAudit;
  static sweepLit = sweepLit;
  // Live-binding getter - a static field would freeze the count at init.
  static get reapedLit(): number { return reapedLit; }
  static batchStats = batchStats;

  /** Per-ribbon state for the Alt+Q dump - pairs a dead lane with its shell. */
  dbg(): { slot: number; tag: string; count: number; stopped: boolean; lit: boolean; starved: number } {
    return {
      slot: this.slot, tag: this.tag, count: this.count, stopped: this.stopped,
      lit: this.slot >= 0 && slotLit(this.batch, this.slot),
      starved: this.starvedPushes,
    };
  }

  // Pool-residency flag - dispose() is NOT safe to call twice (it would
  // push the same instance into the free pool twice, handing one ribbon
  // to two owners). The stale-owner reaper in sweepStale makes a second
  // dispose possible, so the guard lives here, not at the call sites.
  private inPool = false;

  private claimSlot(scene: THREE.Scene): void {
    this.inPool = false;
    // Ownership resumes NOW - a pooled ribbon kept its previous owner's
    // lastUpdateAt, so sweepStale read it as a stale done corpse and
    // disposed it out from under the new owner: the still-referenced
    // object re-entered the pool, got acquired by a second projectile,
    // and the first owner's stop() killed both trails mid-flight.
    this.lastUpdateAt = performance.now();
    this.batch = claimableBatch(scene);
    this.slot = this.batch.claim();
    this.batch.owners.set(this.slot, this);
    this.slotGen = this.batch.gen[this.slot]!;
    RibbonTrail.liveSet.add(this);
    this._lf.fill(-1);
  }

  /** Slot held AND generation-current - a stale instance whose slot was
   *  released out from under it and re-issued drops its handle for good
   *  (writing would paint the new owner's verts - the both-trails-killed
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
    // owns() gates the free - a stale releaseSlot must not steal the slot
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
    this.farCull = o.farCull === true;
    this.baseColor.setHex(o.color);
    this.stopped = false;
    this.time = 0;
    this.head = -1;
    this.count = 0;
    this.pushed = 0;
    this.liveFrom = 0;
    this.starvedPushes = 0;
    this.jumpcuts = 0;
    this._lf.fill(-1);
    this.ws.fill(1);
    this.sf.fill(1);
    this.rampDur = 0;
    this.rampFrom = 1;
    this.emitScale = 1;
    this.follow = null;
    this.followManaged = false;
    this.jumpHint = undefined; // pooled ribbons must not leak a prior owner's hint closure
    this.claimSlot(scene);
  }

  private constructor(scene: THREE.Scene, o: RibbonOpts) {
    this.width = o.width ?? 0.5;
    this.life = o.life ?? 0.3;
    this.vOffset = o.vOffset ?? 0;
    this.billboard = o.billboard ?? false;
    this.tag = o.tag ?? '?';
    this.farCull = o.farCull === true;
    this.baseColor = new THREE.Color(o.color);
    this.claimSlot(scene);
  }

  // Pushes rejected for near-zero velocity - a ribbon whose starved count
  // climbs while count stays 0 emits nothing (silent no-trail bug).
  private starvedPushes = 0;
  /** Spatial-jump cuts since acquire - throttles the jumpcut warn so a
   *  mis-wired owner can't flood the console thousands/sec. */
  private jumpcuts = 0;
  /** Last COMMITTED position - push() measures travel against this, never
   *  the welded head (follow re-pins px[head], corrupting the distance). */
  private _lx = Number.NaN; private _ly = 0; private _lz = 0;

  /** Record a new sample at the projectile's current position/facing.
   *  `wScale` tapers the strip at this sample (0 = pin to a point). */
  push(pos: THREE.Vector3, vel: THREE.Vector3, wScale = 1): void {
    // Released ribbons refuse samples - a caller still pushing after
    // dispose (resync mass-drop, stale-owner sweep) used to keep filling
    // the ring with slot=-1: the census row looked alive, the trail
    // rendered nothing, and nobody could tell which owner lost it.
    if (!this.slotAlive()) {
      RibbonTrail.zombiePushes += 1;
      RibbonTrail.zombieByTag.set(this.tag, (RibbonTrail.zombieByTag.get(this.tag) ?? 0) + 1);
      return;
    }
    if (this.stopped) {return;}
    // Reject NaN/Inf inputs at the door - one bad sample poisons px/py/pz
    // forever: every later sideFor/glueBoundary reuses it and the whole
    // slot's verts go NaN (the "radius is NaN" console spam).
    // NaN propagates through the sum - one check covers all six lanes.
    if (!Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z)) {
RibbonTrail.nanPushes += 1;
      return;
    }
    _dir.copy(vel);
    const spd = _dir.length();
    if (spd * spd < 1e-6) {this.starvedPushes += 1; return; }
    _dir.normalize();
    this.lastSpd = spd;
    // Side vector: perpendicular to velocity, biased to the world-horizontal plane
    _side.crossVectors(_dir, Math.abs(_dir.y) < 0.95 ? _up : _fwd).normalize();

    // Lane offset along the ribbon plane's "up" (⊥ both dir and side)
    let ox = 0, oy = 0, oz = 0;
    if (this.vOffset !== 0) {
      ox = (_dir.y * _side.z - _dir.z * _side.y) * -this.vOffset;
      oy = (_dir.z * _side.x - _dir.x * _side.z) * -this.vOffset;
      oz = (_dir.x * _side.y - _dir.y * _side.x) * -this.vOffset;
    }

    this._ox = ox; this._oy = oy; this._oz = oz;
    const prevPushMs = this.lastPushMs;
    this.lastPushMs = performance.now();

    // Distance-quantized commits (Unity minVertexDistance, generalized):
    // samples land per METER traveled, not per call - framerate, driver
    // cadence, and starvation all become invisible. The commit anchor is
    // separate from the welded head: follow re-pins px[head] every frame,
    // so measuring against it would undercount travel. Three regimes:
    //   d < SPACING   - no commit; the live-head weld covers the tip.
    //   d < BREAK_M   - commit floor(d/SPACING) points LERPED along the
    //                   traveled segment: a 15m net stamp becomes a dense
    //                   straight run, never a chord.
    //   d >= BREAK_M  - teleport/resnap: break the strip, no connector.
    // There is no "medium" case left to smear - a segment can only be
    // ~spacing long or a break.
    if (!this.commitGap(pos, ox, oy, oz, wScale, prevPushMs)) {return;}
    // First commit (or post-break restart) - single sample at pos.
    this.commit(pos.x + ox, pos.y + oy, pos.z + oz, wScale);
    this._lx = pos.x + ox; this._ly = pos.y + oy; this._lz = pos.z + oz;
  }

  // Distance-quantized commit gate. There is no "medium" case left to
  // smear - a segment can only be ~spacing long or a break. Returns
  // false for sub-spacing weld-only samples (no commit).
  private commitGap(pos: THREE.Vector3, ox: number, oy: number, oz: number, wScale: number, prevPushMs: number): boolean {
    if (!(this.count > 0 && Number.isFinite(this._lx))) {return true;}
    const jx = pos.x + ox - this._lx;
    const jy = pos.y + oy - this._ly;
    const jz = pos.z + oz - this._lz;
    const d = Math.hypot(jx, jy, jz);
    recordGap(this.tag, this.slot, d);
    if (d >= BREAK_M || performance.now() - prevPushMs > PUSH_GAP_MS) {
      const spatial = d >= BREAK_M;
      this.jumpcuts += spatial ? 1 : 0;
      if (spatial && (this.jumpcuts <= 3 || this.jumpcuts % 64 === 0)) {
        // Throttled - a mis-wired owner can otherwise flood console.error
        // thousands/sec (observed: 9800 msgs in 2s), starving the frame.
        glitch('trail-jumpcut', { tag: this.tag, gapM: Math.round(d) });
      }
      this.clear();
    } else if (d < SAMPLE_SPACING) {
      return false; // sub-spacing: weld-only, no commit - uniform density
    }
    // d >= spacing, d < BREAK: fall through to a single commit at pos.
    // Unity semantics - NO backfill: filling the gap with same-stamp
    // lerped points paints a fat untapered rope between net stamps.
    return true;
  }

  /** Append one ring sample - the only place head/count advance. */
  private commit(x: number, y: number, z: number, wScale: number): void {
    this.head = (this.head + 1) % MAX_SAMPLES;
    this.px[this.head] = x; this.py[this.head] = y; this.pz[this.head] = z;
    this.sx[this.head] = _side.x; this.sy[this.head] = _side.y; this.sz[this.head] = _side.z;
    this.dx[this.head] = _dir.x; this.dy[this.head] = _dir.y; this.dz[this.head] = _dir.z;
    this.st[this.head] = this.time;
    this.ws[this.head] = wScale;
    if (this.count < MAX_SAMPLES) {this.count += 1;}
    this.pushed += 1;
  }

  /** Ramp the emitter in over `dur` seconds starting at `from` scale -
   *  the projectile mesh's spawn-grow, applied to the streak. */
  rampIn(dur: number, from = 0): void { this.rampDur = dur; this.rampFrom = from; }

  /** Stop emitting - ribbon fades out where it is. */
  stop(): void { this.stopped = true; }

  /** Sweep forensics: oldest + newest committed ring positions. A lit
   *  buffer vert the ring never held means a write-path break; a ring
   *  endpoint at the smear's far side means the commit itself jumped. */
  smearForensics(): Record<string, unknown> {
    if (this.count === 0 || this.head < 0) {return { count: 0 };}
    const oldest = (this.head - this.count + 1 + MAX_SAMPLES) % MAX_SAMPLES;
    const r3 = (i: number): number[] => [Math.round(this.px[i]! * 10) / 10, Math.round(this.py[i]! * 10) / 10, Math.round(this.pz[i]! * 10) / 10];
    return { count: this.count, stopped: this.stopped, oldest: r3(oldest), head: r3(this.head), pushed: this.pushed };
  }

  /** Drop all samples - call after a position discontinuity (teleport/respawn)
   *  so the ribbon doesn't stretch a streak across the jump. */
  clear(): void {
    this.head = -1;
    this.count = 0;
    this.pushed = 0;
    this.liveFrom = 0;
    this.starvedPushes = 0;
    this._lx = Number.NaN;
    this.ws.fill(1);
    this.sf.fill(1);
    // The fade buckets are stale after a clear - a reused index whose
    // fresh fq coincidentally matches the old bucket would skip its
    // color write and leave the segment black/invisible.
    this._lf.fill(-1);
    // Gen check too - a stale clear() wiping a slot that's since been
    // re-issued is exactly the both-trails-killed sweep bug.
    if (this.slot >= 0 && this.batch.owns(this.slot, this.slotGen)) {
      const b = this.slot * RIBBON_FLOATS_PER_SLOT;
      // Zero pos AND col - clearing only the color leaves a stale vert
      // cloud in the buffer; any later color re-write (missed gen check,
      // stale flush) re-lights it as a chord across the old positions.
      this.batch.pos.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
      this.batch.col.fill(0, b, b + RIBBON_FLOATS_PER_SLOT);
      this.batch.mark(b, b + RIBBON_FLOATS_PER_SLOT);
      this.batch.flush(); // same as releaseSlot - a clear is unobservable otherwise
    }
  }

  /** True once the last sample has fully faded - safe to dispose. */
  get done(): boolean {
    if (this.count === 0) {return true;}
    return this.time - this.st[this.head] > this.life;
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    // Ribbon-batch kill switch - per-frame mesh visibility read so the
    // LINES toggle isolates ribbons from the particle path.
    this.batch.mesh.visible = settings.get('fps-ribbons');
    this.lastUpdateAt = performance.now();
    RibbonTrail.debugFrame += 1;
    this.batch.debugTick(RibbonTrail.debugFrame);
    const cam = camPos ?? sharedCamPos ?? undefined;
    this.time += dt;
    this.emitScale = this.rampDur > 0 ? Math.min(1, this.rampFrom + (1 - this.rampFrom) * (this.time / this.rampDur)) : 1;
    // Distance LOD: aux ribbons (thin accent lanes next to the main
    // streak) cull hard past 150m - they rasterize as thin lines across
    // the sky. The main ribbon only fades, keeping the body readable.
    if (cam && this.count > 0) {
      const dx = cam.x - this.px[this.head]!, dy = cam.y - this.py[this.head]!, dz = cam.z - this.pz[this.head]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (this.farCull) {this.emitScale *= Math.max(0, Math.min(1, (150 - d) / 25));}
      else {this.emitScale *= Math.max(0, Math.min(1, (200 - d) / 50));}
    }
    if (this.follow && this.count > 0 && this.followGap()) {return;}
    if (!this.slotAlive() || this.count < 2) {return;}
    const { camMoved, rebillboard } = this.cameraState(cam);
    const {pos} = this.batch;
    const base = this.slot * RIBBON_FLOATS_PER_SLOT;
    // Positions only move when new samples arrive (or a billboard needs
    // re-siding as the camera moves) - the rest of the ribbon is static,
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

  // Same discontinuity budget push() uses: a re-pin past it means the
  // host (or its recycled pos vector) jumped - stretching the head to
  // it paints a chord across the map, so cut instead.
  // Measure vs the last EMITTED sample, not the welded head - weld
  // creep during push starvation otherwise accumulates unchecked:
  // px[head] is re-pinned to follow each frame, so follow-vs-head
  // stays ~0 while the head walks arbitrarily far from the previous
  // real sample, stretching one segment across the map.
  // No weld: the strip draws ONLY committed worldpoints — a re-pinned
  // head follows _rpos through renderOffset decays and paints blend-
  // direction chords (the "trail pointing the wrong way"). Pushes
  // commit every 0.5m of travel, so the tip lags at most ~half a
  // meter of fresh history — invisible next to a moving body.
  // True when a jump was cut — caller returns early.
  private followGap(): boolean {
    const prev = this.count > 1 ? (this.head - 1 + MAX_SAMPLES) % MAX_SAMPLES : this.head;
    const jx = this.follow!.x + this._ox - this.px[prev]!;
    const jy = this.follow!.y + this._oy - this.py[prev]!;
    const jz = this.follow!.z + this._oz - this.pz[prev]!;
    // Same 60m hard ceiling push() applies - lastSpd can be a resnap
    // artifact (~1400m/s), inflating the budget to ~115m and letting a
    // cross-map re-pin paint a streak the push guard would have cut.
    const gapSq = jx * jx + jy * jy + jz * jz;
    if (gapSq <= BREAK_M * BREAK_M) {return false;}
    // Teleport: break + reseed at the new spot - never a chord.
    this.clear();
    RibbonTrail.followJumps += 1;
    this.commit(this.follow!.x + this._ox, this.follow!.y + this._oy, this.follow!.z + this._oz, 1);
    this._lx = this.follow!.x + this._ox; this._ly = this.follow!.y + this._oy; this._lz = this.follow!.z + this._oz;
    if (!this.followManaged) {
      glitch('follow-jump', Object.assign({ tag: this.tag, slot: this.slot, gapM: Math.round(Math.sqrt(gapSq)) }, this.jumpHint?.()));
    }
    return true;
  }

  /** Billboard bookkeeping: camMoved gates whether OLD samples get
   *  re-sided (freshFrom=0), while rebillboard carries the camera for
   *  FRESH samples - those always need the camera-facing side even when
   *  the camera is parked, else new verts keep the spawn-plane side and
   *  render edge-on. Past 200m the strip is sub-pixel, so skip the
   *  cross-product entirely. */
  private cameraState(camPos?: THREE.Vector3): { camMoved: boolean; rebillboard?: THREE.Vector3 } {
    if (!camPos) {return { camMoved: true };}
    const camMoved = this._camX !== camPos.x || this._camY !== camPos.y || this._camZ !== camPos.z;
    this._camX = camPos.x; this._camY = camPos.y; this._camZ = camPos.z;
    // No distance skip - an edge-on far ribbon renders as a thin flat
    // line (the "not billboarded" artifact); a cross product per sample
    // is trivial next to the frame cost.
    return { camMoved, rebillboard: this.billboard ? camPos : undefined };
  }

  private rewriteSamples(base: number, pos: Float32Array, freshFrom: number, rebillboard?: THREE.Vector3): boolean {
    let dirty = false;
    const effLife = this.life * Math.max(this.emitScale, 0.02);
    for (let i = this.liveFrom; i < this.count; i += 1) {
      // oldest -> newest
      const s = (this.head - this.count + 1 + i + MAX_SAMPLES) % MAX_SAMPLES;
      const fade = Math.max(0, 1 - (this.time - this.st[s]) / effLife);
      const o = base + i * 6;
      // The followed head re-pins every frame - it must be rewritten even
      // when no new sample pushed this tick, else the tip vertex sits at
      // last frame's pin while the body moved on.
      if (i >= freshFrom || (this.follow && i === this.count - 1)) { this.writeSample(s, o, fade, rebillboard, pos); dirty = true; }
      if (this.applyFadeBucket(i, o, fade)) {dirty = true;}
    }
    return dirty;
  }

  // The index buffer draws every quad in the slot - the one spanning the
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
    const fq = Math.trunc((fade * 255));
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
    // No stopped early-out: freshFrom=count assumes every sample's
    // position was already written, but stop() can land before the first
    // successful update - pending commits (pushed>0) then keep zeroed
    // pos verts under lit colors (the arm:mortar origin-smear). The
    // general formula already returns count when pushed=0, so dropping
    // the branch costs nothing steady-state.
    // A full ring evicts the oldest sample on every push - every vert's
    // position assignment shifts, so all verts must rewrite; keeping the
    // old positions leaves lit stale verts that streak (v0 gap in dumps).
    if (this.count === MAX_SAMPLES && this.pushed > 0) {return 0;}
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
    const w = this.width * this.emitScale * 0.5 * fade * this.ws[s] * this.sf[s];
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
    if (!Number.isFinite(len) || len <= 1e-6) {RibbonTrail.nanSides += 1; this.sf[s] = 0; return null; }
    // len = |d||v|·sinθ - the same cross-product magnitude the side axis
    // normalizes away. Below ~19° the strip is nearly end-on: fade width
    // with the angle instead of showing the whole face.
    const dlen = Math.hypot(this.dx[s]!, this.dy[s]!, this.dz[s]!);
    const vlen = Math.hypot(vx, vy, vz);
    const sin = len / Math.max(dlen * vlen, 1e-9);
    this.sf[s] = Math.min(1, sin * 3);
    const o = RibbonTrail._s3;
    o[0] = sx / len; o[1] = sy / len; o[2] = sz / len;
    return o;
  }

  /** Release back to the pool - buffers/slot kept for reuse. */
  dispose(): void {
    if (this.inPool) {return;}
    this.inPool = true;
    // Truthful corpse: the ring is dead with the slot. Without this a
    // released ribbon still reported count>0 in the census - the
    // "slot=-1 but 17 samples" rows that hid who lost their trail.
    this.head = -1;
    this.count = 0;
    this.follow = null;
    this.followManaged = false;
    this.jumpHint = undefined;
    this.releaseSlot();
    const pool = this.billboard ? RibbonTrail.poolBillboard : RibbonTrail.poolFixed;
    pool.push(this);
  }
}

// One census section for the whole ribbon layer - registered once at
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
  zombieByTag: Object.fromEntries(RibbonTrail.zombieByTag),
  followJumps: RibbonTrail.followJumps,
  smearCuts,
}));

/** Shared 'stop → update until done → dispose' drain - detonation paths
 *  used to hand-roll this loop per owner (deployRockets kept its own
 *  dying[] list; the fade math is identical). */
export class DyingRibbons {
  private list: RibbonTrail[] = [];

  fadeAll(set: RibbonTrail[]): void {
    for (const t of set) {t.stop();}
    this.list.push(...set);
  }

  update(dt: number, camPos?: THREE.Vector3): void {
    for (let i = this.list.length - 1; i >= 0; i -= 1) {
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
