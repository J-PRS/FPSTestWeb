/**
 * ballNet — the server-driven replay half of Ball, pulled out so balls.ts
 * stays the visual/entity file. A netDriven ball replays shared/ballSim.ts
 * NON-authoritatively: `ballSegment` events snap pos/vel/target, and
 * between events these functions predict the same arc against the same
 * heightfield — bounce-for-bounce identical, so corrections are invisible
 * unless latency spikes.
 *
 * The replay writes the ball through two bags: `NetBag` holds the replay
 * cursors (sim anchor, grid clocks, leg stamps) and `NetHost` is the live
 * ball fields the replay mutates (pos/vel/renderOffset/enrage mirrors).
 * Room-level constants arrive as `NetStatics` closures so this module
 * never imports Ball back.
 */

import * as THREE from 'three';
import { GRAVITY } from '../core/config.js';
import { stepBall, type SimBall, type SimVec, type StructureCollider } from '../../../shared/ballSim.js';
import type { ColliderIndex } from '../../../shared/solidWorld.js';
import type { Heightfield } from '../../../shared/heightfield.js';
import { glitch } from '../core/fxDiag.js';

const BALL_GRAVITY = GRAVITY;
const _tgt = { x: 0, y: 0, z: 0 };
const _rpos = new THREE.Vector3();

/** Replay cursors the segment pipeline owns — Ball keeps the bag and the
 *  replay mutates it in place. */
export interface NetBag {
  sim: SimBall | null;
  /** Sim-time the ball's pos is evaluated at — server grid multiples of
   *  0.05. */
  simT: number;
  /** Fixed-dt accumulator — prediction steps at server rate. */
  netAcc: number;
  /** Last simNow estimate tickNet stepped against — the replay-vs-clock
   *  skew the render-blend counter needs to name its cause. -1 = unset. */
  lastSimNow: number;
  /** Sim-time stamp the current leg started at; inert flight measures T
   *  off the server clock so tick drift can't push prediction ahead of
   *  authority. -1 = unstamped (wall-time fallback). */
  legT0: number;
  netTargetId: string | null;
  /** Last rendered pos — frame-to-frame step telemetry names whether a
   *  ribbon jump came from sim-catch-up (netAcc sprint) or a seg snap. */
  px?: number; py?: number; pz?: number;
  /** Last segment's committed enraged — the wire contract the state-hash
   *  lane compares. Live s.enraged can't serve: both integrators derive
   *  it from their own stale target view, so it churns on healthy links. */
  netEnraged: boolean;
  /** The inert leg walked its arc into terrain and parked — divergence
   *  vs a still-flying authority is the park-vs-bounce guess, not desync. */
  parked: boolean;
  /** Segments applied since the bag minted — 0/1 is the join/roster
   *  heal, so counters that measure predictor correctness only run on
   *  later corrections. */
  segsSeen?: number;
  /** Set when the last renderOffset fold has an explained cause:
   *  stamp-lag rewind in applySeg (cursor legitimately ahead of the
   *  stamp — pd ≈ speed×lag) or a burst-drain catch-up in tickNet (gap
   *  inside the cells-stepped speed budget). render-blend reads it to
   *  skip the warn; every fold itself still applies. */
  foldExplained?: boolean;
  /** Wall clock of the last applySeg — a fold this frame is that
   *  segment's own correction; a jump with no fresh authority is the
   *  anomaly ball-step exists for. */
  lastSegWallMs?: number;
}

export function newNetBag(): NetBag {
  return { sim: null, simT: 0, netAcc: 0, lastSimNow: -1, legT0: -1, netTargetId: null, netEnraged: false, parked: false, segsSeen: 0 };
}

/** Live ball state the replay mutates — all shared refs, no copies. */
export interface NetHost {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Render-only correction: segment snaps shift `pos` to truth instantly
   *  (gameplay stays exact), while this offset carries the visual error
   *  and decays over ~0.2s — the ball slides instead of teleporting. */
  renderOffset: THREE.Vector3;
  emissive: THREE.Color;
  enraged: boolean;
  enrageTimer: number;
  dampNextBounce: boolean;
  dead: boolean;
}

/** Room-level wiring the replay needs — closures over Ball's statics. */
export interface NetStatics {
  field(): Heightfield | null;
  simNow(): number | undefined;
  colliders(): readonly StructureCollider[];
  colliderIndex(): ColliderIndex | null;
}

