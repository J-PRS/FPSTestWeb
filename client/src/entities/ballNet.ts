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
import { stepBall, BALL_REST_SPEED, type SimBall, type StructureCollider } from '../../../shared/ballSim.js';
import type { ColliderIndex } from '../../../shared/solidWorld.js';
import { hmHeight, hmNormal, type Heightfield } from '../../../shared/heightfield.js';

const BALL_GRAVITY = GRAVITY;
const _tgt = { x: 0, y: 0, z: 0 };
const _rpos = new THREE.Vector3();
const _n = { x: 0, y: 0, z: 0 };

/** Replay cursors the segment pipeline owns — Ball keeps the bag and the
 *  replay mutates it in place. */
export interface NetBag {
  sim: SimBall | null;
  /** Sim-time the ball's pos is evaluated at — server grid multiples of
   *  0.05. */
  simT: number;
  /** Fixed-dt accumulator — prediction steps at server rate. */
  netAcc: number;
  /** Seconds flown on the current inert leg (analytic path). */
  flightT: number;
  /** Sim-time stamp the current leg started at; inert flight measures T
   *  off the server clock so tick drift can't push prediction ahead of
   *  authority. -1 = unstamped (wall-time fallback). */
  legT0: number;
  netTargetId: string | null;
}

export function newNetBag(): NetBag {
  return { sim: null, simT: 0, netAcc: 0, flightT: 0, legT0: -1, netTargetId: null };
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

/** Server-authoritative replay: enraged legs step the shared integrator
 *  on the server's 50ms grid; inert legs solve the parabola exactly. */
export function tickNet(st: NetStatics, bag: NetBag, host: NetHost, dt: number): void {
  const s = bag.sim!;
  if (s.enraged && s.tgtValid) {
    // Enrage pull curves the flight — must be stepped. Locked to the
    // server's 50ms grid and gated on the stamped sim clock so the
    // replay neither phase-shifts nor free-runs ahead of authority.
    bag.netAcc = Math.min(bag.netAcc + dt, 0.5);
    _tgt.x = s.tx; _tgt.y = s.ty; _tgt.z = s.tz;
    const simNow = st.simNow() ?? Infinity;
    while (bag.netAcc >= 0.05 && bag.simT + 0.05 <= simNow) {
      stepNetLeg(st, bag, host, s);
    }
    if (bag.netAcc >= 0.5) {
      // Clock-estimate stalls must never freeze the sim.
      while (bag.netAcc >= 0.05) stepNetLeg(st, bag, host, s);
    }
  } else {
    tickNetInert(st, bag, host, dt, s);
  }
  host.enraged = s.enraged;
  host.enrageTimer = s.enrageTimer;
  host.dampNextBounce = s.dampNextBounce;
  if (s.dead && !host.dead) host.dead = true;
}

// Inert leg: gravity-only flight is EXACTLY solvable — stepping adds
// 20Hz quantization for zero benefit. The closed form matches the
// server's semi-implicit Euler bit-for-bit (the +T*dt/2 term is the
// velocity update Euler applies before the position one), so an arc
// flies pixel-smooth until the next bounce event lands. T comes off
// the (rate-corrected) server sim clock — a lagging tick loop never
// overshoots; wall-time fallback until seeded.
function tickNetInert(st: NetStatics, bag: NetBag, host: NetHost, dt: number, s: SimBall): void {
  const simNow = st.simNow();
  let T = bag.legT0 >= 0 && simNow !== undefined && Number.isFinite(simNow)
    ? Math.min(Math.max(0, simNow - bag.legT0), 8)
    : (bag.flightT = Math.min(bag.flightT + dt, 8));
  // Structures hit mid-leg: the server resolves sphere∩box in
  // stepBall and stamps a bounce at contact — an analytic arc that
  // ignores them sails through the wall and the stamp lands 50-150m
  // off. March the leg for the earliest contact and park T there;
  // the stamped segment arrives with the reflected velocity.
  const tcS = firstStructureContact(st.colliders(), s, T);
  if (tcS < T) T = tcS;
  host.pos.set(
    s.x + s.vx * T,
    s.y + s.vy * T + 0.5 * BALL_GRAVITY * (T * T + 0.05 * T),
    s.z + s.vz * T,
  );
  host.vel.set(s.vx, s.vy + BALL_GRAVITY * T, s.vz);
  // Terrain: the server parks sub-REST contacts silently — no
  // segment is emitted — so a leg that touched down slow never
  // ends in an event. Walking T back to first contact and parking
  // keeps the prediction where authority actually left it (the
  // stall pounce event re-wakes it ~2s later). Fast contacts DO
  // produce a bounce event imminently — clamp, don't park.
  const field = st.field();
  const gy = field ? hmHeight(field, host.pos.x, host.pos.z) + s.radius : -Infinity;
  if (host.pos.y >= gy || !field) return;
  // March FORWARD on the server's 0.05 grid — the same cells groundContact
  // samples — so the predicted contact lands on the same point authority
  // resolves. (The old backward walk from arbitrary T was off-phase and
  // parked at last-airborne instead of first-contact.)
  let tc = T;
  for (let tt = 0.05; tt < T; tt += 0.05) {
    const yy = s.y + s.vy * tt + 0.5 * BALL_GRAVITY * (tt * tt + 0.05 * tt);
    const cx = s.x + s.vx * tt, cz = s.z + s.vz * tt;
    if (yy <= hmHeight(field, cx, cz) + s.radius) {
      // groundContact only resolves when moving INTO the surface — a
      // shallow graze with outward velocity is a fly-over server-side,
      // not a contact; parking here instead cost a whole resync
      // interval of false divergence (the 10-60m heartbeat errors).
      hmNormal(field, cx, cz, _n);
      const dot = s.vx * _n.x + (s.vy + BALL_GRAVITY * tt) * _n.y + s.vz * _n.z;
      if (dot < 0) { tc = tt; break; }
    }
  }
  const spd = Math.hypot(s.vx, s.vy + BALL_GRAVITY * tc, s.vz);
  // Park at the predicted contact point either way: slow contacts get no
  // segment (server settles silently), fast ones do — but holding the
  // overshot position clamps the ball under terrain for the interim.
  const cx = s.x + s.vx * tc, cz = s.z + s.vz * tc;
  host.pos.set(cx, hmHeight(field, cx, cz) + s.radius, cz);
  if (spd < BALL_REST_SPEED) {
    host.vel.set(0, 0, 0);
  } else {
    host.vel.set(s.vx, 0, s.vz); // coast until the bounce segment lands
  }
}

function stepNetLeg(st: NetStatics, bag: NetBag, host: NetHost, s: SimBall): void {
  bag.netAcc -= 0.05;
  bag.simT += 0.05;
  s.x = host.pos.x; s.y = host.pos.y; s.z = host.pos.z;
  s.vx = host.vel.x; s.vy = host.vel.y; s.vz = host.vel.z;
  stepBall(s, 0.05, st.field()!, _tgt, false, { colliders: st.colliders(), colliderIndex: st.colliderIndex() ?? undefined });
  host.pos.set(s.x, s.y, s.z);
  host.vel.set(s.vx, s.vy, s.vz);
}

/** Wire-ordering guard — anchors only move forward. The stamp is compared
 *  against the leg START (legT0), not the sim cursor: enraged replay
 *  steps bag.simT toward estSimNow, which leads the server clock — a
 *  fresh segment stamped "now" arrives behind the stepped cursor and was
 *  being dropped as stale, leaving a dead leg extrapolating blind for a
 *  whole resync interval (the 20-120m rubberband storm, legAge≈1.2).
 *  A stamp newer than the anchor is always fresher truth; the cursor
 *  itself never rewinds (applySeg maxes it). */
export function isStaleSeg(bag: NetBag, t: number | undefined): boolean {
  // Strictly older only: stamps have 50ms granularity, so two segments in
  // the same server tick (edge + heartbeat, hit + resync) share a stamp —
  // the second is fresher truth in wire order and MUST apply. Dropping it
  // replayed a dead leg for a whole interval (the 5-15m heartbeat warns).
  return t !== undefined && t < bag.legT0;
}

/** Authoritative resync — a segment event lands mid-flight: snap the sim
 *  (and the render) to server truth, then advance it by `lead` seconds
 *  (≈half RTT) because the event is already stale when it arrives —
 *  without this every bounce visibly rewinds the ball before re-flying.
 *  The >20m trail-cut already handles teleport discontinuities. */
export function applySeg(bag: NetBag, host: NetHost, seg: NetSeg): void {
  const s = bag.sim;
  if (!s) return;
  const simT = seg.simT;
  if (isStaleSeg(bag, simT)) return; // older stamp — never rewind
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
  else s.tgtValid = false;
  bag.netTargetId = seg.targetId;
  // Do NOT step the lead age here: a partial-width step leaves the sim
  // cursor off the server's 0.05 grid permanently — every subsequent
  // prediction step is phase-shifted, bounce contacts resolve at
  // different points, and elastic reflections compound the error into
  // the 20-100m rubberbands the logs show. Bank the age instead: the
  // update loop consumes whole cells only (sim stays exactly on-grid),
  // and the render path ballistically extrapolates the sub-step
  // remainder — which is all the lead was ever for.
  bag.netAcc = Math.min(seg.lead ?? 0, 0.5);
  bag.flightT = seg.lead ?? 0; // inert path flies on from the event's age — seamless handoff
  // The leg's flight clock anchors to the stamped sim time — update()
  // measures T as estSimNow−legT0 so server-clock drift can't skew it.
  bag.legT0 = simT ?? -1; // unstamped event → wall-time fallback
  // Sim cursor anchors to the stamped grid time. isStaleSeg only lets
  // stamps NEWER than legT0 through, so rewinding the cursor to the
  // stamp is always a rewind to fresher truth — and it makes the step
  // gate replay the whole stamp→now gap on the new leg instead of just
  // the banked-lead cells.
  if (simT !== undefined) bag.simT = simT;
  blendSegCorrection(host, s, seg);
}

// Carry the visible error into renderOffset: (old rendered pos) - (new
// truth). Prediction-vs-truth divergence is dominated by server-clock
// skew, not real desync — so every non-discontinuity correction blends
// (a 10m slide over 0.2s on a moving arc reads as nothing). Only
// teleport/spawn hard-snap: there continuity is impossible anyway.
function blendSegCorrection(host: NetHost, s: SimBall, seg: NetSeg): void {
  _rpos.copy(host.pos).add(host.renderOffset);
  _rpos.x -= s.x; _rpos.y -= s.y; _rpos.z -= s.z;
  if (seg.hard || _rpos.lengthSq() > 3600) host.renderOffset.set(0, 0, 0);
  else host.renderOffset.copy(_rpos);
  host.pos.set(s.x, s.y, s.z);
  host.vel.set(s.vx, s.vy, s.vz);
  host.enraged = s.enraged;
  host.enrageTimer = 0;
  if (!seg.enraged) host.emissive.setRGB(0, 0, 0);
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

/** Earliest analytic-time sphere∩OBB touch along a ballistic leg, marched
 *  in the server's 0.05 grid cells. Same contact predicate as
 *  shared/ballSim.ts collideStructures (clamped-point distance < radius)
 *  so the predictor finds the wall at (≤1 tick behind) the same instant
 *  authority does. Infinity = no contact before T. */
function firstStructureContact(colliders: readonly StructureCollider[], s: SimBall, T: number): number {
  if (!colliders.length) return Infinity;
  const r = s.radius;
  for (let tt = 0.05; tt <= T; tt += 0.05) {
    const x = s.x + s.vx * tt;
    const y = s.y + s.vy * tt + 0.5 * BALL_GRAVITY * (tt * tt + 0.05 * tt);
    const z = s.z + s.vz * tt;
    for (const c of colliders) {
      const dx = x - c.cx, dz = z - c.cz;
      const rr = Math.max(c.hx, c.hz) + r + 0.5;
      if (dx * dx + dz * dz > rr * rr) continue; // cheap xz broadphase
      const lx = dx * c.cos + dz * c.sin;
      const lz = -dx * c.sin + dz * c.cos;
      const dy = y - c.cy;
      const qx = Math.max(-c.hx, Math.min(c.hx, lx));
      const qy = Math.max(-c.hy, Math.min(c.hy, dy));
      const qz = Math.max(-c.hz, Math.min(c.hz, lz));
      const ex = lx - qx, ey = dy - qy, ez = lz - qz;
      if (ex * ex + ey * ey + ez * ez < r * r) return tt;
    }
  }
  return Infinity;
}
