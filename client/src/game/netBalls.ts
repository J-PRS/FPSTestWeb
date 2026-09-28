import * as THREE from 'three';

import * as sfx from '../core/sfx.js';
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

// ---- Server-owned balls (shared PvE) ---------------------------------
// Connected = the server sims all ball flight; ballSpawn/ballSegment/
// ballDie events drive netDriven Ball instances that replay the shared
// integrator. Offline = the classic local sim (see spawnBall in entities).
export function createNetBalls(deps: EntitiesDeps, ctx: NetBallsCtx, logger: ChildLogger) {
  const { scene, balls, targets } = { scene: deps.scene, ...ctx };
  const netBallById = new Map<number, Ball>();
  const serverBalls = (): boolean => deps.lazyNetworkManager()?.isConnected() ?? false;
  Ball.hitClaim = (netId, dmg, ix, iy, iz) =>
    deps.lazyNetworkManager()?.sendCreatureHit(netId, dmg, ix, iy, iz);

  // Server-sim clock: every ball event is stamped with the server's
  // monotonic sim time. Track the newest stamp + when it arrived to
  // estimate "server now" — event AGE = estNow − stamp measures TRUE
  // staleness including packet loss/retransmit delay, which ping÷2 can't
  // see (at 50% loss, events routinely arrive hundreds of ms late).
  const ballClock = { t: -1, at: 0, rate: 1 };
  // The server's sim clock is setInterval-driven — under load it ticks
  // slower than wall time. Track the sim→wall RATE (Δstamp/Δarrival is
  // an exact rate sample regardless of how events space out) so both the
  // prediction gate and event-age extrapolation ride the server's clock,
  // not ours. Without it we extrapolate legs too far and watch bounces
  // early — the residual rubberband warns.
  function noteStamp(t: number): void {
    const now = performance.now() / 1000;
    if (t > ballClock.t) {
      if (ballClock.t >= 0) {
        const ds = t - ballClock.t, dw = now - ballClock.at;
        if (ds > 0 && dw > 0.2) {
          const r = Math.min(1.2, Math.max(0.5, ds / dw));
          ballClock.rate += (r - ballClock.rate) * 0.2; // EMA
        }
      }
      ballClock.t = t; ballClock.at = now;
    }
  }
  function estSimNow(): number {
    const now = performance.now() / 1000;
    return ballClock.t < 0 ? Infinity : ballClock.t + (now - ballClock.at) * ballClock.rate;
  }
  Ball.netSimNow = estSimNow;
  function ballEventAge(t: number | undefined): number {
    if (t === undefined) {
      // Unstamped (shouldn't happen post-v3) — fall back to ½RTT.
      return Math.min(0.2, (deps.lazyNetworkManager()?.getPing() ?? 0) / 2000);
    }
    noteStamp(t);
    return Math.min(0.6, Math.max(0, estSimNow() - t));
  }

  function targetPosForId(id: string | null | undefined): THREE.Vector3 | null {
    const nm = deps.lazyNetworkManager();
    return id === nm?.getLocalPlayerId() ? deps.lazyPlayer().pos
      : (id ? deps.world.remotePlayers.get(id)?.pos ?? null : null);
  }

  type Vec3Msg = { x: number; y: number; z: number };
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
    ball.applyNetSegment(
      m.position.x, m.position.y, m.position.z,
      m.velocity.x, m.velocity.y, m.velocity.z,
      m.enraged ?? false, m.targetId ?? null,
      ballEventAge(m.t), targetPosForId(m.targetId),
      undefined, m.tp, m.t,
    );
  }

  // Rubberband watch: how far our predicted replay was from the event's
  // truth. >2m = visible warp worth logging; >4m means prediction diverged
  // hard (latency spike or a sim mismatch — that one's a bug, not lag).
  const _segPos = new THREE.Vector3();
  function netBallSegment(m: { id: number; kind?: string; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; enraged: boolean; targetId: string | null; t?: number; et?: number; slowT?: number; damp?: boolean; tp?: Vec3Msg | null }): void {
    const b = netBallById.get(m.id);
    if (!b) return;
    _segPos.set(m.position.x, m.position.y, m.position.z);
    // Compare where our prediction is NOW against where the event will
    // have carried truth — i.e. event state advanced by its real age.
    const age = ballEventAge(m.t);
    const expected = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z) * age;
    const err = Math.max(0, _segPos.distanceTo(b.pos) - expected);
    // Thresholds are per-kind: lunge/teleport are server-side RNG the
    // predictor fundamentally can't foresee (any gap is expected), bounce
    // carries one tick of approach overshoot by construction (~4-5m at
    // terminal speed). Only heartbeat/segment divergence past 4m is a
    // real desync signal — everything else blends via renderOffset.
    const kind = m.kind ?? 'segment';
    const warnAt = kind === 'lunge' || kind === 'teleport' || kind === 'spawn' ? 40
      : kind === 'bounce' || kind === 'stall' ? 12 : 4;
    if (err > warnAt) {
      logger.warn(`ball #${m.id} ${kind} rubberband ${err.toFixed(1)}m (age ${(age * 1000).toFixed(0)}ms) — prediction diverged`, {
        pred: { x: +b.pos.x.toFixed(1), y: +b.pos.y.toFixed(1), z: +b.pos.z.toFixed(1) },
        truth: { x: +m.position.x.toFixed(1), y: +m.position.y.toFixed(1), z: +m.position.z.toFixed(1) },
      });
    } else if (err > 2) {
      logger.debug(`ball #${m.id} segment correction ${err.toFixed(1)}m`);
    }
    b.applyNetSegment(
      m.position.x, m.position.y, m.position.z,
      m.velocity.x, m.velocity.y, m.velocity.z,
      m.enraged, m.targetId,
      age, targetPosForId(m.targetId),
      { et: m.et, slowT: m.slowT, damp: m.damp },
      m.tp, m.t, m.kind === 'teleport' || m.kind === 'spawn',
    );
    // Only real discontinuities are worth a demo keyframe — 'segment'
    // heartbeats would drown the event stream (dozens/sec fleet-wide).
    if (m.kind && m.kind !== 'segment') {
      const dm = deps.lazyDemoManager();
      if (dm?.isRecording) {
        dm.recordTargetBounce(m.id, m.position, m.velocity, b.variant);
      }
    }
  }

  function netBallDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
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

  // A netDriven ball pulls toward ITS committed target — resolve the id to
  // a live position (ours or the remote's) each frame.
  function netTargetPosFor(b: Ball): THREE.Vector3 {
    const id = b.netTargetId;
    if (id) {
      const p = targetPosForId(id);
      if (p) return p;
    }
    return b.pos; // no committed target — self pos means zero pull direction
  }

  return { serverBalls, netBallSpawn, netBallSegment, netBallDie, netTargetPosFor };
}