/** Server-authoritative replay: EVERY leg steps the shared integrator on
 *  the server's 50ms grid — inert and enraged alike. The old inert path
 *  solved the parabola analytically and ran its own structure/terrain
 *  contact march; two contact implementations meant two opinions about
 *  when a leg ends, which is where the fresh-leg heartbeat divergences
 *  lived. Now the client predicts the same bounce the server resolves —
 *  the wire event confirms, it doesn't correct. host.pos renders the
 *  sub-cell remainder ballistically so flight stays smooth between the
 *  20Hz sim steps. */
export function tickNet(st: NetStatics, bag: NetBag, host: NetHost, dt: number): void {
  const s = bag.sim!;
  bag.netAcc = Math.min(bag.netAcc + dt, 0.5);
  // Locked to the server's 50ms grid and gated on the stamped sim clock
  // so the replay neither phase-shifts nor free-runs ahead of authority.
  const simNow = st.simNow() ?? Infinity;
  bag.lastSimNow = simNow;
  // Stamps arrive batched once per drain: simNow jumps forward in bursts,
  // and consuming the whole backlog in one frame leaps pos 6-20m — the
  // exact per-frame step the ribbon cut counts as follow-jump. Pay the
  // backlog down over a few frames instead; steady-state arrivals are
  // ~1 cell/frame so the backlog never grows, but bursts smooth out
  // below the ribbon's discontinuity budget.
  // Fixed 2 while the bank isn't full — but a fixed cap under sustained
  // low fps drains slower than real time, starving simT behind the
  // stamped clock so every segment lands as a 20-30m correction
  // (render-blend, chronic negative skew, seen live in headless <10fps).
  // Only a FULL bank earns the dt-scaled drain: burst pacing intact,
  // starvation impossible, and a 250ms stall frame still pays down over
  // the next frames instead of leaping.
  let cellsLeft = bag.netAcc >= 0.5 ? Math.max(2, Math.ceil(dt / 0.05)) : 2;
  // Cells consumed this frame — the step gate below budgets ONE tick of
  // travel, but a burst drain legitimately moves speed×0.05 per cell, so
  // the budget scales by what was actually paid down.
  let cellsStepped = 0;
  // The committed target rides tp snapshots: enrage pull needs it, and an
  // inert ball's stall-breaker launches at it — predicting it client-side
  // mirrors the authority instead of waiting two seconds for the event.
  const tgt = s.tgtValid ? (_tgt.x = s.tx, _tgt.y = s.ty, _tgt.z = s.tz, _tgt) : null;
  const field = st.field();
  if (field) {
    while (cellsLeft > 0 && bag.netAcc >= 0.05 && bag.simT + 0.05 <= simNow) {
      cellsLeft -= 1;
      cellsStepped += 1;
      bag.netAcc -= 0.05;
      bag.simT += 0.05;
      stepBall(s, 0.05, field, tgt, false, { colliders: st.colliders(), colliderIndex: st.colliderIndex() ?? undefined });
    }
  }
  if (bag.netAcc >= 0.5 && field) {
    // Clock-estimate stalls must never freeze the sim — but a stale
    // estimate must not let prediction sprint ahead of authority
    // unboundedly either: once simT leads simNow the gate never
    // re-engages, so each 0.5s of silence banked another 0.5s of
    // blind flight, and resuming traffic warped enraged balls back
    // 50-190m. Cap the lead at 1s past the estimate; past that a
    // parked ball reads better than a guaranteed-wrong one.
    const leadCap = simNow === Infinity ? Infinity : simNow + 1;
    // The bank is capped at 0.5s so a stalled-clock burst is finite — but
    // draining it in ONE frame leaps the ball speed×0.5s (the acc=50
    // ball-step/follow-jump stream under low fps). Pace at ~2x real-time:
    // the backlog clears over a few frames, the fold stays small, and a
    // frozen clock still converges — just smoothly.
    let burst = Math.max(4, Math.ceil(dt / 0.05) * 2);
    while (burst > 0 && bag.netAcc >= 0.05 && bag.simT + 0.05 <= leadCap) {
      burst -= 1;
      cellsStepped += 1;
      bag.netAcc -= 0.05;
      bag.simT += 0.05;
      stepBall(s, 0.05, field, tgt, false, { colliders: st.colliders(), colliderIndex: st.colliderIndex() ?? undefined });
    }
  }
  // Sub-cell render: the sim rests on grid points; host.pos carries the
  // unconsumed fraction ballistically so motion doesn't quantize at 20Hz.
  const rem = Math.min(bag.netAcc, 0.05); // sub-cell fraction only — a banked backlog must not extrapolate pos ahead of the cells still paying it down
  _rpos.copy(host.pos).add(host.renderOffset); // rendered point before this rebuild
  host.pos.set(s.x + s.vx * rem, s.y + s.vy * rem + 0.5 * BALL_GRAVITY * rem * rem, s.z + s.vz * rem);
  if (bag.px !== undefined && bag.py !== undefined && bag.pz !== undefined) {
    const dx = host.pos.x - bag.px, dy = host.pos.y - bag.py, dz = host.pos.z - bag.pz;
    const gap2 = dx * dx + dy * dy + dz * dz;
    // Speed-scaled floor: a ball past ~100 m/s legitimately moves >5m
    // between 20Hz rebuilds — counting that as a step was ~90% noise.
    // Only fire when the leap outruns what the tick budget explains.
    const spdBudget = Math.hypot(s.vx, s.vy, s.vz) * 0.05 * Math.max(1, cellsStepped) + 5;
    if (gap2 > 25) {
      // Burst-drain folds (gap within the cells-stepped speed budget)
      // are pacing catch-up, not divergence — same class render-blend
      // is allowed to skip.
      bag.foldExplained = gap2 <= spdBudget * spdBudget;
      // Speed-scaled floor: a ball past ~100 m/s legitimately moves >5m
      // between 20Hz rebuilds — counting that as a step was ~90% noise.
      // Only fire when the leap outruns what the tick budget explains.
      // A fold within ~300ms wall of a segment IS that segment's own
      // correction (join/roster heal or seg-div's divergence — both
      // owned there); a jump with no fresh authority behind it is the
      // anomaly this warn exists for.
      const segAgeMs = performance.now() - (bag.lastSegWallMs ?? -1e9);
      if (gap2 > spdBudget * spdBudget && (bag.segsSeen ?? 0) > 3 && segAgeMs > 300) {
        glitch('ball-step', { gapM: Math.round(Math.sqrt(gap2)), acc: Math.round(bag.netAcc * 1000) });
      }
      // The step is honest truth — but it leaps the rendered ball past
      // every follower budget. Fold it into renderOffset so the catch-up
      // reads as a fast slide (offset decays ~0.2s) instead of a cut;
      // normal per-frame motion stays under the 5m floor untouched.
      _rpos.sub(host.pos);
      host.renderOffset.add(_rpos);
    }
  }
  bag.px = host.pos.x; bag.py = host.pos.y; bag.pz = host.pos.z;
  host.vel.set(s.vx, s.vy + BALL_GRAVITY * rem, s.vz);
  // Resting is a sim state now, not a prediction guess — parked marks a
  // settled ball whose authority-side wake event may still be in flight.
  bag.parked = s.vx === 0 && s.vy === 0 && s.vz === 0;
  host.enraged = s.enraged;
  host.enrageTimer = s.enrageTimer;
  host.dampNextBounce = s.dampNextBounce;
  if (s.dead && !host.dead) {host.dead = true;}
}

