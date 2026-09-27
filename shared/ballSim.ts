/**
 * ballSim — the deterministic flight core of entities/balls.ts, ported to
 * plain numbers (no THREE) so the SERVER runs the same sim the client runs.
 *
 * Both sides step the identical integrator against the identical heightfield
 * (shared/heightfield.ts), so between events a client's replay matches the
 * server to within float noise — the wire only needs to carry SEGMENT
 * events: every velocity discontinuity (bounce / lunge / enrage launch /
 * teleport / spawn / knockback) is one `ballSegment` broadcast and replay
 * converges instantly. Apex needs no event — it's implied by vy+g·t=0.
 *
 * `authoritative`: RNG-bearing branches (teleport angle) only fire on the
 * authority. A predicting client lets the ball keep flying — the next real
 * segment event corrects it anyway.
 */

import { type Heightfield, hmHeight, hmNormal } from './heightfield.js';

export const BALL_GRAVITY = -28.0;          // = client GRAVITY
export const BALL_BOUNCE = 1.0;             // elastic reflection
export const BALL_BASE_RADIUS = 1.2;
export const BALL_MAX_DIST = 300.0;
export const BALL_TELE_MIN = 60.0;
export const BALL_TELE_MAX = 120.0;
export const BALL_TELE_HEIGHT = 25.0;
export const BALL_ENRAGE_FORCE = 12.0;
export const BALL_ENRAGE_TIMEOUT = 20.0;
export const BALL_ENRAGE_DASH_DIST = 100.0;
export const BALL_ENRAGE_DASH_SPEED = 45.0;
// Overspeed guard: knockback impulses + slope chains can stack a ball past
// readable speeds — above this, the next bounce deadens to 50% elasticity
// instead of conserving energy (same thud as the post-dash damp).
export const BALL_OVERSPEED = 100.0;
// Stall breaker: a ball loitering under MIN_SPEED for STALL_TIME gets a
// free spring launch at its committed target — it already owns this skill
// (the enrage launch), this just fires it on boredom instead of distance.
export const BALL_MIN_SPEED = 5.0;
export const BALL_STALL_TIME = 2.0;

export type BallVariant = 0 | 1 | 2 | 3;

export const BALL_VARIANT_SCALE = [1.0, 2.0, 3.0, 2.4] as const;
export const BALL_VARIANT_HEALTH = [30, 70, 130, 350] as const;

export interface SimVec { x: number; y: number; z: number }

export interface SimBall {
  id: number;
  variant: BallVariant;
  colorIdx: number;           // variant 0 picks from BALL_COLORS — server decides, wire carries it
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  scale: number;
  radius: number;
  health: number;
  maxHealth: number;
  enraged: boolean;
  enrageTimer: number;
  slowTimer: number;           // seconds spent under BALL_MIN_SPEED
  dampNextBounce: boolean;
  dead: boolean;
  /** The player it's raging/lunging at — travels on segment events so a
   *  replay applies the same pull toward the same target's live pos. */
  targetId: string | null;
}

const _n: SimVec = { x: 0, y: 0, z: 0 };

export function makeSimBall(id: number, variant: BallVariant, colorIdx: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): SimBall {
  const scale = BALL_VARIANT_SCALE[variant];
  const health = BALL_VARIANT_HEALTH[variant];
  return {
    id, variant, colorIdx,
    x, y, z, vx, vy, vz,
    scale, radius: BALL_BASE_RADIUS * scale,
    health, maxHealth: health,
    enraged: false, enrageTimer: 0, slowTimer: 0, dampNextBounce: false,
    dead: false, targetId: null,
  };
}

export type SegmentKind = 'bounce' | 'lunge' | 'enrage' | 'stall' | 'teleport' | 'spawn' | 'knockback' | 'hit';

/** One integration step. `target` = the ball's committed player's position
 *  (null when nobody alive to chase). Returns the segment kind if this step
 *  produced a discontinuity the authority should broadcast. */
