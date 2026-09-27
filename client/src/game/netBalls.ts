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
  const ballClock = { t: -1, at: 0 };
  function ballEventAge(t: number | undefined): number {
    if (t === undefined) {
      // Unstamped (shouldn't happen post-v3) — fall back to ½RTT.
      return Math.min(0.2, (deps.lazyNetworkManager()?.getPing() ?? 0) / 2000);
    }
    const now = performance.now() / 1000;
    if (t > ballClock.t) { ballClock.t = t; ballClock.at = now; }
    const estNow = ballClock.t + (now - ballClock.at);
    return Math.min(0.6, Math.max(0, estNow - t));
  }

  function targetPosForId(id: string | null | undefined): THREE.Vector3 | null {
    const nm = deps.lazyNetworkManager();
    return id === nm?.getLocalPlayerId() ? deps.lazyPlayer().pos
      : (id ? deps.world.remotePlayers.get(id)?.pos ?? null : null);
  }

  function netBallSpawn(m: { id: number; variant: number; colorIdx: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; t?: number; enraged?: boolean; targetId?: string | null }): void {
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
    // Spawn events are stale on arrival too — fast-forward from the
    // stamped state so the ball materializes where the server already is.
    const age = ballEventAge(m.t);
    if (age > 0.01) {
      ball.applyNetSegment(
        m.position.x, m.position.y, m.position.z,
        m.velocity.x, m.velocity.y, m.velocity.z,
        m.enraged ?? false, m.targetId ?? null,
        age, targetPosForId(m.targetId),
      );
    }
  }

  // Rubberband watch: how far our predicted replay was from the event's
  // truth. >2m = visible warp worth logging; >4m means prediction diverged
  // hard (latency spike or a sim mismatch — that one's a bug, not lag).
  const _segPos = new THREE.Vector3();
  function netBallSegment(m: { id: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; enraged: boolean; targetId: string | null; t?: number; et?: number; slowT?: number; damp?: boolean }): void {
    const b = netBallById.get(m.id);
    if (!b) return;
    _segPos.set(m.position.x, m.position.y, m.position.z);
    // Compare where our prediction is NOW against where the event will
    // have carried truth — i.e. event state advanced by its real age.
    const age = ballEventAge(m.t);
    const expected = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z) * age;
    const err = Math.max(0, _segPos.distanceTo(b.pos) - expected);
    if (err > 4) {
      logger.warn(`ball #${m.id} rubberband ${err.toFixed(1)}m (age ${(age * 1000).toFixed(0)}ms) — prediction diverged`, {
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
    );
  }

  function netBallDie(m: { id: number; position: { x: number; y: number; z: number }; by?: string | null }): void {
    const b = netBallById.get(m.id);
    if (!b) return;
    netBallById.delete(m.id);
    b.netKill();
    sfx.enemyCue(b.pos, 'die');
    screenShake.blast(b.pos, 1.6, deps.lazyPlayer().pos);
    if (m.by && m.by === deps.lazyNetworkManager()?.getLocalPlayerId()) {
      // Our kill: credit + loot locally (server doesn't own nuggets yet)
      deps.lazyPlayer().kills++;
      for (let n = 0; n < Math.round(b.scale); n++) {
        ctx.nuggets.push(new Nugget(scene, b.pos, b.vel));
      }
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