/** Wire-ordering guard — anchors only move forward. The stamp is compared
 *  against the leg START (legT0), not the sim cursor: enraged replay
 *  steps bag.simT toward estSimNow, which leads the server clock — a
 *  fresh segment stamped "now" arrives behind the stepped cursor and was
 *  being dropped as stale, leaving a dead leg extrapolating blind for a
 *  whole resync interval (the 20-120m rubberband storm, legAge≈1.2).
 *  A stamp newer than the anchor is always fresher truth; the cursor
 *  itself never rewinds (applySeg maxes it). */
/** A stamp this far behind the leg anchor can't be an in-flight stale
 *  packet — it's a new timeline: the server restarted or the room
 *  re-minted and its sim clock rewound to ~0 while our bags still anchor
 *  to the old epoch. Accept those as fresh truth or every heal and
 *  segment drops forever (the persistent ball-lane desync a server
 *  bounce produced). */
const TIMELINE_RESET_S = 30;

export function isStaleSeg(bag: NetBag, t: number | undefined): boolean {
  // Strictly older only: stamps have 50ms granularity, so two segments in
  // the same server tick (edge + heartbeat, hit + resync) share a stamp —
  // the second is fresher truth in wire order and MUST apply. Dropping it
  // replayed a dead leg for a whole interval (the 5-15m heartbeat warns).
  return t !== undefined && t < bag.legT0 && (bag.legT0 - t) <= TIMELINE_RESET_S;
}

