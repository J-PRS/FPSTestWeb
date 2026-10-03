import * as THREE from 'three';
import { getSwarm, freeSlots } from './swarms.js';
import { GRAVITY } from '../core/config.js';
// Type-only back-import — Ball calls into these helpers per tick, so a
// value import would make the pair a runtime cycle. viewPos comes in as
// a param instead of reaching into Ball's statics.
import type { Ball } from './balls.js';

// Ball visual family — instance write + render-position blend + trail
// lifecycle + dead fade-out. The Ball class is the host; these take it
// flat (same pattern as ballRage / ballNet helpers).
const BALL_GRAVITY = GRAVITY;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _enrageTint = new THREE.Color(1, 0.12, 0.08);

  // Ball body → swarm slot; instanceColor = hue + emissive glow.
export function writeBallInstance(b: Ball): void {
    if (b.meshRemoved || b.swarmSlot < 0) return;
    const swarm = getSwarm('ball');
    if (!swarm) return;
    b._rpos.copy(b.pos).add(b.renderOffset);
    _m.compose(b._rpos, _q.identity(), _s.setScalar(b.scale));
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
    const sim = b.netS.sim;
    if (!(b.netDriven && sim && sim.enraged && sim.tgtValid)) return;
    const rem = b.netS.netAcc;
    if (rem <= 0) return;
    b._rpos.x += b.vel.x * rem;
    b._rpos.y += b.vel.y * rem + 0.5 * BALL_GRAVITY * rem * rem;
    b._rpos.z += b.vel.z * rem;
  }

export function tickBallTrails(b: Ball, dt: number, viewPos: THREE.Vector3): void {
    // Far balls: skip sparkle emission — a 0.5m dot trail is sub-pixel past
    // ~200m but each emit still churns the dot list. Aging keeps running
    // so a ball arcing back into range doesn't pop stale sparkles.
    const nearCam = b._rpos.distanceToSquared(viewPos) < 200 * 200;
    // Net corrections sweep _rpos smoothly over ~0.2s via renderOffset
    // decay — that sweep isn't flight, and depositing dots/ribbon samples
    // along it lays a dotted line across the map (the per-frame step is
    // under every jump threshold, so guards never see it). While the
    // correction dominates real travel, emit nothing.
    const travel = Math.max(1e-4, Math.sqrt(b.vel.lengthSq()) * dt);
    const correcting = b._rpos.distanceTo(b._lastTrailPos) > Math.max(6, travel * 4);
    if (nearCam && !correcting) {
      b.trails.emit(dt, b._rpos, b.vel, b.radius, b.enraged ? _enrageTint : b.color);
    }
    b.trails.fade(dt);
    // Position discontinuity (teleport, playback keyframe snap, or an
    // active correction sweep) — cut the ribbons so they don't streak
    // across the jump
    if (correcting || b._rpos.distanceToSquared(b._lastTrailPos) > 400) {
      for (const r of b.ribbons) r.clear();
    }
    b._lastTrailPos.copy(b._rpos);
    if (!correcting && b.vel.lengthSq() > 0.5) {
      for (const r of b.ribbons) r.push(b._rpos, b.vel);
    }
    for (const r of b.ribbons) r.update(dt, viewPos);
  }

  // Dead ball: swarm slot freed, just fade out remaining trail dots/ribbons
export function updateBallDead(b: Ball, dt: number, viewPos: THREE.Vector3): void {
    if (!b.meshRemoved) {
      for (const r of b.ribbons) r.stop();
      freeSlots('ball', b);
      b.meshRemoved = true;
    }
    b.trails.fade(dt);
    for (const r of b.ribbons) r.update(dt, viewPos);
    if (b.trails.size === 0 && b.ribbons.every(r => r.done)) {
      // Final cleanup — caller splices on `disposed` without dispose(),
      // so dispose() is invoked here only to leave Ball.live.
      b.trails.dispose();
      for (const r of b.ribbons) r.dispose();
      b._disposed = true;
      b.dispose();
    }
  }

