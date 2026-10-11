import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
import { hmHeight, hmFingerprint } from '../../../shared/heightfield.js';
import { stepBall, makeSimBall, type SimBall, type SimVec } from '../../../shared/ballSim.js';
import { screenShake } from '../effects/screenShake.js';
import { Ball, type Targetable } from '../entities/balls.js';
import { predictAt } from '../entities/ballNet.js';
import { SIM_TICK_DT, finiteVec } from '../../../shared/wire.js';
import type { Nugget } from '../entities/Nugget.js';
import type { EntitiesDeps } from './entities.js';
import { reconcileReplicas } from './replicas.js';
import type { ChildLogger } from '../core/Logger.js';

export interface NetBallsCtx {
  balls: Ball[];
  targets: Targetable[];
  nuggets: Nugget[];
}

type Vec3Msg = { x: number; y: number; z: number };

// Bounce carries approach overshoot proportional to speed — a
// terminal-speed ball legitimately diverges tens of meters on a bounce
// tick, so its floor scales with velocity. Lunge/teleport/spawn are
// server-side RNG the predictor can't foresee; segment heartbeat is the
// only kind where >4m is a real desync — but a bounce whose segment is
// still in flight inflates the check by up to speed×~0.5s (latency +
// batch window), so the heartbeat floor scales the same way. A truly
// missed resync drifts two whole intervals — still well above it.
function rubberbandWarnAt(kind: string, speed: number): number {
  if (kind === 'lunge' || kind === 'teleport' || kind === 'spawn') {return 40;}
  if (kind === 'bounce' || kind === 'stall') {return Math.max(12, speed * 0.6);}
  return Math.max(4, speed * 0.5);
}

/** Roster reconciliation: anything we track that the server's roster no
 *  longer lists gets netKill'd — a ball that died during a reconnect gap
 *  (or whose ballDie dropped) would otherwise ghost forever. */
export function pruneNetBalls(map: Map<number, { netKill(): void }>, liveIds: Set<number>): void {
  for (const [id, ball] of map) {
    if (liveIds.has(id)) {continue;}
    map.delete(id);
    ball.netKill();
  }
}

// ---- Server-owned balls (shared PvE) ---------------------------------
// Connected = the server sims all ball flight; ballSpawn/ballSegment/
// ballDie events drive netDriven Ball instances that replay the shared
// integrator. Offline = the classic local sim (see spawnBall in entities).
// Server-sim clock: every ball event is stamped with the server's
// monotonic sim time. Track the newest stamp + when it arrived to
// estimate "server now" — event AGE = estNow − stamp measures TRUE
// staleness including packet loss/retransmit delay, which ping÷2 can't
// see (at 50% loss, events routinely arrive hundreds of ms late).
export function makeBallClock(getPing: () => number) {
  // The server's sim clock is setInterval-driven — under load it ticks
  // slower than wall time. Track the sim→wall RATE (Δstamp/Δarrival is
  // an exact rate sample regardless of how events space out) so both the
  // prediction gate and event-age extrapolation ride the server's clock,
  // not ours. Without it we extrapolate legs too far and watch bounces
  // early — the residual rubberband warns.
  const clock = { t: -1, at: 0, rate: 1 };
  function noteStamp(t: number): void {
    const now = performance.now() / 1000;
    if (t > clock.t) {
      if (clock.t >= 0) {
        const ds = t - clock.t, dw = now - clock.at;
        if (ds > 0 && dw > 0.2) {
          const r = Math.min(1.2, Math.max(0.5, ds / dw));
          clock.rate += (r - clock.rate) * 0.2; // EMA
        }
      }
      clock.t = t; clock.at = now;
      // Re-anchor also lowers the floor when the stamp is far behind the
      // running estimate (reconnect epoch, burst replay) — otherwise a
      // stale-high lastEst would pin every event's age at 0.
      lastEst = Math.min(lastEst, t + 0.5);
    }
  }
  // The estimate must never rewind: every consumer turns it into a
  // position (rem extrapolation on _rpos) or an age. A new stamp that
  // lands BELOW the running extrapolation (rate overshot, or events
  // arrived in a burst) would snap _rpos backward by vel×Δ — the ball
  // follow-jump cuts in the dump. Clamp monotonic; the EMA rate heals
  // any forward overshoot by slowing the clock instead of jumping it.
  let lastEst = -1;
  function estSimNow(): number {
    const now = performance.now() / 1000;
    if (clock.t < 0) {return Infinity;}
    const est = clock.t + (now - clock.at) * clock.rate;
    if (est > lastEst) {lastEst = est;}
    return lastEst;
  }
  function ballEventAge(t: number | undefined): number {
    if (t === undefined) {
      // Unstamped (shouldn't happen post-v3) — fall back to ½RTT.
      return Math.min(0.2, getPing() / 2000);
    }
    noteStamp(t);
    return Math.min(0.6, Math.max(0, estSimNow() - t));
  }
  return { noteStamp, estSimNow, ballEventAge };
}

