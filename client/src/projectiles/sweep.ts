/**
 * sweep.ts — the swept-collision math that used to live inside Projectile.
 * Free functions over a `SweepHost` so the checks are unit-testable without
 * constructing a scene-bound projectile.
 *
 * Wake semantics (see Projectile.ts for the full writeup): the expanding
 * hitRadius only lands when the projectile has passed its closest approach
 * and is moving away — otherwise a stale min-distance would let the wake
 * trigger before the projectile ever reached the core.
 */
import * as THREE from 'three';

import { TERRAIN_HEIGHT_SCALE } from '../core/config.js';
import { getHeightScale,maxHeightInRect } from '../world/heightmap.js';
import { classCapsule } from '../../../shared/botClasses.js';

import { ChildLogger } from '../core/Logger.js';
import type { Targetable } from '../entities/balls.js';
import type { Terrain } from '../world/terrain.js';
import type { ProjectileConfig } from './types.js';
import type { SweepObstacle } from './Projectile.js';

const logger = new ChildLogger('Projectile');

/** The slice of Projectile the sweeps read/write. `hitAt` records the
 *  contact point + interpolation time; the host turns that into hit data. */
export interface SweepHost {
  readonly pos: THREE.Vector3;
  readonly prevPos: THREE.Vector3;
  readonly config: ProjectileConfig;
  readonly canBounce: boolean;
  readonly hitRadius: number;
  readonly hitPoint: THREE.Vector3;
  hitPointValid: boolean;
  minHitDist: number;
  directHit: boolean;
  readonly wakeBallDistances: Map<Targetable, number>;
  readonly wakePlayerDistances: Map<string, number>;
  hitAt(x: number, y: number, z: number, t: number): void;
}

// Swept sphere terrain check: sample along path, then bisect to refine
// the crossing point into hitPoint. The step scales with the effective
// collision offset — a fixed 0.5 step tunnels through the thin
// "surface + offset" band for small-radius projectiles (a 0.05-offset
// chaingun bolt could clear a whole sample between checks).
export function sweepTerrain(p: SweepHost, terrain: Terrain): boolean {
  const dx = p.pos.x - p.prevPos.x;
  const dy = p.pos.y - p.prevPos.y;
  const dz = p.pos.z - p.prevPos.z;
  const dist = (dx * dx + dy * dy + dz * dz) ** 0.5;
  // Bouncers collide on their body radius — a sphere rests ON the
  // dirt, not center-deep in it. Non-bouncers explode on contact so
  // the shallow offset is fine (the ball never visually sits there).
  const offset = Math.max(p.config.terrainOffset,
    p.canBounce ? p.config.bodyRadius : 0);
  // Whole field tops out at TERRAIN_HEIGHT_SCALE × the map's height gain —
  // a segment whose lowest endpoint clears it can never intersect. Skips
  // the ~96-getHeight loop for every high-altitude shell (most mid-flight).
  if (Math.min(p.pos.y, p.prevPos.y) > TERRAIN_HEIGHT_SCALE * getHeightScale() + offset) {return false;}
  // Coarse reject: the tallest heightmap cell under the segment's XZ rect
  // can't be under-reported, so clearing it skips the ~96-sample loop for
  // every shell cruising over low ground (the common case).
  const minY = Math.min(p.pos.y, p.prevPos.y);
  if (minY > maxHeightInRect(p.prevPos.x, p.prevPos.z, p.pos.x, p.pos.z) + offset) {return false;}
  const step = Math.max(0.08, Math.min(0.5, offset));
  const steps = Math.max(1, Math.min(96, Math.ceil(dist / step)));
  const below = (t: number): boolean => {
    const sx = p.prevPos.x + dx * t;
    const sy = p.prevPos.y + dy * t;
    const sz = p.prevPos.z + dz * t;
    return sy <= terrain.getHeight(sx, sz) + offset;
  };
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (below(t)) {
      // Bisect between last above-ground sample and this one
      let lo = Math.max(0, (i - 1) / steps), hi = t;
      for (let k = 0; k < 5; k += 1) {
        const mid = (lo + hi) / 2;
        if (below(mid)) {hi = mid;} else {lo = mid;}
      }
      p.hitPoint.set(
        p.prevPos.x + dx * hi,
        p.prevPos.y + dy * hi,
        p.prevPos.z + dz * hi
      );
      p.hitPointValid = true;
      return true;
    }
  }
  return false;
}

/** Sphere-reject gate: can the swept segment come within `reach` of the
 *  target's closest point? Compared against the segment's midpoint —
 *  misses only when the target is provably outside, so no hit is ever
 *  skipped that the full check would have caught. */
