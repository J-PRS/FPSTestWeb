import type * as THREE from 'three';
import { lerpAngle, wrapAngleDelta } from '../../../shared/angles.ts';
import { inv } from '../../../shared/invariants.ts';

function clampNum(v: number, lo: number, hi: number): number {
  if (v < lo) {return lo;}
if (v > hi) {return hi;}
return v;
}

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
  static readonly MAX_INTERP_DELAY = 800;
  static readonly MAX_EXTRAPOLATE = 0.25; // s past the newest snapshot

  private snapshots: NetSnapshot[] = [];
  private pool: NetSnapshot[] = [];
  /** True while the sampler is clamped at the extrapolation cap — the
   *  remote is freeze-framing on stale truth, so the caller should hand
   *  motion to dead reckoning rather than wait out the silence timer. */
  atExtCap = false;
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
  private static readonly MAX_RENDER_REWIND = 40;
  private lastRenderTime = -Infinity;
  private lastSampleWall = 0;
  /** The delay inflates instantly (a late packet must fit inside the
   *  window) but deflates slowly — an arrival spike that relaxes a
   *  +300ms delay in one push rewinds renderTime by that much and the
   *  remote warps BACKWARD along its own path: the visible rubberband.
   *  Slewed deflation turns the same adaptation into a glide. */
  interpDelay = SnapshotBuffer.BASE_INTERP_DELAY;
  /** EMA of the observed arrival interval — send suppression stretches it
   *  well past the nominal 20Hz without being jitter. */
  arrivalInterval = 50;
  private arrivalJitter = 0;

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
      { t, x: pos.x, y: pos.y, z: pos.z })) {
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
      this.arrivalJitter += (Math.abs(gap - this.arrivalInterval) - this.arrivalJitter) * 0.1;
      // The delay must cover a full arrival interval, not just jitter:
      // interest-tier suppression streams at 500ms spacing, and a 300ms
      // cap leaves renderTime permanently past the newest snapshot —
      // far remotes then freeze on the extrapolation clamp and step at
      // the send rate instead of interpolating.
      // Speed-scaled cap: delay × speed is rendered position error —
      // a 40m/s remote at 600ms sits 24m behind truth. Faster remotes
      // get less delay (more extrapolation), walkers keep the cushion.
      const spd = Math.hypot(vel.x, vel.y, vel.z);
      const delayCap = spd > 5
        ? Math.min(SnapshotBuffer.MAX_INTERP_DELAY, 4000 / spd)
        : SnapshotBuffer.MAX_INTERP_DELAY;
      const target = Math.min(
        delayCap,
        SnapshotBuffer.BASE_INTERP_DELAY + this.arrivalInterval + this.arrivalJitter * 2,
      );
      // ~200ms/s deflate at push cadence — see the slew comment above.
      this.interpDelay = target > this.interpDelay ? target : Math.max(target, this.interpDelay - 10);
    }

    // Finite-but-absurd is the other half of the wire class: no mover
    // reaches 300 m/s, and a corrupt tangent/extrapolation at that speed
    // is the stretched-mesh symptom. Count it, then cap to the bound.
    const spd2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
    const velSane = inv('wire-vel-sane', spd2 <= 300 * 300, { spd: Math.sqrt(spd2) });
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

  /** Sample the render position/rotation for right now. */
  sample(outPos: THREE.Vector3, outRot: { yaw: number; pitch: number },
         fallbackPos: THREE.Vector3, fallbackYaw: number, fallbackPitch: number): void {
    // renderTime rides the server timeline: re-anchored by each push,
    // free-runs at wall rate between them. A jittered/late packet raises
    // elapsed — bounded extrapolation — instead of shifting the window.
    const now = Date.now();
    const desired = this.latestT + (now - this.latestArrive) - this.interpDelay;
    // Both directions bounded: pin on big rewinds (backward warp), glide
    // forward at ~wall rate (the pin's own release otherwise snaps the
    // remote ahead as desired reasserts).
    // oxlint-disable-next-line init-declarations -- assigned later
    let renderTime!: number;
    if (this.lastRenderTime === -Infinity) {
      renderTime = desired;
    } else {
      const pin = desired < this.lastRenderTime - SnapshotBuffer.MAX_RENDER_REWIND;
      // Absolute step cap matters at low fps: a wall-scaled cap alone lets a
      // 750ms frame glide +860ms in one step — every remote snapping forward
      // together. Real teleports re-seat via clear(), never through sample.
      const cap = this.lastRenderTime + Math.min((now - this.lastSampleWall) * 1.15, 100);
      renderTime = Math.min(pin ? this.lastRenderTime : desired, cap);
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
      this.atExtCap = (renderTime - newest.t) / 1000 >= cap;
      const ext = Math.min(cap, (renderTime - newest.t) / 1000);
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
    const ddx = s1.x - s0.x, ddy = s1.y - s0.y, ddz = s1.z - s0.z;
    const lx = s0.x + ddx * a, ly = s0.y + ddy * a, lz = s0.z + ddz * a;
    let useHermite = false;
    // 1s cap: tier-suppressed streams legitimately span ~500ms.
    if (spanSec > 0 && spanSec < 1) {
      const t2 = a * a, t3 = t2 * a;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + a;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const hx = h00 * s0.x + h10 * s0.vx * spanSec + h01 * s1.x + h11 * s1.vx * spanSec;
      const hy = h00 * s0.y + h10 * s0.vy * spanSec + h01 * s1.y + h11 * s1.vy * spanSec;
      const hz = h00 * s0.z + h10 * s0.vz * spanSec + h01 * s1.z + h11 * s1.vz * spanSec;
      const ox = hx - lx, oy = hy - ly, oz = hz - lz;
      const dist = Math.hypot(ddx, ddy, ddz);
      // Overshoot tolerance: fraction of segment length (min 0.5m absolute)
      if (ox * ox + oy * oy + oz * oz < (0.5 * dist + 0.5) * (0.5 * dist + 0.5)) {
        outPos.set(hx, hy, hz);
        useHermite = true;
      }
    }
    if (!useHermite) {
      outPos.set(lx, ly, lz);
    }
    // Yaw: lerp along shortest arc
    outRot.yaw = lerpAngle(s0.yaw, s1.yaw, a);
    outRot.pitch = s0.pitch + (s1.pitch - s0.pitch) * a;
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
    this.atExtCap = false;
    this.freshSeed = true;
  }

  get size(): number { return this.snapshots.length; }
}