function targetPosForId(deps: EntitiesDeps, id: string | null | undefined): THREE.Vector3 | null {
  const nm = deps.lazyNetworkManager();
  return id === nm?.getLocalPlayerId() ? deps.lazyPlayer().pos
    : (id ? deps.world.remotePlayers.get(id)?.pos ?? null : null);
}

// Terrain forensics: a bounce stamp lands at ground contact, so truth.y
// should sit ~radius above the field the sim bounced on. fieldH vs
// terrainH split "stale heightfield" from "integrator drift" — if they
// differ, Ball.field is a dead snapshot.
function rubberbandForensics(deps: EntitiesDeps, b: Ball, m: { position: Vec3Msg }) {
  const bf = Ball.netField;
  const diag = b.netDiag;
  return {
    pred: { x: Number(b.pos.x.toFixed(1)), y: Number(b.pos.y.toFixed(1)), z: Number(b.pos.z.toFixed(1)) },
    truth: { x: Number(m.position.x.toFixed(1)), y: Number(m.position.y.toFixed(1)), z: Number(m.position.z.toFixed(1)) },
    fieldH: Number((bf ? hmHeight(bf, m.position.x, m.position.z) : Number.NaN).toFixed(1)),
    terrainH: Number(deps.lazyTerrain().getHeight(m.position.x, m.position.z).toFixed(1)),
    fieldFp: bf ? hmFingerprint(bf) : 'none',
    // Regime forensics: simT>simNow = the catch-all free-ran ahead;
    // legAge pinned ~8 = inert leg extrapolating a stale anchor.
    simT: diag ? Number(diag.simT.toFixed(2)) : null,
    simNow: diag && diag.simNow !== null ? Number(diag.simNow.toFixed(2)) : null,
    legT0: diag ? Number(diag.legT0.toFixed(2)) : null,
    legAge: diag ? Number(diag.legAge.toFixed(2)) : null,
    enraged: diag?.enraged ?? null,
    tgtValid: diag?.tgtValid ?? null,
    // Anchor = leg start state, rounded — raw f64s made every warn line
    // triple-wide for digits nobody reads (replay offline if needed).
    anchor: diag?.anchor
      ? { x: Number(diag.anchor.x.toFixed(1)), y: Number(diag.anchor.y.toFixed(1)), z: Number(diag.anchor.z.toFixed(1)),
          vx: Number(diag.anchor.vx.toFixed(1)), vy: Number(diag.anchor.vy.toFixed(1)), vz: Number(diag.anchor.vz.toFixed(1)) }
      : null,
  };
}

function netBallDie(deps: EntitiesDeps, netBallById: Map<number, Ball>,
    m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
  const b = netBallById.get(m.id);
  if (!b) {return;}
  netBallById.delete(m.id);
  const dm = deps.lazyDemoManager();
  if (dm?.isRecording) {
    dm.recordTargetDestroyed(m.id, m.position, b.variant, b.health);
  }
  b.netKill();
  sfx.enemyCue(b.pos, 'die');
  screenShake.blast(b.pos, 1.6, deps.lazyPlayer().pos);
  if (m.by && m.by === deps.lazyNetworkManager()?.getLocalPlayerId()) {
    // Our kill — in team rooms the server drops a gem at the corpse
    // (pickupSpawn); collecting it is the score AND the reward.
    deps.lazyPlayer().kills += 1;
  }
}