function segmentSphereReject(p: SweepHost, cx: number, cy: number, cz: number, reach: number): boolean {
  const midX = (p.pos.x + p.prevPos.x) / 2;
  const midY = (p.pos.y + p.prevPos.y) / 2;
  const midZ = (p.pos.z + p.prevPos.z) / 2;
  const halfLen = p.pos.distanceTo(p.prevPos) / 2;
  const dx = cx - midX, dy = cy - midY, dz = cz - midZ;
  const margin = reach + halfLen;
  return dx * dx + dy * dy + dz * dz > margin * margin;
}

// Distance vector from a sample point to the target's closest point.
// Capsule targets: distance to a segment, not a point.
//  capsuleTop (Totem) — vertical, feet to feet+height
//  capsuleEnd (Overlord) — centered, pos ± heading-aligned half-extent
const _delta = new THREE.Vector3();
function targetDelta(ball: Targetable, sx: number, sy: number, sz: number): THREE.Vector3 {
  const o = _delta;
  if (ball.capsuleEnd) {
    const e = ball.capsuleEnd;
    const eLen2 = e.lengthSq() || 1;
    const proj = Math.max(-1, Math.min(1,
      ((sx - ball.pos.x) * e.x + (sy - ball.pos.y) * e.y + (sz - ball.pos.z) * e.z) / eLen2));
    return o.set(sx - (ball.pos.x + e.x * proj), sy - (ball.pos.y + e.y * proj), sz - (ball.pos.z + e.z * proj));
  }
  const capTop = ball.capsuleTop ? ball.pos.y + ball.capsuleTop : ball.pos.y;
  const cy = Math.max(ball.pos.y, Math.min(capTop, sy));
  return o.set(sx - ball.pos.x, sy - cy, sz - ball.pos.z);
}

// Swept sphere vs ball — checks core (direct) then expanding (wake) hitbox
export function sweepBall(p: SweepHost, ball: Targetable): boolean {
  const STEP = 0.1; // smaller step for precise core hit detection
  const tr = ball.hitRadius ?? ball.radius; // render ≠ hitbox on tapered bodies (totem)
  // Capsule targets extend past pos (capsuleTop up, capsuleEnd along the
  // heading) — the reject must cover the farthest reach point or it lies.
  const capsuleExt = Math.max(ball.capsuleTop ?? 0, ball.capsuleEnd ? ball.capsuleEnd.length() : 0);
  if (segmentSphereReject(p, ball.pos.x, ball.pos.y, ball.pos.z, tr + p.hitRadius + capsuleExt + 0.5)) {return false;}
  const dx = p.pos.x - p.prevPos.x;
  const dy = p.pos.y - p.prevPos.y;
  const dz = p.pos.z - p.prevPos.z;
  const dist = (dx * dx + dy * dy + dz * dz) ** 0.5;
  const steps = Math.max(1, Math.ceil(dist / STEP));
  const coreThresh = tr + p.config.bodyRadius; // direct hit = body overlaps target
  const wakeThresh = tr + p.hitRadius; // expanding wake
  let minDist = Infinity;
  let prevD2 = Infinity;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const sx = p.prevPos.x + dx * t;
    const sy = p.prevPos.y + dy * t;
    const sz = p.prevPos.z + dz * t;
    const e = targetDelta(ball, sx, sy, sz);
    const d2 = e.x * e.x + e.y * e.y + e.z * e.z;
    const d = (d2) ** 0.5;
    if (d < minDist) {minDist = d;}

    // Passed center when distance increases from the previous step
    const passedCenter = i > 0 && d2 > prevD2;

    // Direct hit - immediate
    if (d2 <= coreThresh * coreThresh) {
      p.minHitDist = minDist;
      p.directHit = true;
      p.hitAt(sx, sy, sz, t);
      return true;
    }

    // Wake hit - track distance, only trigger when passed center and moving away
    if (d2 <= wakeThresh * wakeThresh) {
      const prevMin = p.wakeBallDistances.get(ball) ?? Infinity;
      if (d < prevMin) {
        p.wakeBallDistances.set(ball, d);
      } else if (d > prevMin && passedCenter) {
        // Only trigger wake hit if we've passed the center (distance increasing after minimum)
        p.minHitDist = minDist;
        p.directHit = false;
        p.hitAt(sx, sy, sz, t);
        return true;
      }
    }

    prevD2 = d2;
  }

  return false;
}

