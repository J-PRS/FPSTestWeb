import type * as THREE from 'three';
import { lerpAngle, wrapAngleDelta } from '../../../shared/angles.ts';
import { hermiteBounded } from '../../../shared/dmath.ts';
import { inv } from '../../../shared/invariants.ts';

function clampNum(v: number, lo: number, hi: number): number {
  if (v < lo) {return lo;}
if (v > hi) {return hi;}
return v;
}

// Scratch for hermiteBounded — keeps the per-frame sample zero-alloc.
const _hermiteOut = { x: 0, y: 0, z: 0 };

/**
 * SnapshotBuffer — the remote-player interpolation core.
 *
 * The server streams position/rotation/velocity snapshots; this buffer holds
 * the last ~1s of them and answers "where should the remote be rendered right
 * now?" — a renderTime pulled back by an adaptive delay that tracks observed
 * arrival jitter (stretchy cadence from server send-suppression does NOT count
 * as jitter, or idle remotes would pin the delay at max and render stale).
 *
 * Between two snapshots the position follows a cubic Hermite whose tangents
 * are the server-reported velocities — C1-continuous, so direction changes
 * curve smoothly instead of zig-zagging across linear segments. A bogus or
 * stale velocity that overshoots wildly vs the straight lerp falls back to
 * linear (guard below). Past the newest snapshot it extrapolates velocity for
 * a bounded 250ms rather than freezing.
 *
 * Timestamps are SERVER time (tickSeq × tick period), never arrival
 * wall time: a jittered packet then slots into the correct timeline
 * position instead of pushing the whole render window forward — arrival
 * stamping folds jitter straight into the rendered path (rubberbands).
 * renderTime re-anchors on the newest snapshot's server time plus elapsed
 * wall time, so it advances smoothly between pushes with no clock engine.
 *
 * Pure math + Date.now() — no scene objects, so it's unit-testable in
 * isolation from RemotePlayer's models/gizmos.
 */

export interface NetSnapshot {
  t: number; x: number; y: number; z: number;
  yaw: number; pitch: number;
  vx: number; vy: number; vz: number;
}

export class SnapshotBuffer {
  static readonly BASE_INTERP_DELAY = 100;
  static readonly MAX_INTERP_DELAY = 600; // bursty/batched delivery needs >400ms to hold a full interval margin
  static readonly MAX_EXTRAPOLATE = 0.4; // s past the newest snapshot