// Carry the visible error into renderOffset: (old rendered pos) - (new
// truth). Prediction-vs-truth divergence is dominated by server-clock
// skew, not real desync — so every non-discontinuity correction blends
// (a 10m slide over 0.2s on a moving arc reads as nothing). Only
// teleport/spawn hard-snap: there continuity is impossible anyway.
function blendSegCorrection(host: NetHost, s: SimBall, seg: NetSeg): void {
  _rpos.copy(host.pos).add(host.renderOffset);
  _rpos.x -= s.x; _rpos.y -= s.y; _rpos.z -= s.z;
  if (seg.hard || _rpos.lengthSq() > 3600) {host.renderOffset.set(0, 0, 0);}
  else {host.renderOffset.copy(_rpos);}
  host.pos.set(s.x, s.y, s.z);
  host.vel.set(s.vx, s.vy, s.vz);
  host.enraged = s.enraged;
  host.enrageTimer = 0;
  if (!seg.enraged) {host.emissive.setRGB(0, 0, 0);}
}



/** Authoritative resync — a segment event lands mid-flight: snap the sim
 *  (and the render) to server truth, then advance it by `lead` seconds
 *  (≈half RTT) because the event is already stale when it arrives —
 *  without this every bounce visibly rewinds the ball before re-flying.
 *  The >20m trail-cut already handles teleport discontinuities. */
export function applySeg(st: NetStatics, bag: NetBag, host: NetHost, seg: NetSeg): void {
  const s = bag.sim;
  if (!s) {return;}
  const {simT} = seg;
  if (isStaleSeg(bag, simT)) {return;} // older stamp — never rewind
  // Divergence probe — every audited stepBall input is symmetric, yet
  // segments still correct 20-39m. Measure the predictor's pre-snap
  // distance from truth plus the replay span the stamp covers — the
  // delta the wire can't hide.
  const pd = Math.hypot(s.x - seg.px, s.y - seg.py, s.z - seg.pz);
  // Stamp-lag classification: how far of pd is explained by the cursor
  // having stepped past the stamp (flight at stamp speed over the gap),
  // vs real replay divergence. render-blend only warns on the latter.
  bag.foldExplained = simT !== undefined && bag.simT > simT
    && pd <= Math.hypot(s.vx, s.vy, s.vz) * (bag.simT - simT) * 1.5 + 3;
  // hard segments (teleport/spawn) are deliberate discontinuities — a
  // 100m+ snap is the feature, not predictor drift. Span gate: a stamp
  // covering seconds of stale anchor is a roster/join heal catching up
  // (367m @ 12s reads identically to drift but means nothing about the
  // predictor); real divergence shows on heartbeat-scale spans.
  const spanMs = simT !== undefined && bag.simT < simT ? (simT - bag.simT) * 1000 : -1;
  bag.segsSeen = (bag.segsSeen ?? 0) + 1;
  bag.lastSegWallMs = performance.now();
  // legT0 === -1 = never seeded: a first-segment snap is the roster heal,
  // not predictor drift — there is no prediction to diverge from yet.
  // segsSeen > 3 extends that grace past the FIRST heartbeats: the seed
  // leg plus its first ~2 stamped corrections are still join convergence
  // (the predictor ran ~1s from a stale seed — 20-30m is the heal, not
  // drift). Steady-state heartbeat divergence survives the gate.
  // spanMs < 0 = the stamp is BEHIND the local sim cursor — pd then
  // measures speed×(simT−t) of pure flight lag between two different
  // instants (a 150 m/s ball 150ms ahead reads 22m), not divergence.
  // Only a stamp newer than the cursor can show replay error.
  if (pd > 20 && !seg.hard && spanMs >= 0 && spanMs <= 4000 && bag.legT0 !== -1 && (bag.segsSeen ?? 0) > 3) {
    glitch('seg-div', { m: Math.round(pd), spanMs: Math.round(spanMs), enr: seg.enraged ? 1 : 0 });
  }
  s.x = seg.px; s.y = seg.py; s.z = seg.pz;
  s.vx = seg.vx; s.vy = seg.vy; s.vz = seg.vz;
  s.gt = 0; // stamped arc — the cached terrain-probe schedule is stale
  s.enraged = seg.enraged;
  // The timers ride the wire — resetting them here would restart the
  // server's 20s enrage countdown on every heartbeat and the client ball
  // would outlive enrages the authority already teleported out of.
  s.enrageTimer = seg.timers?.et ?? 0;
  s.slowTimer = seg.timers?.slowT ?? 0;
  s.dampNextBounce = seg.timers?.damp ?? false;
  // Aim snapshot — the server pulled toward THIS point, so we do too.
  if (seg.tp) { s.tx = seg.tp.x; s.ty = seg.tp.y; s.tz = seg.tp.z; s.tgtValid = true; }
  else {s.tgtValid = false;}
  bag.netTargetId = seg.targetId;
  bag.netEnraged = seg.enraged;
  // Step the event's lead age NOW, not banked for later: banking it in
  // netAcc drained 2 cells/frame, so a ~0.5s-late stamp made the ball
  // sprint 6x for ~5 frames — the per-heartbeat follow-jump stream.
  // Whole cells only: a partial-width step leaves the cursor off the
  // server's 0.05 grid and phase-shifts every later contact.
  const lead = Math.min(seg.lead ?? 0, 1);
  const cells = Math.floor(lead / 0.05);
  const field = st.field();
  // The leg's flight clock anchors to the stamped sim time — update()
  // measures T as estSimNow−legT0 so server-clock drift can't skew it.
  bag.legT0 = simT ?? -1; // unstamped event → wall-time fallback
  // Sim cursor anchors to the stamped grid time. isStaleSeg only lets
  // stamps NEWER than legT0 through, so rewinding the cursor to the
  // stamp is always a rewind to fresher truth — and it makes the step
  // gate replay the whole stamp→now gap on the new leg instead of just
  // the banked-lead cells.
  if (simT !== undefined) {bag.simT = simT;}
  if (field && cells > 0) {
    const tgt = s.tgtValid ? (_tgt.x = s.tx, _tgt.y = s.ty, _tgt.z = s.tz, _tgt) : null;
    for (let i = 0; i < cells; i += 1) {
      bag.simT += 0.05;
      stepBall(s, 0.05, field, tgt, false, { colliders: st.colliders(), colliderIndex: st.colliderIndex() ?? undefined });
    }
  }
  bag.netAcc = field && cells > 0 ? lead - cells * 0.05 : Math.min(lead, 0.5);
  bag.parked = false;
  blendSegCorrection(host, s, seg);
  // Re-anchor the step tracker to post-snap truth or the next tickNet
  // measures the correction AGAIN as a gap and folds it into renderOffset
  // a second time (the 20-50m render-blend/follow-jump double-blend).
  bag.px = s.x; bag.py = s.y; bag.pz = s.z;
}