// True continuous sphere sweep vs player capsule
// playerPos is the networked EYE position (feet + eyeHeight per class);
// capsule center sits centerOff below it.
export function sweepPlayer(p: SweepHost, playerPos: THREE.Vector3, playerId: string, cls?: string): boolean {
  const cap = classCapsule(cls);
  const centerY = playerPos.y + cap.centerOff;
  const capHalf = cap.half;
  const capRadius = cap.radius;
  // Same sphere reject; capsule half-height inflates the reach so a
  // head/foot catch can't slip past the midpoint estimate.
  if (segmentSphereReject(p, playerPos.x, centerY, playerPos.z, capRadius + capHalf + p.hitRadius + 0.5)) {return false;}

  const dx = p.pos.x - p.prevPos.x;
  const dy = p.pos.y - p.prevPos.y;
  const dz = p.pos.z - p.prevPos.z;
  const pathLenSq = dx * dx + dy * dy + dz * dz;

  if (pathLenSq === 0) {
    const hx = p.pos.x - playerPos.x;
    const hz = p.pos.z - playerPos.z;
    const vy = p.pos.y - centerY;
    const clampedY = Math.max(-capHalf, Math.min(capHalf, vy));
    const yDelta = vy - clampedY;
    const totalDist = (hx * hx + yDelta * yDelta + hz * hz) ** 0.5;

    const directThresh = capRadius + p.config.bodyRadius;
    if (totalDist <= capRadius + p.hitRadius) {
      p.minHitDist = totalDist;
      p.directHit = totalDist <= directThresh;
      p.hitAt(p.pos.x, p.pos.y, p.pos.z, 1);
      return true;
    }
    return false;
  }

  const px = playerPos.x - p.prevPos.x;
  const py = centerY - p.prevPos.y;
  const pz = playerPos.z - p.prevPos.z;
  const t = (px * dx + py * dy + pz * dz) / pathLenSq;
  const tClamped = Math.max(0, Math.min(1, t));

  const closestX = p.prevPos.x + dx * tClamped;
  const closestY = p.prevPos.y + dy * tClamped;
  const closestZ = p.prevPos.z + dz * tClamped;

  const vx = closestX - playerPos.x;
  const vy = closestY - centerY;
  const vz = closestZ - playerPos.z;

  const clampedY = Math.max(-capHalf, Math.min(capHalf, vy));
  const yDelta = vy - clampedY;

  const totalDist = (vx * vx + yDelta * yDelta + vz * vz) ** 0.5;

  const directThresh = capRadius + p.config.bodyRadius;
  if (totalDist <= capRadius + p.hitRadius) {
    p.minHitDist = totalDist;

    if (totalDist <= directThresh) {
      p.directHit = true;
      p.hitAt(closestX, closestY, closestZ, tClamped);
      return true;
    }

    // Only consider wake hit if we've passed the closest point on the path
    const passedCenter = t <= 1;
    const prevMin = p.wakePlayerDistances.get(playerId) ?? Infinity;
    if (totalDist < prevMin) {
      p.wakePlayerDistances.set(playerId, totalDist);
      return false;
    } else if (totalDist > prevMin && passedCenter) {
      p.directHit = false;
      logger.debug(`Wake hit at dist ${totalDist.toFixed(2)}, threshold ${(capRadius + p.hitRadius).toFixed(2)}`);
      p.hitAt(closestX, closestY, closestZ, tClamped);
      return true;
    }
  }

  return false;
}

// Swept hit vs a moving obstacle — segment-vs-segment closest approach.
// Both objects moved this frame, so the check runs in the projectile's
// relative frame: R(t) = (P0 − B0) + (dP − dB)·t, minimize |R|² on [0,1].
// No sampling steps — the closest-approach time is solved exactly.
export function sweepObstacle(p: SweepHost, o: SweepObstacle): boolean {
  // Obstacle also moved — reject on its current midpoint vs the shell's
  // segment; its frame displacement is tiny next to the +0.5 slack.
  if (segmentSphereReject(p, o.pos.x, o.pos.y, o.pos.z, p.config.bodyRadius + o.radius + 0.5)) {return false;}
  const dx = p.pos.x - p.prevPos.x;
  const dy = p.pos.y - p.prevPos.y;
  const dz = p.pos.z - p.prevPos.z;
  const ax = p.prevPos.x - o.prevPos.x;
  const ay = p.prevPos.y - o.prevPos.y;
  const az = p.prevPos.z - o.prevPos.z;
  const rx = dx - (o.pos.x - o.prevPos.x);
  const ry = dy - (o.pos.y - o.prevPos.y);
  const rz = dz - (o.pos.z - o.prevPos.z);
  const bb = rx * rx + ry * ry + rz * rz;
  let t = bb > 1e-8 ? -(ax * rx + ay * ry + az * rz) / bb : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + rx * t, cy = ay + ry * t, cz = az + rz * t;
  const d2 = cx * cx + cy * cy + cz * cz;
  const thresh = p.config.bodyRadius + o.radius;
  if (d2 > thresh * thresh) {return false;}
  p.minHitDist = (d2) ** 0.5;
  p.directHit = true;
  p.hitAt(
    p.prevPos.x + dx * t,
    p.prevPos.y + dy * t,
    p.prevPos.z + dz * t,
    t,
  );
  return true;
}