  private snapshots: NetSnapshot[] = [];
  private pool: NetSnapshot[] = [];
  /** True while the sampler is clamped at the extrapolation cap — the
   *  remote is freeze-framing on stale truth, so the caller should hand
   *  motion to dead reckoning rather than wait out the silence timer. */
  atExtCap = false;
  /** Times the buffer ran dry — the user-visible starvation counter:
   *  each one is a freeze/dead-reckon episode a soak can count. */
  underruns = 0;
  /** Wall-ms spent clamped at the cap — underrun severity, not just count. */
  extCapMsTotal = 0;
  private extCapStart = 0;
  /** True between a clear() and the first sample after it: the buffer
   *  holds only post-teleport truth, so the caller snaps to the sample
   *  directly — steering the old position across the gap would slide a
   *  respawn's corpse path into the new seat. */
  freshSeed = false;
  // Anchor pair for the render clock: newest snapshot's server time and
  // the client wall time it arrived. renderTime = latestT + elapsed.
  // Reordered packets must NOT move the anchor — rewinding latestT snaps
  // the rendered remote backward each stale arrival.
  private latestT = 0;
  private latestArrive = 0;
  /** Arrival stamp of the last push — jitter stats measure the wire, not
   *  the timeline order, so they track raw arrivals even when reordered. */
  private lastArrive = 0;
  /** Small renderTime rewinds are tolerable — jitter under ~40ms shifts
   *  the sampled window less than a stride. Big rewinds (delay inflating
   *  on arrival spikes) walk the remote BACKWARD along its own path: the
   *  visible rubberband. Those get pinned as bounded extrapolation and
   *  resync when pushes raise the desired time again. */
  private static readonly MAX_RENDER_REWIND = 80;
  private lastRenderTime = -Infinity;
  private lastSampleWall = 0;
  /** Wall time when the rewind pin engaged — see sample(). */
  private rewindPinAt = 0;
  /** The delay inflates instantly (a late packet must fit inside the
   *  window) but deflates slowly — an arrival spike that relaxes a
   *  +300ms delay in one push rewinds renderTime by that much and the
   *  remote warps BACKWARD along its own path: the visible rubberband.
   *  Slewed deflation turns the same adaptation into a glide. */
  interpDelay = SnapshotBuffer.BASE_INTERP_DELAY;
  /** Actual staleness of the last drawn sample — interpDelay minus any
   *  extrapolation overshoot (renderTime past the newest snapshot), so
   *  it can sit near zero while the setting reads ~200ms. This is the
   *  number lag-comp must rewind by: it is the shooter's literal view,
   *  not the buffer's intent. Clamped ≥0 — a view fresher than the wire
   *  has no rewindable epoch. */
  get viewLagMs(): number {
    if (this.lastRenderTime === -Infinity || this.latestT === 0) {return this.interpDelay;}
    const lag = this.latestT + (this.lastSampleWall - this.latestArrive) - this.lastRenderTime;
    return Math.max(0, lag);
  }
  /** Damped version of the computed delay need — see push(). */
  private delayTarget = SnapshotBuffer.BASE_INTERP_DELAY;
  /** EMA of the observed arrival interval — send suppression stretches it
   *  well past the nominal 20Hz without being jitter. */
  arrivalInterval = 50;
  /** Recent raw arrival gaps (unsorted ring ≤32) + reusable sorted copy.
   *  The p90 of real gaps is the jitter cushion the delay needs to cover —
   *  an EMA of |gap−interval| breathes ±100ms on WAN noise and lags tier
   *  changes, so a stable stream pays for jitter it no longer has. */
  private arrivalGaps: number[] = [];
  private gapsSorted: number[] = [];
  /** The latest a packet has legitimately been: p90 observed gap + one
   *  full cadence. Silence beyond this is proven starvation — wall-clock
   *  guesses (jitter EMAs, nominal rates) flap DR during send gaps the
   *  stream itself produces. */
  get starveMs(): number {
    const p90 = this.gapsSorted.length > 0
      ? this.gapsSorted[Math.floor((this.gapsSorted.length - 1) * 0.9)]!
      : 0;
    return Math.max(250, p90 + this.arrivalInterval);
  }

