import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
import { hmHeight, hmFingerprint } from '../../../shared/heightfield.js';
import { screenShake } from '../effects/screenShake.js';
import { Ball, type Targetable } from '../entities/balls.js';
import { Nugget } from '../entities/Nugget.js';
import type { EntitiesDeps } from './entities.js';
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
// only kind where >4m is a real desync.
function rubberbandWarnAt(kind: string, speed: number): number {
  if (kind === 'lunge' || kind === 'teleport' || kind === 'spawn') return 40;
  if (kind === 'bounce' || kind === 'stall') return Math.max(12, speed * 0.6);
  return 4;
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
function makeBallClock(getPing: () => number) {
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
    }
  }
  function estSimNow(): number {
    const now = performance.now() / 1000;
    return clock.t < 0 ? Infinity : clock.t + (now - clock.at) * clock.rate;
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
    pred: { x: +b.pos.x.toFixed(1), y: +b.pos.y.toFixed(1), z: +b.pos.z.toFixed(1) },
    truth: { x: +m.position.x.toFixed(1), y: +m.position.y.toFixed(1), z: +m.position.z.toFixed(1) },
    fieldH: +(bf ? hmHeight(bf, m.position.x, m.position.z) : NaN).toFixed(1),
    terrainH: +deps.lazyTerrain().getHeight(m.position.x, m.position.z).toFixed(1),
    fieldFp: bf ? hmFingerprint(bf) : 'none',
    // Regime forensics: simT>simNow = the catch-all free-ran ahead;
    // legAge pinned ~8 = inert leg extrapolating a stale anchor.
    simT: diag ? +diag.simT.toFixed(2) : null,
    simNow: diag?.simNow ?? null,
    legT0: diag ? +diag.legT0.toFixed(2) : null,
    legAge: diag ? +diag.legAge.toFixed(2) : null,
    enraged: diag?.enraged ?? null,
  };
}

function netBallDie(deps: EntitiesDeps, netBallById: Map<number, Ball>,
    m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
  const b = netBallById.get(m.id);
  if (!b) return;
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
    deps.lazyPlayer().kills++;
  }
}