// Rubberband watch: how far our predicted replay was from the event's
// truth. >2m = visible warp worth logging; >4m means prediction diverged
// hard (latency spike or a sim mismatch — that one's a bug, not lag).
// Per-ball throttle folds repeats into ×N; the fleet aggregate folds
// THROTTLED warns into one 10s summary — a desync storm reads as a
// number, not a scroll.
export function makeRubberbandWatch(deps: EntitiesDeps, ballEventAge: (t?: number) => number, estSimNow: () => number, logger: ChildLogger) {
  const _truthPos = new THREE.Vector3();
  const _msgPos = new THREE.Vector3();
  // predictAt's world view — same field/colliders/clock the live replay reads.
  const NET_PROBE_S = {
    field: () => Ball.netField,
    simNow: () => estSimNow(),
    colliders: () => Ball.colliders,
    colliderIndex: () => Ball.colliderIndex,
  };
  const _rbSim: SimBall = makeSimBall(0, 0, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const _rbTgt: SimVec = { x: 0, y: 0, z: 0 };
  const rbLastWarn = new Map<number, number>();
  const rbSuppressed = new Map<number, number>();
  // Warn-throttle receipts are keyed by ball id and this closure can't
  // see the roster prune — a long match churns ids and the maps would
  // grow forever. Evict-oldest bounds them; a dropped receipt just
  // re-arms a warn.
  const RB_MAP_MAX = 512;
  function cappedSet(map: Map<number, number>, k: number, v: number): void {
    map.set(k, v);
    if (map.size > RB_MAP_MAX) {
      const it = map.keys();
      for (let i = map.size - RB_MAP_MAX; i > 0; i -= 1) {map.delete(it.next().value!);}
    }
  }
  const RB_WARN_MS = 2000;
  let rbFleetCount = 0;
  let rbFleetWorst = { id: -1, err: 0 };
  let rbFleetFlushAt = 0;
  const RB_FLEET_MS = 10_000;

  function rbFleetNote(id: number, err: number): void {
rbFleetCount += 1;
    if (err > rbFleetWorst.err) {rbFleetWorst = { id, err };}
    if (rbFleetFlushAt === 0) {rbFleetFlushAt = performance.now() + RB_FLEET_MS;}
  }

  function rbFleetFlush(): void {
    if (!rbFleetCount) {return;}
    const nowMs = performance.now();
    if (nowMs < rbFleetFlushAt) {return;}
    logger.warn(`ball rubberbands: ${rbFleetCount} suppressed in ${RB_FLEET_MS / 1000}s${ 
      rbFleetWorst.id >= 0 ? `, worst #${rbFleetWorst.id} ${rbFleetWorst.err.toFixed(0)}m` : ''}`);
    rbFleetCount = 0;
    rbFleetWorst = { id: -1, err: 0 };
    rbFleetFlushAt = nowMs + RB_FLEET_MS;
  }

  /** Where the segment's own state lands by now when replayed through the
   *  same integrator the prediction ran — a ballistic pos+vel*age can't
   *  follow gravity or the enrage pull, so pulled balls were tripping the
   *  warn on the metric, not the desync. Falls back to ballistic when the
   *  field isn't bound yet. */
  function truthAt(b: Ball, m: RbMsg, age: number): void {
    const field = Ball.netField;
    // Advance truth to the SAME endpoint the prediction evaluates at:
    // enraged legs step to the simT cursor, inert legs solve the arc at
    // estSimNow (simT stays at the anchor) — take whichever leads, so
    // the compare can't misread clock lead as divergence. The 8s cap is
    // the same bound the inert T evaluation uses.
    const span = m.t === undefined ? age : Math.min(8, Math.max(b.netDiag?.simT ?? 0, estSimNow()) - m.t);
    if (!field || span <= 0) {
      _truthPos.set(
        m.position.x + m.velocity.x * age,
        m.position.y + m.velocity.y * age,
        m.position.z + m.velocity.z * age,
      );
      return;
    }
    const s = _rbSim;
    s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
    s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z;
    s.enraged = m.enraged ?? false;
    s.enrageTimer = m.et ?? 0; s.slowTimer = m.slowT ?? 0; s.dampNextBounce = Boolean(m.damp);
    if (m.tp) { s.tx = m.tp.x; s.ty = m.tp.y; s.tz = m.tp.z; s.tgtValid = true; } else {s.tgtValid = false;}
    s.radius = b.radius; s.gt = 0; s.dead = false;
    _rbTgt.x = s.tx; _rbTgt.y = s.ty; _rbTgt.z = s.tz;
    const steps = Math.min(48, Math.floor(span / SIM_TICK_DT));
    for (let i = 0; i < steps; i += 1) {
      stepBall(s, SIM_TICK_DT, field, s.tgtValid ? _rbTgt : null, false, { colliders: Ball.colliders, colliderIndex: Ball.colliderIndex ?? undefined });
    }
    // Sub-cell remainder is ballistic — a partial step would leave the
    // probe off the server's tick phase (same rule stepNetLeg obeys).
    const rem = span - steps * SIM_TICK_DT;
    _truthPos.set(s.x + s.vx * rem, s.y + s.vy * rem, s.z + s.vz * rem);
  }

  interface RbMsg { id: number; kind?: string; position: Vec3Msg; velocity: Vec3Msg; t?: number; enraged?: boolean; et?: number; slowT?: number; damp?: boolean; tp?: Vec3Msg | null }

  /** Noise gates between the error measurement and the warn — every early
   *  out is a divergence that's the design working, not a desync signal. */
  function gated(b: Ball, m: RbMsg, kind: string, err: number, speed: number): boolean {
    if (err <= rubberbandWarnAt(kind, speed)) {
      if (err > 2) {logger.debug(`ball #${m.id} segment correction ${err.toFixed(1)}m`);}
      return true;
    }
    // A sim that never replayed through this stamp can't have diverged
    // from it: when two segments for one ball drain in the same frame
    // (a stall's backlog, hidden-tab catch-up), applySeg just re-anchored
    // the cursor — pred sits one event-spacing behind truth and err
    // measures segment spacing (~17m at ball speed), not prediction drift.
    // One cell of slack covers the sim resting mid-grid, not unreplayed.
    const simT = b.netDiag?.simT;
    if (m.t !== undefined && simT !== undefined && simT < m.t - SIM_TICK_DT) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m on unreplayed stamp (simT ${simT.toFixed(2)} < t ${m.t.toFixed(2)})`);
      return true;
    }
    // A terrain swap leaves prediction on the previous field until the new
    // bin loads and rebinds — every bounce in that window diverges by
    // design, so the warn is noise, not a desync signal.
    if (Ball.terrainSwapping) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m during terrain swap`);
      return true;
    }
    // Stale-leg extrapolation isn't a desync: distance-tiered sends leave
    // far balls on a committed anchor for many seconds, and the inert leg
    // CAN'T track lunge/enrage retargets in between. Divergence there is
    // the design working — warn only on a fresh anchor, where the sim
    // genuinely disagrees with the server.
    const legAge = b.netDiag?.legAge ?? 0;
    if (legAge > 3) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m on stale leg (legAge ${legAge.toFixed(1)}s)`);
      return true;
    }
    // A parked leg is the predictor's own guess at a terrain settle — if
    // the authority bounced instead, the event is simply still in flight
    // and the gap is the park-vs-bounce ambiguity, not desync.
    if (b.netDiag?.parked) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m on parked leg`);
      return true;
    }
    return false;
  }

  function check(b: Ball, m: RbMsg): void {
    const age = ballEventAge(m.t);
    const speed = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z);
    const kind = m.kind ?? 'segment';
    // Segment heartbeats measure divergence, not spacing: step the LIVE
    // replay sim to the stamp's sim-time and compare endpoints. The old
    // metric (host.pos vs the new anchor replayed to estSimNow) found the
    // sim still parked on the anchor applied in the same drain batch —
    // every heartbeat warned at ~speed×legAge (~17m) forever.
    const stamped = kind === 'segment' && m.t !== undefined
      && predictAt(NET_PROBE_S, b.netS, m.t, _truthPos);
    if (!stamped) {truthAt(b, m, age);} // fleet metric keeps the old endpoint
    const err = stamped
      ? _truthPos.distanceTo(_msgPos.set(m.position.x, m.position.y, m.position.z))
      : b.pos.distanceTo(_truthPos);
    if (gated(b, m, kind, err, speed)) {return;}
    // Discontinuity kinds (teleport/spawn/lunge/enrage) carry NO desync
    // signal — they reposition or retarget the ball, so err measures the
    // correction's own size (~legAge×speed), which prediction can never
    // foresee. Counting them made the fleet warn report event spacing.
    // Continuation kinds (bounce/stall) keep a path prediction already
    // knew — divergence there is real — and join 'segment' heartbeats in
    // the fleet metric.
    if (kind !== 'segment' && kind !== 'bounce' && kind !== 'stall') {
      logger.debug(`ball #${m.id} ${kind} correction ${err.toFixed(1)}m (path-changing event)`);
      return;
    }
    if (kind !== 'segment') {
      rbFleetNote(m.id, err);
      return;
    }
    const nowMs = performance.now();
    const lastW = rbLastWarn.get(m.id) ?? -Infinity;
    if (nowMs - lastW < RB_WARN_MS) {
      cappedSet(rbSuppressed, m.id, (rbSuppressed.get(m.id) ?? 0) + 1);
      rbFleetNote(m.id, err);
      return;
    }
    const sup = rbSuppressed.get(m.id) ?? 0;
    cappedSet(rbLastWarn, m.id, nowMs);
    rbSuppressed.delete(m.id);
    const diag = b.netDiag;
    const regime = diag
      ? ` enr=${diag.enraged ? 1 : 0} tgt=${diag.tgtValid ? 1 : 0} leg=${diag.legAge.toFixed(1)} simT=${diag.simT.toFixed(1)} now=${diag.simNow === null ? '?' : diag.simNow.toFixed(1)}` +
        ` py=${b.pos.y.toFixed(0)} ty=${m.position.y.toFixed(0)} gy=${Ball.netField ? hmHeight(Ball.netField, m.position.x, m.position.z).toFixed(0) : '?'}`
      : '';
    logger.warn(
      `ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m (age ${(age * 1000).toFixed(0)}ms) — prediction diverged${regime}${sup ? ` (×${sup + 1})` : ''}`,
      rubberbandForensics(deps, b, m));
  }

  return { check, rbFleetFlush };
}