  /** Push a server update; returns the arrival gap in ms (0 = first sample).
   *  `t` is the snapshot's SERVER time; `arriveMs` the client wall time it
   *  landed (jitter stats + the render-clock anchor). Callers without a
   *  server clock (JSON/host paths) pass arrival time for t as before. */
  push(
    t: number,
    pos: { x: number; y: number; z: number },
    rot: { yaw: number; pitch: number },
    vel: { x: number; y: number; z: number },
    arriveMs = Date.now(),
  ): number {
    // The wire boundary: a NaN/Infinity here poisons the Hermite and
    // every render derived from it — name it at the gate, never let it
    // propagate into a "sometimes teleports" report.
    const prev = this.lastArrive;
    const gap = prev > 0 ? arriveMs - prev : 0;
    if (!inv('wire-pos-finite', Number.isFinite(pos.x + pos.y + pos.z + vel.x + vel.y + vel.z + rot.yaw + rot.pitch + t),
      () => ({ t, x: pos.x, y: pos.y, z: pos.z }))) {
      return gap;
    }
    this.lastArrive = arriveMs;
    const isNewest = t >= this.latestT;
    if (isNewest) {
      this.latestT = t;
      this.latestArrive = arriveMs;
    }
    if (gap > 10 && gap < 2000) {
      // Fast EMA on cadence change (tier-10 streams arrive at 10x the
      // baseline — 0.15 takes ~7s to converge, during which renderTime
      // sits past the buffer and the remote mini-warps).
      const rate = gap > this.arrivalInterval * 2 ? 0.6 : 0.15;
      this.arrivalInterval += (gap - this.arrivalInterval) * rate;
      this.arrivalGaps.push(gap);
      if (this.arrivalGaps.length > 32) {this.arrivalGaps.shift();}
      this.gapsSorted.length = 0;
      this.gapsSorted.push(...this.arrivalGaps);
      this.gapsSorted.sort((a, b) => a - b);
      const p90gap = this.gapsSorted[Math.floor((this.gapsSorted.length - 1) * 0.9)]!;
      // The delay must cover a worst-ish arrival interval, not a noise
      // estimate: the p90 gap IS the coverage need — one late packet in
      // ten may briefly extrapolate, the other nine render on truth.
      // BUT the floor is cadence coverage: a delay below the arrival
      // interval parks renderTime PERMANENTLY past the newest snapshot —
      // the body then renders ahead of wire truth on extrapolated
      // velocity every frame (WYSIWYG inversion: aiming at positions
      // the server never produced). Honest lag beats forward fiction.
      // Speed-scaled cap as before: delay × speed = rendered meters.
      const spd = Math.hypot(vel.x, vel.y, vel.z);
      // Edge-vs-middle: delay = p90gap parks renderTime AT the newest
      // snapshot's edge — one jittered arrival and it's past the buffer
      // (the atCap flap driving the per-push adj storms). The margin is
      // a FULL measured interval: coalesced/burst delivery (~300-400ms
      // spacing) needs renderTime deep enough inside history that the
      // inter-burst coast never reaches newest.t — half an interval was
      // still crossing it on every cycle = the adj oscillation.
      const cadenceFloor = Math.max(this.arrivalInterval, p90gap)
        + Math.max(80, this.arrivalInterval);
      // Ceiling is derived, not static: on a pathological stream whose
      // proven starvation bound (starveMs) exceeds 600ms, a flat cap
      // guarantees renderTime NEVER reaches the buffer — permanent
      // atCap with no recovery. Let the floor meet the measured need.
      const dynCap = Math.max(SnapshotBuffer.MAX_INTERP_DELAY, this.starveMs);
      const delayCap = spd > 5
        ? Math.min(dynCap, Math.max(cadenceFloor, 4000 / spd))
        : dynCap;
      const raw = Math.min(
        delayCap,
        Math.max(cadenceFloor, SnapshotBuffer.BASE_INTERP_DELAY + p90gap),
      );
      // The TARGET also needs damping — a jittered WAN arrival swings
      // raw ±100ms between pushes, and even a slewed chase renders that
      // breathing as remote lurch. Slow EMA means a sustained shift still
      // converges (~1-2s) while packet-to-packet noise stops steering
      // the render window entirely.
      // EMA + slew both ride the PUSH count — on a suppressed 2Hz stream
      // 0.08/push and 8ms/push take ~30s to converge to the cadence floor,
      // during which renderTime sits past the buffer and the remote DRs
      // permanently (the all-sim:true dump). Scale by the arrival gap so
      // a sparse stream converges at the same wall-clock rate as a 20Hz
      // one — jitter suppression still works because the RATE is fixed.
      const rateScale = Math.max(1, gap / 50);
      this.delayTarget += (raw - this.delayTarget) * Math.min(0.5, 0.08 * rateScale);
      // The cap is a hard error bound (delay×speed = rendered meters) —
      // it clamps the OUTPUT too, since the EMA lags a speed change.
      const target = Math.min(this.delayTarget, delayCap);
      // Slew BOTH ways: instant inflation made every jittered WAN
      // arrival ratchet the delay up, and each jump rewound/damped
      // renderTime — remotes lurched on straight paths despite a full
      // buffer. ~160ms/s up converges on a real degradation in ~1s while
      // single late packets ride extrapolation instead. Deflate rides
      // rateScale too - a fixed -10/push on a sparse stream deflated
      // ~8x slower than it inflated, so recovered streams sat parked
      // at a stale-high delay (the 575ms delayMs plateaus) long past
      // the need.
      const slewUp = Math.min(8 * rateScale, target - this.interpDelay);
      this.interpDelay += Math.max(-10 * rateScale, slewUp);
    }

    // Finite-but-absurd is the other half of the wire class: no mover
    // reaches 300 m/s, and a corrupt tangent/extrapolation at that speed
    // is the stretched-mesh symptom. Count it, then cap to the bound.
    const spd2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
    const velSane = inv('wire-vel-sane', spd2 <= 300 * 300, () => ({ spd: Math.sqrt(spd2) }));
    const vScale = velSane ? 1 : 300 / Math.sqrt(spd2);
    const snap = this.pool.pop() ?? { t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0 };
    snap.t = t; snap.x = pos.x; snap.y = pos.y; snap.z = pos.z;
    snap.yaw = rot.yaw; snap.pitch = rot.pitch;
    snap.vx = vel.x * vScale; snap.vy = vel.y * vScale; snap.vz = vel.z * vScale;
    // Datagram lanes deliver out of order — insert at timeline position,
    // never a plain append: the sampler assumes monotonic t.
    let idx = this.snapshots.length;
    while (idx > 0 && this.snapshots[idx - 1]!.t > t) {idx -= 1;}
    this.snapshots.splice(idx, 0, snap);

    // Keep a few intervals of history — the delay window plus one pair.
    const cutoff = this.latestT - Math.max(1000, this.arrivalInterval * 4);
    while (this.snapshots.length > 2 && this.snapshots[0]!.t < cutoff) {
      this.pool.push(this.snapshots.shift()!);
    }
    return gap;
  }

