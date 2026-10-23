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
import { dcos, dhypot2, dhypot3, dsin } from './dmath.ts';
import { botRand } from './botRand.js';
import { collideStructures, BALL_BOUNCE, type StructureCollider } from './ballCollide.js';
import { GRAVITY } from './movement.js';
export { structureColliders, BALL_BOUNCE, type StructureCollider } from './ballCollide.js';

export const BALL_GRAVITY = GRAVITY;
export const BALL_BASE_RADIUS = 1.2;
// Recall happens at the fog wall (~400m) — 200m yanked them back while
// still plainly visible, so the pop-out read as a glitch instead of a
// far-off disappearance.
export const BALL_MAX_DIST = 300;
// Re-arrival band sits near the edge of readability, not point-blank —
// 40-80m put the spring-in right in the player's face; 130-185 stays
// inside the 200m leash (with overshoot margin) but reads as "that ball
// was always out there", not a pop-in.
export const BALL_TELE_MIN = 130;
export const BALL_TELE_MAX = 185;
// Surface drop, not airlift: ball radius + margin, so even the big
// variants land just above contact instead of spawning clipped into
// the collider (a buried spawn can reflect a garbage velocity).
export const BALL_TELE_MARGIN = 0.3;
export const BALL_ENRAGE_FORCE = 12;
export const BALL_ENRAGE_TIMEOUT = 20;
export const BALL_ENRAGE_DASH_DIST = 100;
export const BALL_ENRAGE_DASH_SPEED = 45;
// Overspeed guard: knockback impulses + slope chains can stack a ball past
// readable speeds — above this, the next bounce deadens to 50% elasticity
// instead of conserving energy (same thud as the post-dash damp).
export const BALL_OVERSPEED = 100;
// Absolute speed ceiling — impulses and launches stack additively, so
// without a clamp sustained fire turns an enrage launch into an orbital
// insertion (observed: a ball parked at ~9km altitude for minutes).
export const BALL_MAX_SPEED = 140;
// Settle threshold: an impact slower than this doesn't reflect, it just
// rests on the terrain — no segment. Without it a settled ball keeps
// micro-bouncing every tick (elastic reflection never dies at low speed),
// spamming ~20 bounce events/s per ball and visibly jittering on clients.
export const BALL_REST_SPEED = 6;
// Stall breaker: a ball loitering under MIN_SPEED for STALL_TIME gets a
// free spring launch at its committed target — it already owns this skill
// (the enrage launch), this just fires it on boredom instead of distance.
export const BALL_MIN_SPEED = 5;
export const BALL_STALL_TIME = 2;
// Dead-contact threshold — PhysX's bounceThresholdVelocity (~0.2*gravity).
// A contact whose NORMAL approach speed |v·n| is below this is a
// zero-restitution slide: the inward normal velocity is cancelled and the
// tangential rides on, instead of reflecting a feeble kick. Elastic
// reflection at grazing incidence is the micro-skip storm — PhysX never
// had it because it never reflected sub-threshold contacts.
export const BALL_SLIDE_VN_MIN = 6;
export let BALL_SLIDE_ENABLED = true;
export function setBallSlide(on: boolean): void { BALL_SLIDE_ENABLED = on; }
// Classic mode (?mode=classic): far balls teleport home instead of
// enraging — the OG pure bounce-and-shoot ruleset. Same flag story as
// setBallSlide: the sim reads it, config.ts re-exports it.
export let BALL_ENRAGE_ENABLED = true;
export function setBallEnrage(on: boolean): void { BALL_ENRAGE_ENABLED = on; }

export type BallVariant = 0 | 1 | 2 | 3;

