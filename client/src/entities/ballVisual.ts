import * as THREE from 'three';
import { getSwarm, freeSlots } from './swarms.js';
import { GRAVITY } from '../core/config.js';
import { TrailDriver } from '../effects/vfxRuntime.js';
import { glitch } from '../core/fxDiag.js';
// Type-only back-import — Ball calls into these helpers per tick, so a
// value import would make the pair a runtime cycle. viewPos comes in as
// a param instead of reaching into Ball's statics.
import type { Ball } from './balls.js';

// Ball visual family — instance write + render-position blend + trail
// lifecycle + dead fade-out. The Ball class is the host; these take it
// flat (same pattern as ballRage / ballNet helpers).
const BALL_GRAVITY = GRAVITY;
// Spring-in on birth/teleport — the body scales 0→1 with a small
// overshoot over ~0.2s so appearances read as eruptions, not pop-ins.
export const SPAWN_POP_S = 0.22;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _enrageTint = new THREE.Color(1, 0.12, 0.08);

  // Ball body → swarm slot; instanceColor = hue + emissive glow.
export function writeBallInstance(b: Ball): void {
    if (b.meshRemoved || b.swarmSlot < 0) {return;}
    const swarm = getSwarm('ball');
    if (!swarm) {return;}
    b._rpos.copy(b.pos).add(b.renderOffset);
    const u = 1 - b.spawnPopT / SPAWN_POP_S - 1; // t-1 for the back-out ease
    const pop = b.spawnPopT <= 0 ? 1 : 1 + 2.70158 * u * u * u + 1.70158 * u * u;
    _m.compose(b._rpos, _q.identity(), _s.setScalar(Math.max(0.05, b.scale * pop)));
    swarm.setMatrix(0, b.swarmSlot, _m);
    if (b.flashTimer > 0) {
      swarm.setColor(0, b.swarmSlot, 4, 4, 4);
    } else {
      _c.copy(b.color).add(b.emissive);
      swarm.setColor(0, b.swarmSlot, _c.r, _c.g, _c.b);
    }
  }

  // Render position = sim pos + decaying correction offset; enraged legs
  // additionally extrapolate over the sub-50ms remainder so the ball
  // doesn't step at ~20fps. (Inert legs already integrate continuously.)
export function tickBallRenderPos(b: Ball, dt: number): void {
    // Segment corrections drain back to zero — exp decay, ~0.2s time constant.
    if (b.renderOffset.lengthSq() > 0.0001) {
      b.renderOffset.multiplyScalar(Math.exp(-dt * 10));
    } else {
      b.renderOffset.set(0, 0, 0);
    }
    b._rpos.copy(b.pos).add(b.renderOffset);
    const {sim} = b.netS;
    if (!(b.netDriven && sim && sim.enraged && sim.tgtValid)) {return;}
    const rem = b.netS.netAcc;
    if (rem <= 0) {return;}
    b._rpos.x += b.vel.x * rem;
    b._rpos.y += b.vel.y * rem + 0.5 * BALL_GRAVITY * rem * rem;
    b._rpos.z += b.vel.z * rem;
  }

export function tickBallTrails(b: Ball, dt: number, viewPos: THREE.Vector3): void {
    // Emission rides the runtime TrailDriver like every other trail pack:
    // it detects the renderOffset correction sweep (host maxStep policy —
    // the same >max(6, travel×4) predicate this used to hand-roll) and
    // cuts ribbons + suppresses that frame's deposit in ONE place.
    // Far balls: skip sparkle emission — a 0.5m dot trail is sub-pixel past
    // ~200m but each emit still churns the dot list.
    b._trailNear = b._rpos.distanceToSquared(viewPos) < 200 * 200;
    b._trailDt = dt;
    if (!b.trailDriver) {
      b.trailDriver = new TrailDriver(
        {
          pos: b._rpos, vel: b.vel,
          // Dead balls fade only — updateBallDead emits nothing. The 200m
          // cull lives on the DOT emitter only: gating the whole emit
          // here starved ribbons too, so every ball past 200m flew
          // trail-less ("missing trails").
          emitting: (): boolean => !b.dead && b.renderOffset.lengthSq() <= 400,
          ribbonEmitting: (): boolean => !b.dead && b.vel.lengthSq() > 0.5 && b.renderOffset.lengthSq() <= 400,
          emitOnJump: false,
          maxStep: (d): number => Math.max(6, Math.max(1e-4, Math.sqrt(b.vel.lengthSq()) * d) * 4),
        },
        [{
          emitSegment: (): void => { if (b._trailNear) { b.trails.emit(b._trailDt, b._rpos, b.vel, b.radius, b.enraged ? _enrageTint : b.color); } },
          teleport: (): void => { /* dot deposits die fast — suppression is the cut */ },
        }],
        b.ribbons,
      );
    }
    // A segment correction blends through renderOffset over ~0.5s — the
    // render pos sweeps tens of meters and every follower (ribbon, dots)
    // paints the sweep as a chord. Retire the ribbons while a big blend
    // is in flight; fresh ones restart from the corrected arc when it lands.
    const offSq = b.renderOffset.lengthSq();
    if (offSq > 400) {
      if (!b._blendCut) {
        b._blendCut = true;
        // offM alone can't tell a sim-clock lag (correction ≈ speed×skew,
        // periodic at segment cadence) from an integrator mismatch
        // (bounce/field resolving differently — irregular). skew names it.
        // First-seg fold is the join/roster heal — a fresh replica
        // converging onto mid-flight truth, not a correction.
        if ((b.netS.segsSeen ?? 0) > 1) {
          const skew = b.netS.lastSimNow >= 0 ? Math.round((b.netS.simT - b.netS.lastSimNow) * 1000) : 0;
          glitch('render-blend', { netId: b.netId ?? -1, offM: Math.round(Math.sqrt(offSq)), skewMs: skew });
        }
        // Retire, not clear — the old tails FADE OUT where they were.
        b.retireRibbons();
      }
    } else {
      b._blendCut = false;
    }
    b.trails.fade(dt);
    for (const r of b.ribbons) {r.update(dt, viewPos);}
  }

  // Dead ball: swarm slot freed, just fade out remaining trail dots/ribbons
export function updateBallDead(b: Ball, dt: number, viewPos: THREE.Vector3): void {
    if (!b.meshRemoved) {
      for (const r of b.ribbons) {r.stop();}
      freeSlots('ball', b);
      b.meshRemoved = true;
    }
    b.trails.fade(dt);
    for (const r of b.ribbons) {r.update(dt, viewPos);}
    if (b.trails.size === 0 && b.ribbons.every(r => r.done)) {
      // Final cleanup — caller splices on `disposed` without dispose(),
      // so dispose() is invoked here only to leave Ball.live.
      b.trails.dispose();
      for (const r of b.ribbons) {r.dispose();}
      b._disposed = true;
      b.dispose();
    }
  }