  /** The newest received-truth position — what a blend should chase when
   *  the render clock runs past the buffer. Chasing sample() there chases
   *  the coast (fabricated), so converge clamps to this instead. */
  latestPos(outPos: THREE.Vector3): boolean {
    const n = this.snapshots[this.snapshots.length - 1];
    if (!n) {return false;}
    outPos.set(n.x, n.y, n.z);
    return true;
  }

  /** Sample the render position/rotation for right now. */
  sample(outPos: THREE.Vector3, outRot: { yaw: number; pitch: number },
         fallbackPos: THREE.Vector3, fallbackYaw: number, fallbackPitch: number): void {
    // renderTime rides the server timeline: re-anchored by each push,
    // free-runs at wall rate between them. A jittered/late packet raises
    // elapsed — bounded extrapolation — instead of shifting the window.
    const now = Date.now();
    const desired = this.latestT + (now - this.latestArrive) - this.interpDelay;
    // The render clock slews, it never steps: each push re-anchors
    // desired by that packet's arrival jitter, so a raw copy warps the
    // remote by jitter×speed EVERY arrival (2-3m pops at ski speed on a
    // WAN). Clamp the chase to a fraction of frame time — a 50ms early/
    // late packet absorbs over ~10 frames as an imperceptible speed
    // change. Big rewinds still pin (a backward walk is worse than a
    // freeze), and real teleports re-seat via clear(), never through
    // sample.
    // oxlint-disable-next-line init-declarations -- assigned later
    let renderTime!: number;
    if (this.lastRenderTime === -Infinity) {
      renderTime = desired;
    } else {
      const dtMs = Math.max(1, now - this.lastSampleWall);
      const err = desired - this.lastRenderTime;
      if (err > 200) {
        // Post-gap resync, not jitter: DR owns the body while the wire
        // was silent, so the clock can just jump — slewing seconds at
        // 1.35x leaves renderTime behind the buffer's retention and the
        // sample pins to the oldest snapshot (a visible warp anyway).
        renderTime = desired;
      } else {
        // Backward applies in full down to the rewind pin: a small
        // rewind is the remote retracing its own path — slewing it
        // leaves renderTime trailing desired and drifts the sample
        // across pair boundaries, which pops harder than the rewind.
        // The pin must EXPIRE: if desired keeps asking for a bigger
        // rewind than 80ms for ~2 arrival intervals, the guess was
        // wrong (a real server rewind) — holding renderTime forward
        // then bricks the remote into permanent extrapolation. Truth
        // beats smoothness; accept the rewind once it's persistent.
        const fwd = Math.min(dtMs * 1.35, 100);
        let back = err;
        if (err < -SnapshotBuffer.MAX_RENDER_REWIND) {
          if (this.rewindPinAt === 0) {this.rewindPinAt = now;}
          back = now - this.rewindPinAt > this.arrivalInterval * 2
            ? err // pin expired — real rewind, take it
            : 0;  // pin: absorb the rewind as future forward growth
        } else {
          this.rewindPinAt = 0;
        }
        renderTime = this.lastRenderTime + Math.max(back, Math.min(fwd, err));
      }
    }
    this.lastSampleWall = now;
    this.lastRenderTime = renderTime;
    const snaps = this.snapshots;

    if (snaps.length === 0) {
      this.atExtCap = false;
      // freshSeed survives: an empty buffer means no truth has landed
      // yet — the FIRST real snapshot still counts as the re-seat.
      outPos.copy(fallbackPos);
      outRot.yaw = fallbackYaw;
      outRot.pitch = fallbackPitch;
      return;
    }
    this.freshSeed = false;

    const newest = snaps[snaps.length - 1]!;
    if (renderTime >= newest.t) {
      // Past the buffer — extrapolate briefly from the newest snapshot.
      // The cap covers ~one full arrival interval: a 400ms-tier remote
      // freeze-framing 160ms before dead reckoning takes over reads as a
      // stutter, so the coast hands off to DR at the cap instead.
      const cap = Math.min(0.9, Math.max(SnapshotBuffer.MAX_EXTRAPOLATE, this.arrivalInterval / 1000));
      const capped = (renderTime - newest.t) / 1000 >= cap;
      if (capped && !this.atExtCap) { this.underruns += 1; this.extCapStart = Date.now(); }
      else if (!capped && this.atExtCap) { this.extCapMsTotal += Date.now() - this.extCapStart; }
      this.atExtCap = capped;
      // Past the cap: keep coasting on the newest velocity instead of
      // freeze-framing. atExtCap still arms DR at the starve threshold —
      // the freeze made every underrun a visible stall→DR→snap cycle,
      // while a coast reads as honest prediction error. The 2s bound
      // only matters if DR never fires (localDriven); a real stream's
      // DR takeover replaces this path long before it.
      const ext = Math.min(2, (renderTime - newest.t) / 1000);
      outPos.set(newest.x + newest.vx * ext, newest.y + newest.vy * ext, newest.z + newest.vz * ext);
      // Rotation extrapolates too — a turning remote's head would otherwise
      // freeze mid-swipe while the body keeps coasting. The rate comes from
      // the last pair (shortest-arc yaw delta / span), capped so a freak
      // 180° flick can't spin the model forever.
      const prev = snaps.length >= 2 ? snaps[snaps.length - 2]! : newest;
      const rotSpan = Math.max(0.05, (newest.t - prev.t) / 1000);
      const yawRate = clampNum(wrapAngleDelta(newest.yaw - prev.yaw) / rotSpan, -6, 6);
      const pitchRate = clampNum((newest.pitch - prev.pitch) / rotSpan, -4, 4);
      const rotExt = Math.min(ext, 0.35); // heading prediction stales fast — stop well inside the position cap
      outRot.yaw = newest.yaw + yawRate * rotExt;
      outRot.pitch = newest.pitch + pitchRate * rotExt;
      return;
    }
    this.atExtCap = false;

    // Find the pair straddling renderTime
    let i = snaps.length - 2;
    while (i >= 0 && snaps[i]!.t > renderTime) {i -= 1;}
    if (i < 0) {
      const s = snaps[0]!;
      outPos.set(s.x, s.y, s.z);
      outRot.yaw = s.yaw;
      outRot.pitch = s.pitch;
      return;
    }

    const s0 = snaps[i]!;
    const s1 = snaps[i + 1]!;
    const span = s1.t - s0.t;
    const a = span > 0 ? (renderTime - s0.t) / span : 1;

    const spanSec = span / 1000;
    // 1s cap: tier-suppressed streams legitimately span ~500ms. The
    // shared bounded Hermite (dmath) is the same curve the server's
    // rewind uses — overshoot guard keeps curves bent, never ballooned.
    if (spanSec > 0 && spanSec < 1) {
      hermiteBounded(s0, s1, a, spanSec, _hermiteOut);
      outPos.set(_hermiteOut.x, _hermiteOut.y, _hermiteOut.z);
    } else {
      outPos.set(s0.x + (s1.x - s0.x) * a, s0.y + (s1.y - s0.y) * a, s0.z + (s1.z - s0.z) * a);
    }
    // Yaw: lerp along shortest arc
    outRot.yaw = lerpAngle(s0.yaw, s1.yaw, a);
    outRot.pitch = s0.pitch + (s1.pitch - s0.pitch) * a;
  }