export const BALL_VARIANT_SCALE = [1, 2, 3, 2.4] as const;
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
   *  replay applies the same pull toward the same target. */
  targetId: string | null;
  /** Target position SNAPSHOT — set when a segment is emitted and carried
   *  on the wire (tp). Both sims must pull toward the SAME point: if the
   *  authority aims at its stale player pos while a predictor aims at the
   *  live pos, the two arcs diverge ~100m per segment. */
  tx: number; ty: number; tz: number;
  tgtValid: boolean;
  /** Terrain-probe scheduler: a ballistic ball's time-to-ground is
   *  closed-form, so instead of probing the heightfield every tick each
   *  ball carries a countdown — resample when it hits zero, when the
   *  ball drifts ~2m horizontally (new terrain beneath it), or when it
   *  reaches the last sampled ground plane. Velocity discontinuities
   *  (bounce/launch/knockback) reset it — the prediction is stale by
   *  definition there. Deterministic: both sides sample the identical
   *  field at identical (x,z), so probes land on the same ticks. */
  gt: number;    // sim-seconds until the next scheduled terrain probe
  ggy: number;   // last sampled ground height under the ball
  gx: number;    // position at that sample — drift trigger
  gz: number;
  /** Pre-teleport position — a creatureHit claim in flight when the leash
   *  fired is honestly stale, so the range check accepts either site. */
  px: number; py: number; pz: number; pset: boolean;
}

const _n: SimVec = { x: 0, y: 0, z: 0 };

export function makeSimBall(id: number, variant: BallVariant, colorIdx: number, pos: SimVec, vel: SimVec): SimBall {
  const { x, y, z } = pos;
  const scale = BALL_VARIANT_SCALE[variant];
  const health = BALL_VARIANT_HEALTH[variant];
  return {
    id, variant, colorIdx,
    x, y, z, vx: vel.x, vy: vel.y, vz: vel.z,
    scale, radius: BALL_BASE_RADIUS * scale,
    health, maxHealth: health,
    enraged: false, enrageTimer: 0, slowTimer: 0, dampNextBounce: false,
    dead: false, targetId: null,
    tx: 0, ty: 0, tz: 0, tgtValid: false,
    gt: 0, ggy: -Infinity, gx: x, gz: z,
    px: x, py: y, pz: z, pset: false };
}

export type SegmentKind = 'bounce' | 'lunge' | 'enrage' | 'stall' | 'teleport' | 'spawn' | 'knockback' | 'hit' | 'segment';

/** One integration step. `target` = the ball's committed player's position
 *  (null when nobody alive to chase). `colliders` = static map structures
 *  the ball can ricochet off — the server passes the room's spec and the
 *  client predictor passes the same list from gameState, so the bounce is
 *  identical on both sides. Returns the segment kind if this step produced
 *  a discontinuity the authority should broadcast. */
export interface StepWorld {
  colliders?: readonly StructureCollider[];
  colliderIndex?: { queryPoint(x: number, z: number, pad: number, out: StructureCollider[]): void };
  /** Seeded roll for the authoritative-only teleport branch — without it
   *  the sim takes Math.random, which scenario seeds can't reproduce. */
  rand?: () => number;
}

function launchAt(b: SimBall, target: SimVec, upFrac: number): void {
  b.gt = 0; // new arc — the cached time-to-ground is stale
  const pdx = target.x - b.x;
  const pdz = target.z - b.z;
  const pd = (pdx * pdx + pdz * pdz) ** 0.5 || 0.001;
  const speed = Math.min(BALL_MAX_SPEED, Math.max(dhypot3(b.vx, b.vy, b.vz), BALL_ENRAGE_DASH_SPEED * 0.5));
  const h = (1 - upFrac * upFrac) ** 0.5;
  b.vx = (pdx / pd) * speed * h;
  b.vz = (pdz / pd) * speed * h;
  b.vy = Math.max(speed * upFrac, (target.y - b.y) * 0.8);
}



/** Ground contact → reflect. Mirrors handleGroundBounce: only a bounce
 *  while moving INTO the surface counts. The height is sampled at the
 *  true position EVERY step — the old scheduled-probe scheme tested a
 *  stale plane for up to 0.5s, so the authority could tunnel under rising
 *  terrain while predictors (which walk the real field) parked early:
 *  a 20-90m prediction divergence per event. 800 probes/s is nothing. */