export function createNetBalls(deps: EntitiesDeps, ctx: NetBallsCtx, logger: ChildLogger) {
  const { scene, balls, targets } = {scene: deps.scene, ...ctx};
  const netBallById = new Map<number, Ball>();
  // A P2P host carries no ball sim — peers keep client-side balls there.
  const serverBalls = (): boolean => deps.lazyNetworkManager()?.authoritySims() ?? false;
  Ball.hitClaim = (netId, dmg, ix, iy, iz) =>
    deps.lazyNetworkManager()?.sendCreatureHit(netId, dmg, ix, iy, iz);

  const ballClock = makeBallClock(() => deps.lazyNetworkManager()?.getPing() ?? 0);
  const { estSimNow, ballEventAge } = ballClock;
  Ball.netSimNow = estSimNow;

  // A non-finite component in authority state (server fault, hostile p2p
  // peer) silently poisons the replay sim — drop the edge and warn.
  const finiteMsg = (m: { position: Vec3Msg; velocity: Vec3Msg; tp?: Vec3Msg | null }) =>
    finiteVec(m.position) && finiteVec(m.velocity) && (!m.tp || finiteVec(m.tp));

  function netBallSpawn(m: { id: number; variant: number; colorIdx: number; position: Vec3Msg; velocity: Vec3Msg; t?: number; enraged?: boolean; targetId?: string | null; tp?: Vec3Msg | null; et?: number; slowT?: number; damp?: boolean }): void {
    if (!finiteMsg(m)) {logger.warn(`ball spawn #${m.id} dropped: non-finite vector`); return;}
    if (netBallById.has(m.id)) {return;}
    Ball.initNetMode();
    const ball = new Ball(scene, deps.lazyTerrain(), m.variant as 0 | 1 | 2 | 3, {
      id: m.id,
      x: m.position.x, y: m.position.y, z: m.position.z,
      vx: m.velocity.x, vy: m.velocity.y, vz: m.velocity.z,
      colorIdx: m.colorIdx,
    });
    balls.push(ball);
    targets.push(ball);
    netBallById.set(m.id, ball);
    // Server-owned balls never pass through the offline spawn path, so the
    // demo recorder needs its lifecycle events written here instead.
    const dm = deps.lazyDemoManager();
    if (dm?.isRecording) {
      dm.recordTargetSpawned(m.id, m.position, m.velocity, m.variant);
    }
    // Spawn events are stale on arrival too — fast-forward from the
    // stamped state so the ball materializes where the server already is.
    // Always applies (even at ~0ms): it's the only path that seeds the
    // committed targetId + aim snapshot before the first segment lands.
    ball.applyNetSegment({
      px: m.position.x, py: m.position.y, pz: m.position.z,
      vx: m.velocity.x, vy: m.velocity.y, vz: m.velocity.z,
      enraged: m.enraged ?? false, targetId: m.targetId ?? null,
      lead: ballEventAge(m.t), timers: { et: m.et, slowT: m.slowT, damp: m.damp }, tp: m.tp, simT: m.t,
    });
  }

  const { check: rubberbandCheck, rbFleetFlush } = makeRubberbandWatch(deps, ballEventAge, estSimNow, logger);

  function netBallSegment(m: { id: number; kind?: string; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; enraged: boolean; targetId: string | null; t?: number; et?: number; slowT?: number; damp?: boolean; tp?: Vec3Msg | null }): void {
    const b = netBallById.get(m.id);
    if (!b) {return;}
    if (!finiteMsg(m)) {logger.warn(`ball #${m.id} ${m.kind ?? 'segment'} dropped: non-finite vector`); return;}
    // Out-of-order delivery guard: an older stamp would rewind the sim
    // anchor and the next frames would extrapolate a stale leg — that
    // rewind was a live source of the giant rubberband warns.
    if (b.isStaleSegment(m.t)) {
      logger.debug(`ball #${m.id} stale segment dropped (t=${m.t})`);
      return;
    }
    rubberbandCheck(b, m);
    rbFleetFlush();
    const age = ballEventAge(m.t);
    b.applyNetSegment({
      px: m.position.x, py: m.position.y, pz: m.position.z,
      vx: m.velocity.x, vy: m.velocity.y, vz: m.velocity.z,
      enraged: m.enraged, targetId: m.targetId,
      lead: age, timers: { et: m.et, slowT: m.slowT, damp: m.damp },
      tp: m.tp, simT: m.t, hard: m.kind === 'teleport' || m.kind === 'spawn',
    });
    // Only real discontinuities are worth a demo keyframe — 'segment'
    // heartbeats would drown the event stream (dozens/sec fleet-wide).
    if (m.kind && m.kind !== 'segment') {
      const dm = deps.lazyDemoManager();
      if (dm?.isRecording) {
        dm.recordTargetBounce(m.id, m.position, m.velocity, b.variant);
      }
    }
  }

  // Roster is authoritative for membership, not just spawns: a ball that
  // died while we were reconnecting (or whose ballDie dropped on an
  // unreliable lane) would otherwise ghost forever — nothing else removes it.
  function netBallRoster(m: { balls: { id: number; variant: number; colorIdx: number; position: Vec3Msg; velocity: Vec3Msg; t?: number; enraged?: boolean; targetId?: string | null; tp?: Vec3Msg | null; et?: number; slowT?: number; damp?: boolean }[] }): void {
    reconcileReplicas(netBallById, m.balls, {
      rowId: (r) => r.id,
      ensure: (r) => { netBallSpawn(r); return netBallById.get(r.id); },
      reap: (b) => b.netKill(),
    });
    // Membership reconcile alone left existing replicas running on stale
    // regime fields (enraged/targetId/timers) — a missed retarget edge
    // then desynced the ball lane permanently. The roster is also the
    // state heal: soft-apply each row's committed state onto live balls.
    for (const r of m.balls) {
      const b = netBallById.get(r.id);
      if (!b) {continue;} // just spawned — seeded already
      // Variant is constructor-fixed — a wrong-variant replica (recycled
      // id, corrupt spawn edge) can't patch its way to truth, it can only
      // desync the lane on every hash check. Roster wins: kill + respawn.
      if (b.variant !== r.variant) {
        b.netKill();
        netBallById.delete(r.id);
        netBallSpawn(r);
        continue;
      }
      // Same wire law as netBallSegment: a NaN roster row would write
      // straight into the ball's replay state — the segment gate never
      // sees this path.
      if (!finiteMsg(r)) {logger.warn(`ball #${r.id} roster edge dropped: non-finite vector`); continue;}
      b.applyNetSegment({
        px: r.position.x, py: r.position.y, pz: r.position.z,
        vx: r.velocity.x, vy: r.velocity.y, vz: r.velocity.z,
        enraged: r.enraged ?? false, targetId: r.targetId ?? null,
        lead: ballEventAge(r.t), timers: { et: r.et, slowT: r.slowT, damp: r.damp },
        tp: r.tp, simT: r.t,
      });
    }
  }

  // A netDriven ball pulls toward ITS committed target — resolve the id to
  // a live position (ours or the remote's) each frame.
  function netTargetPosFor(b: Ball): THREE.Vector3 {
    const id = b.netTargetId;
    if (id) {
      const p = targetPosForId(deps, id);
      if (p) {return p;}
    }
    return b.pos; // no committed target — self pos means zero pull direction
  }

  return { serverBalls, netBallSpawn, netBallSegment,
    netBallDie: (m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }) => netBallDie(deps, netBallById, m),
    netBallRoster, netTargetPosFor };
}