  /** Server-time epoch of the last drawn frame — the shooter's literal
   *  view instant. NaN before the first sample. Lag-comp ghost reads
   *  this to ask "where was the body when the shooter fired?" */
  get viewEpochT(): number { return this.lastRenderTime === -Infinity ? Number.NaN : this.lastRenderTime; }

  /** Epoch query — the buffered truth at server-time `t`, linear between
   *  the straddling snapshots, bounded extrapolation off the newest.
   *  Unlike sample(): no render clock, no slewing — a pure history read
   *  for the lag-comp ghost (projecting wire+vel misses direction
   *  changes the buffer already saw). */
  sampleAt(t: number, outPos: THREE.Vector3): boolean {
    const snaps = this.snapshots;
    // NaN epoch (pre-first-sample viewEpochT) would silently interpolate
    // at the a=NaN boundary and emit a garbage position — refuse it.
    if (!Number.isFinite(t) || snaps.length === 0) {return false;}
    const newest = snaps[snaps.length - 1]!;
    if (t >= newest.t) {
      const ext = Math.min(SnapshotBuffer.MAX_EXTRAPOLATE, (t - newest.t) / 1000);
      outPos.set(newest.x + newest.vx * ext, newest.y + newest.vy * ext, newest.z + newest.vz * ext);
      return true;
    }
    let i = snaps.length - 2;
    while (i >= 0 && snaps[i]!.t > t) {i -= 1;}
    if (i < 0) {
      const s = snaps[0]!;
      outPos.set(s.x, s.y, s.z);
      return true;
    }
    const s0 = snaps[i]!;
    const s1 = snaps[i + 1]!;
    const a = s1.t > s0.t ? (t - s0.t) / (s1.t - s0.t) : 1;
    // Same bounded Hermite the server's rewindPos runs — the ghost the
    // client projects IS the ghost the server validates.
    hermiteBounded(s0, s1, a, (s1.t - s0.t) / 1000, _hermiteOut);
    outPos.set(_hermiteOut.x, _hermiteOut.y, _hermiteOut.z);
    return true;
  }

  /** Recycle the whole buffer (teleport/disconnect reset). The render-
   *  clock anchor goes too: server time is per-room (tickSeq×50), and a
   *  room hop/match restart rewinds it — a stale latestT would swallow
   *  every push as "not newest" and freeze renderTime on the old epoch. */
  clear(): void {
    this.pool.push(...this.snapshots);
    this.snapshots.length = 0;
    this.latestT = 0;
    this.latestArrive = 0;
    this.lastArrive = 0;
    this.lastRenderTime = -Infinity;
    this.lastSampleWall = 0;
    this.interpDelay = SnapshotBuffer.BASE_INTERP_DELAY;
    this.delayTarget = SnapshotBuffer.BASE_INTERP_DELAY;
    this.atExtCap = false;
    this.freshSeed = true;
  }

  get size(): number { return this.snapshots.length; }
}