function groundContact(b: SimBall, _dt: number, field: Heightfield, target: SimVec | null, authoritative: boolean, rand?: () => number): SegmentKind | null {
  b.ggy = hmHeight(field, b.x, b.z);
  const gy = b.ggy;
  b.gx = b.x; b.gz = b.z; b.gt = 0;
  if (b.y - b.radius > gy) {return null;}
  b.y = gy + b.radius;
  hmNormal(field, b.x, b.z, _n);
  const dot = b.vx * _n.x + b.vy * _n.y + b.vz * _n.z;
  if (dot >= 0) {return null;}

  if (b.enraged && target && (target.x - b.x) ** 2 + (target.z - b.z) ** 2 <= BALL_ENRAGE_DASH_DIST * BALL_ENRAGE_DASH_DIST) {
    dashAt(b, target);
    b.enraged = false;
    b.dampNextBounce = true;
    return 'lunge';
  }

  // Post-dash landing OR an overspeed impact: reflect at 50% elasticity so
  // the segment ends with a thud, not a full-energy ricochet into orbit.
  const impactSpeed = dhypot3(b.vx, b.vy, b.vz);
  if (impactSpeed < BALL_REST_SPEED) {
    // Settle: park on the surface with zero velocity. The stall breaker
    // owns the wake-up — it launches every BALL_STALL_TIME regardless.
    b.vx = 0; b.vy = 0; b.vz = 0;
    return null;
  }
  let seg: SegmentKind | null = 'bounce';
  if (BALL_SLIDE_ENABLED && -dot < BALL_SLIDE_VN_MIN) {
    // Slide, don't reflect — cancel the inward normal component only.
    // No segment: predictors reach the identical contact and slide too.
    b.vx -= _n.x * dot;
    b.vy -= _n.y * dot;
    b.vz -= _n.z * dot;
    seg = null;
  } else {
    const elasticity = (b.dampNextBounce || impactSpeed > BALL_OVERSPEED) ? 0.5 : BALL_BOUNCE;
    b.dampNextBounce = false;
    const k = -(1 + elasticity) * dot;
    b.vx += _n.x * k;
    b.vy += _n.y * k;
    b.vz += _n.z * k;
  }

  // Drift check: too far from the committed target → enrage spring (the
  // authority decides; the predictor sees it on the segment event anyway).
  if (target && (b.x - target.x) ** 2 + (b.z - target.z) ** 2 > BALL_MAX_DIST * BALL_MAX_DIST) {
    if (!BALL_ENRAGE_ENABLED) {
      // Classic mode — no rage, the leash just relocates it.
      return authoritative ? teleportNearTarget(b, field, target, rand ?? botRand) : null;
    }
    // launchAt is RNG-free — the predictor commits the same enrage spring
    // the authority does instead of waiting one tick for the segment.
    // enrageTimer is NOT reset: a dash overshoot that rockets out the far
    // side re-enrages every bounce, and zeroing the budget each cycle made
    // the 20s teleport deadline unreachable — balls orbited ±200m forever.
    b.enraged = true;
    launchAt(b, target, Math.SQRT1_2);
    return 'enrage';
  }
  return seg;
}



/** Enrage pull: linear accel toward the committed target (still ballistic-
 *  flavored — it arcs and bounces rather than homing). Returns the segment
 *  kind when the step ends here, undefined when the sim should continue. */
function enragePull(b: SimBall, dt: number, field: Heightfield, target: SimVec | null, authoritative: boolean, rand?: () => number): SegmentKind | null | undefined {
  if (!b.enraged || !target) {return undefined;}
  b.enrageTimer += dt;
  const dx = target.x - b.x;
  const dy = target.y + b.radius - b.y;
  const dz = target.z - b.z;
  const d = (dx * dx + dy * dy + dz * dz) ** 0.5;
  if (d > 0.001) {
    const f = BALL_ENRAGE_FORCE * dt / d;
    b.vx += dx * f;
    b.vy += dy * f;
    b.vz += dz * f;
  }
  if (b.enrageTimer <= BALL_ENRAGE_TIMEOUT) {return undefined;}
  b.enraged = false;
  b.enrageTimer = 0; // budget spent — the next enrage gets a fresh 20s
  if (authoritative) {return teleportNearTarget(b, field, target, rand ?? botRand);}
  return null; // predictor: let it fly, the event will snap it
}