/** Predicted position at sim-time `t`: clone the live replay sim and step
 *  it on the same 0.05 grid tickNet uses (ballistic sub-cell remainder,
 *  same as the render path). The rubberband watch compares this against a
 *  fresh segment stamp — same anchor, same integrator, same endpoint — so
 *  only real divergence (integrator/input mismatch) can produce error.
 *  Comparing host.pos to a stepped copy of the NEW anchor instead reads
 *  batch spacing as desync: a heartbeat arriving right behind a bounce
 *  edge finds the sim still parked at the just-applied anchor and errs by
 *  speed×legAge (~17m every heartbeat). */
const _probeTgt: SimVec = { x: 0, y: 0, z: 0 };
export function predictAt(st: NetStatics, bag: NetBag, t: number, out: THREE.Vector3): boolean {
  const live = bag.sim;
  if (!live) {return false;}
  const s = Object.assign({}, live);
  const tgt = s.tgtValid ? (_probeTgt.x = s.tx, _probeTgt.y = s.ty, _probeTgt.z = s.tz, _probeTgt) : null;
  const field = st.field();
  let cur = bag.simT;
  // The probe answers "did the replay diverge?" — it must evaluate at the
  // STAMP's sim-time, not the clock estimate: capping at simNow compared
  // sim@est to truth@m.t and read the inter-batch spacing as desync
  // (~2.4s of travel = the 100-300m warn bursts). cur+8 still bounds the
  // horizon — stale legs can't chase ∞.
  const end = Math.min(t, cur + 8);
  if (field) {
    while (cur + 0.05 <= end) {
      cur += 0.05;
      stepBall(s, 0.05, field, tgt, false, { colliders: st.colliders(), colliderIndex: st.colliderIndex() ?? undefined });
    }
  }
  const rem = Math.max(0, Math.min(0.05, end - cur));
  out.set(s.x + s.vx * rem, s.y + s.vy * rem + 0.5 * BALL_GRAVITY * rem * rem, s.z + s.vz * rem);
  return true;
}

// Segment event applied to a netDriven ball — server truth for the sim
// anchor plus the ride-along state (timers, aim snapshot, stamped clock).
export interface NetSeg {
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  enraged: boolean;
  targetId: string | null;
  lead?: number;
  timers?: { et?: number; slowT?: number; damp?: boolean };
  tp?: { x: number; y: number; z: number } | null;
  simT?: number;
  hard?: boolean;
}