export function createNetBalls(deps: EntitiesDeps, ctx: NetBallsCtx, logger: ChildLogger) {
  const { scene, balls, targets } = { scene: deps.scene, ...ctx };
  const netBallById = new Map<number, Ball>();
  const serverBalls = (): boolean => deps.lazyNetworkManager()?.isConnected() ?? false;
  Ball.hitClaim = (netId, dmg, ix, iy, iz) =>
    deps.lazyNetworkManager()?.sendCreatureHit(netId, dmg, ix, iy, iz);

  const ballClock = makeBallClock(() => deps.lazyNetworkManager()?.getPing() ?? 0);
  const { estSimNow, ballEventAge } = ballClock;
  Ball.netSimNow = estSimNow;

  function netBallSpawn(m: { id: number; variant: number; colorIdx: number; position: Vec3Msg; velocity: Vec3Msg; t?: number; enraged?: boolean; targetId?: string | null; tp?: Vec3Msg | null }): void {
    if (netBallById.has(m.id)) return;
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
      lead: ballEventAge(m.t), tp: m.tp, simT: m.t,
    });
  }

  // Rubberband watch: how far our predicted replay was from the event's
  // truth. >2m = visible warp worth logging; >4m means prediction diverged
  // hard (latency spike or a sim mismatch — that one's a bug, not lag).
  // Rubberband warns throttle per-ball: first divergence in a window
  // fires immediately, repeats within 2s are counted and folded into the
  // next line as ×N — a desyncing ball would otherwise drown every other
  // warn stream (and client_warning.log) at ~10 lines/sec.
  const _truthPos = new THREE.Vector3();
  const rbLastWarn = new Map<number, number>();
  const rbSuppressed = new Map<number, number>();
  const RB_WARN_MS = 2000;

  /** Rubberband watch: how far our predicted replay is from the event's
   *  truth advanced to NOW (pos + vel·age). >2m = visible warp; past the
   *  per-kind warnAt means prediction genuinely diverged — that one's a
   *  bug signal, not lag. Per-ball throttle folds repeats into ×N. */
  function rubberbandCheck(b: Ball, m: { id: number; kind?: string; position: Vec3Msg; velocity: Vec3Msg; t?: number }): void {
    const age = ballEventAge(m.t);
    const speed = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z);
    _truthPos.set(
      m.position.x + m.velocity.x * age,
      m.position.y + m.velocity.y * age,
      m.position.z + m.velocity.z * age,
    );
    // Predicted replay position vs the event's truth advanced to now —
    // the metric the header comment describes. (It previously compared
    // the stamped pos to itself-plus-lead, which is just speed·age and
    // fired on every fast ball regardless of real divergence.)
    const err = b.pos.distanceTo(_truthPos);
    const kind = m.kind ?? 'segment';
    if (err <= rubberbandWarnAt(kind, speed)) {
      if (err > 2) logger.debug(`ball #${m.id} segment correction ${err.toFixed(1)}m`);
      return;
    }
    // A terrain swap leaves prediction on the previous field until the new
    // bin loads and rebinds — every bounce in that window diverges by
    // design, so the warn is noise, not a desync signal.
    if (Ball.terrainSwapping) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m during terrain swap`);
      return;
    }
    // Stale-leg extrapolation isn't a desync: distance-tiered sends leave
    // far balls on a committed anchor for many seconds, and the inert leg
    // CAN'T track lunge/enrage retargets in between. Divergence there is
    // the design working — warn only on a fresh anchor, where the sim
    // genuinely disagrees with the server.
    const legAge = b.netDiag?.legAge ?? 0;
    if (legAge > 3) {
      logger.debug(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m on stale leg (legAge ${legAge.toFixed(1)}s)`);
      return;
    }
    const nowMs = performance.now();
    const lastW = rbLastWarn.get(m.id) ?? -Infinity;
    if (nowMs - lastW < RB_WARN_MS) {
      rbSuppressed.set(m.id, (rbSuppressed.get(m.id) ?? 0) + 1);
      return;
    }
    const sup = rbSuppressed.get(m.id) ?? 0;
    rbLastWarn.set(m.id, nowMs);
    rbSuppressed.delete(m.id);
    logger.warn(
      `ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m (age ${(age * 1000).toFixed(0)}ms) — prediction diverged${sup ? ` (×${sup + 1})` : ''}`,
      rubberbandForensics(deps, b, m));
  }

  function netBallSegment(m: { id: number; kind?: string; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; enraged: boolean; targetId: string | null; t?: number; et?: number; slowT?: number; damp?: boolean; tp?: Vec3Msg | null }): void {
    const b = netBallById.get(m.id);
    if (!b) return;
    // Out-of-order delivery guard: an older stamp would rewind the sim
    // anchor and the next frames would extrapolate a stale leg — that
    // rewind was a live source of the giant rubberband warns.
    if (b.isStaleSegment(m.t)) {
      logger.debug(`ball #${m.id} stale segment dropped (t=${m.t})`);
      return;
    }
    rubberbandCheck(b, m);
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
  function netBallRoster(m: { balls: { id: number; variant: number; colorIdx: number; position: Vec3Msg; velocity: Vec3Msg; t?: number; enraged?: boolean; targetId?: string | null; tp?: Vec3Msg | null }[] }): void {
    const live = new Set<number>();
    for (const b of m.balls) { live.add(b.id); netBallSpawn(b); }
    for (const [id, ball] of netBallById) {
      if (live.has(id)) continue;
      netBallById.delete(id);
      ball.netKill();
    }
  }

  // A netDriven ball pulls toward ITS committed target — resolve the id to
  // a live position (ours or the remote's) each frame.
  function netTargetPosFor(b: Ball): THREE.Vector3 {
    const id = b.netTargetId;
    if (id) {
      const p = targetPosForId(deps, id);
      if (p) return p;
    }
    return b.pos; // no committed target — self pos means zero pull direction
  }

  return { serverBalls, netBallSpawn, netBallSegment,
    netBallDie: (m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }) => netBallDie(deps, netBallById, m),
    netBallRoster, netTargetPosFor };
}