export function stepBall(
  b: SimBall,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): SegmentKind | null {
  b.vy += BALL_GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  // Enrage pull: linear accel toward the committed target (still ballistic-
  // flavored — it arcs and bounces rather than homing).
  if (b.enraged && target) {
    b.enrageTimer += dt;
    let dx = target.x - b.x;
    let dy = target.y + b.radius - b.y;
    let dz = target.z - b.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 0.001) {
      const f = BALL_ENRAGE_FORCE * dt / d;
      b.vx += dx * f;
      b.vy += dy * f;
      b.vz += dz * f;
    }
    if (b.enrageTimer > BALL_ENRAGE_TIMEOUT) {
      b.enraged = false;
      if (authoritative) return teleportNearTarget(b, field, target);
      return null; // predictor: let it fly, the event will snap it
    }
  }

  // Stall breaker — RNG-free, so predictors run it too and land the same
  // spring the server commits to. Fires BEFORE the bounce check so a ball
  // resting on the ground (the common stall) launches immediately.
  {
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    b.slowTimer = sp < BALL_MIN_SPEED ? b.slowTimer + dt : 0;
    if (b.slowTimer >= BALL_STALL_TIME && target) {
      b.slowTimer = 0;
      launchAt(b, target, Math.SQRT1_2);
      return 'stall';
    }
  }

  // Ground contact → reflect. Mirrors handleGroundBounce: only a bounce
  // while moving INTO the surface counts.
  const gy = hmHeight(field, b.x, b.z);
  if (b.y - b.radius > gy) return null;
  b.y = gy + b.radius;
  hmNormal(field, b.x, b.z, _n);
  const dot = b.vx * _n.x + b.vy * _n.y + b.vz * _n.z;
  if (dot >= 0) return null;

  if (b.enraged && target) {
    const pdx = target.x - b.x;
    const pdz = target.z - b.z;
    if (pdx * pdx + pdz * pdz <= BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {
      dashAt(b, target);
      b.enraged = false;
      b.dampNextBounce = true;
      return 'lunge';
    }
  }

  // Post-dash landing OR an overspeed impact: reflect at 50% elasticity so
  // the segment ends with a thud, not a full-energy ricochet into orbit.
  const impactSpeed = Math.hypot(b.vx, b.vy, b.vz);
  const elasticity = (b.dampNextBounce || impactSpeed > BALL_OVERSPEED) ? 0.5 : BALL_BOUNCE;
  b.dampNextBounce = false;
  const k = -(1.0 + elasticity) * dot;
  b.vx += _n.x * k;
  b.vy += _n.y * k;
  b.vz += _n.z * k;

  // Drift check: too far from the committed target → enrage spring (the
  // authority decides; the predictor sees it on the segment event anyway).
  if (target) {
    const dx = b.x - target.x;
    const dz = b.z - target.z;
    if (dx * dx + dz * dz > BALL_MAX_DIST * BALL_MAX_DIST) {
      if (authoritative) {
        b.enraged = true;
        b.enrageTimer = 0;
        launchAt(b, target, Math.SQRT1_2);
        return 'enrage';
      }
    }
  }
  return 'bounce';
}

function launchAt(b: SimBall, target: SimVec, upFrac: number): void {
  const pdx = target.x - b.x;
  const pdz = target.z - b.z;
  const pd = Math.sqrt(pdx * pdx + pdz * pdz) || 0.001;
  const speed = Math.max(Math.hypot(b.vx, b.vy, b.vz), BALL_ENRAGE_DASH_SPEED * 0.5);
  const h = Math.sqrt(1 - upFrac * upFrac);
  b.vx = (pdx / pd) * speed * h;
  b.vz = (pdz / pd) * speed * h;
  b.vy = Math.max(speed * upFrac, (target.y - b.y) * 0.8);
}

function dashAt(b: SimBall, target: SimVec): void {
  const pdx = target.x - b.x;
  const pdz = target.z - b.z;
  const pd = Math.sqrt(pdx * pdx + pdz * pdz) || 0.001;
  const hSpeed = Math.max(Math.hypot(b.vx, b.vz), BALL_ENRAGE_DASH_SPEED * 0.5);
  const t = Math.max(0.15, pd / hSpeed);
  const vy = (target.y - b.y + 0.5 * Math.abs(BALL_GRAVITY) * t * t) / t;
  b.vx = (pdx / pd) * hSpeed;
  b.vz = (pdz / pd) * hSpeed;
  b.vy = vy;
}

function teleportNearTarget(b: SimBall, field: Heightfield, target: SimVec): SegmentKind {
  const ang = Math.random() * Math.PI * 2;
  const dist = BALL_TELE_MIN + Math.random() * (BALL_TELE_MAX - BALL_TELE_MIN);
  b.x = target.x + Math.cos(ang) * dist;
  b.z = target.z + Math.sin(ang) * dist;
  b.y = hmHeight(field, b.x, b.z) + BALL_TELE_HEIGHT;
  const speed = Math.hypot(b.vx, b.vy, b.vz) || 1;
  hmNormal(field, b.x, b.z, _n);
  const dot = b.vx * _n.x + b.vy * _n.y + b.vz * _n.z;
  const k = -2.0 * dot * BALL_BOUNCE;
  b.vx += _n.x * k;
  b.vy += _n.y * k;
  b.vz += _n.z * k;
  const m = Math.hypot(b.vx, b.vy, b.vz) || 1;
  const s = speed / m;
  b.vx *= s; b.vy *= s; b.vz *= s;
  return 'teleport';
}

/** Server-side hit claim result. `impulse` mirrors Ball.applyKnockback —
 * a hit shoves the ball (the whole point of the damage model) so the claim
 * carries the same push and the segment event propagates it. */
export function applySimDamage(b: SimBall, damage: number, impX: number, impY: number, impZ: number): boolean {
  b.health -= damage;
  b.vx += impX;
  b.vy += impY;
  b.vz += impZ;
  return b.health <= 0;
}