export function stepBall(
  b: SimBall,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
  world?: StepWorld,
): SegmentKind | null {
  b.vy += BALL_GRAVITY * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  const enrage = enragePull(b, dt, field, target, authoritative, world?.rand);
  if (enrage !== undefined) {return enrage;}

  // Stall breaker — RNG-free, so predictors run it too and land the same
  // spring the server commits to. Fires BEFORE the bounce check so a ball
  // resting on the ground (the common stall) launches immediately.
  const sp = dhypot3(b.vx, b.vy, b.vz);
  b.slowTimer = sp < BALL_MIN_SPEED ? b.slowTimer + dt : 0;
  if (b.slowTimer >= BALL_STALL_TIME && target) {
    b.slowTimer = 0;
    launchAt(b, target, Math.SQRT1_2);
    return 'stall';
  }

  // Structures before terrain — a ball inside a wall would otherwise
  // terrain-resolve first and stay embedded.
  if (world?.colliders && collideStructures(b, world.colliders, world.colliderIndex)) {return 'bounce';}

  return groundContact(b, dt, field, target, authoritative, world?.rand);
}

function teleportNearTarget(b: SimBall, field: Heightfield, target: SimVec, rand: () => number): SegmentKind {
  b.gt = 0;
  b.px = b.x; b.py = b.y; b.pz = b.z; b.pset = true;
  const ang = rand() * Math.PI * 2;
  const dist = BALL_TELE_MIN + rand() * (BALL_TELE_MAX - BALL_TELE_MIN);
  b.x = target.x + dcos(ang) * dist;
  b.z = target.z + dsin(ang) * dist;
  b.y = hmHeight(field, b.x, b.z) + b.radius + BALL_TELE_MARGIN;
  // Preserve speed, redirect mostly UP with random horizontal tilt — same
  // policy as ballRage.teleportNearPlayer. A flat skimmer re-arriving flat
  // just keeps skimming; the leash exists to put it back in the air.
  const speed = Math.max(dhypot3(b.vx, b.vy, b.vz) || 1, 14);
  const upFrac = 0.75 + rand() * 0.2;
  const a2 = rand() * Math.PI * 2;
  const hsp = speed * (1 - upFrac * upFrac) ** 0.5;
  b.vx = dcos(a2) * hsp;
  b.vy = speed * upFrac;
  b.vz = dsin(a2) * hsp;
  return 'teleport';
}



function dashAt(b: SimBall, target: SimVec): void {
  b.gt = 0;
  const pdx = target.x - b.x;
  const pdz = target.z - b.z;
  const pd = (pdx * pdx + pdz * pdz) ** 0.5 || 0.001;
  const hSpeed = Math.max(dhypot2(b.vx, b.vz), BALL_ENRAGE_DASH_SPEED * 0.5);
  const t = Math.max(0.15, pd / hSpeed);
  const vy = (target.y - b.y + 0.5 * Math.abs(BALL_GRAVITY) * t * t) / t;
  b.vx = (pdx / pd) * hSpeed;
  b.vz = (pdz / pd) * hSpeed;
  b.vy = vy;
}



/** Server-side hit claim result. `impulse` mirrors Ball.applyKnockback —
 * a hit shoves the ball (the whole point of the damage model) so the claim
 * carries the same push and the segment event propagates it. */
export function applySimDamage(b: SimBall, damage: number, impX: number, impY: number, impZ: number): boolean {
  b.health -= damage;
  b.gt = 0; // the impulse rewrote the arc
  b.vx += impX;
  b.vy += impY;
  b.vz += impZ;
  const s = dhypot3(b.vx, b.vy, b.vz);
  if (s > BALL_MAX_SPEED) {
    const k = BALL_MAX_SPEED / s;
    b.vx *= k; b.vy *= k; b.vz *= k;
  }
  return b.health <= 0;
}
