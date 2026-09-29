/**
 * creatureSim — deterministic melee-species core (crawler pilot), same
 * pattern as ballSim.ts: plain numbers, no THREE, run identically on the
 * server's room tick and the client's remote replay.
 *
 * Movement model: the crawler hops — ballistic between ground contacts.
 * Between hops it touches the terrain, picks hop direction from its state
 * machine (wander / chase / windup→pounce), and launches. All RNG rides a
 * per-creature LCG carried IN the sim state (`rng`), so a predictor replays
 * the identical stream — the wire only carries STATE-EDGE events:
 *   retarget  (targetId + committed target snapshot, ~every 2s on authority)
 *   windup    (state edge → both sides schedule the same pounce)
 *   die       (server kill)
 * Hop decisions are RNG-driven but seeded+shared, so they need no events;
 * a drifting predictor self-corrects at the next retarget anyway because
 * wander divergence is bounded by hop speed × retarget period (~20m worst).
 *
 * `authoritative`: only the authority performs damage callbacks — the
 * predictor runs motion/state purely for display.
 */

import { type Heightfield, hmHeight } from './heightfield.js';
import type { SimVec } from './ballSim.js';

export const CRAWLER_SIM = {
  GRAVITY: -28.0,
  AGGRO_D2: 70 * 70,
  POUNCE_D2: 25 * 25,
  WINDUP_S: 0.35,
  HOP_SPEED: 10.0,
  HOP_UP: 5.0,
  POUNCE_SPEED: 30.0,
  HOP_REST_MIN: 0.25,
  HOP_REST_VAR: 0.3,
  RETARGET_S: 2.0,      // authority re-commits its target snapshot this often
  POUNCE_HIT_D2: 4 * 4, // landing this close to the committed target = a bite
  STUN_S: 0.5,          // blast knockback suppresses hopping this long
} as const;

export type CrawlerState = 'wander' | 'chase' | 'windup';

export interface SimCrawler {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;          // last horizontal facing — display lerp target
  state: CrawlerState;
  hopTimer: number;     // rest countdown between hops (grounded only)
  windupTimer: number;
  stunTimer: number;
  wanderYaw: number;
  health: number;
  maxHealth: number;
  uber: boolean;
  dead: boolean;
  rng: number;          // LCG state — part of the sim, travels on spawn
  /** Committed target — player id + the position SNAPSHOT at retarget time.
   *  Both sims steer at the snapshot, never the live pos (see ballSim tx). */
  targetId: string | null;
  tx: number; ty: number; tz: number;
  tgtValid: boolean;
  /** Set by the authority when a pounce lands within POUNCE_HIT_D2 of the
   *  committed target — CombatHandler reads + clears it to apply the bite. */
  pendingBite: boolean;
}

/** Cheap deterministic RNG (Numerical Recipes LCG) — the point isn't
 *  quality, it's that every runtime produces the identical sequence. */
export function crng(s: number): number {
  return (s * 1664525 + 1013904223) >>> 0;
}
function crand(c: SimCrawler): number {
  c.rng = crng(c.rng);
  return c.rng / 4294967296;
}

export function makeSimCrawler(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number,
): SimCrawler {
  const health = uber ? 240 : 70;
  return {
    id, x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'wander', hopTimer: 0.5, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
  };
}

export type CrawlerEvent = 'windup' | 'pounce' | 'bite' | 'land' | 'stagger';

/** Commit a target snapshot — called by the authority every RETARGET_S
 *  (broadcast as the `retarget` event) and by predictors when that event
 *  arrives, so both sides steer at the identical point. */
export function commitTarget(c: SimCrawler, id: string | null, p: SimVec | null): void {
  c.targetId = id;
  if (p) { c.tx = p.x; c.ty = p.y; c.tz = p.z; c.tgtValid = true; }
  else { c.tgtValid = false; }
}

/** One step. `target` = committed snapshot (null = no prey). Returns the
 *  event the authority should broadcast this step, else null. */
export function stepCrawler(
  c: SimCrawler,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);

  // --- ballistic leg ---
  c.vy += CRAWLER_SIM.GRAVITY * dt;
  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  const gy = hmHeight(field, c.x, c.z);
  const airborne = c.y > gy + 0.05;

  if (airborne) return null; // mid-hop — nothing to decide until touchdown

  // Touchdown: park exactly on the surface.
  c.y = gy; c.vx = 0; c.vy = 0; c.vz = 0;

  // Windup is a timed edge, not a position event — but the pounce LAUNCH is
  // the discontinuity, so it's the event the wire carries.
  if (c.state === 'windup') {
    c.windupTimer -= dt;
    if (c.windupTimer <= 0) {
      c.state = 'chase';
      if (target) {
        const dx = target.x - c.x, dz = target.z - c.z;
        const pd = Math.sqrt(dx * dx + dz * dz) || 0.001;
        const t = Math.max(0.15, pd / CRAWLER_SIM.POUNCE_SPEED);
        c.vx = (dx / pd) * CRAWLER_SIM.POUNCE_SPEED;
        c.vz = (dz / pd) * CRAWLER_SIM.POUNCE_SPEED;
        c.vy = (target.y - c.y + 0.5 * Math.abs(CRAWLER_SIM.GRAVITY) * t * t) / t;
        return 'pounce';
      }
    }
    return null;
  }

  // A pounce that already landed beside the target = the bite. Both sides
  // take the same early return — only the pendingBite flag is authority
  // bookkeeping (the predictor still needs 'bite' for the lunge anim). */
  if (target && c.tgtValid) {
    const dx = target.x - c.x, dz = target.z - c.z;
    if (dx * dx + dz * dz < CRAWLER_SIM.POUNCE_HIT_D2) {
      if (authoritative) c.pendingBite = true;
      return 'bite';
    }
  }

  const distSq = target
    ? (target.x - c.x) ** 2 + (target.z - c.z) ** 2
    : Infinity;

  if (target && distSq < CRAWLER_SIM.POUNCE_D2) {
    c.state = 'windup';
    c.windupTimer = CRAWLER_SIM.WINDUP_S;
    return 'windup';
  }

  if (c.stunTimer > 0) return null; // staggered — no hops until it clears

  c.hopTimer -= dt;
  if (c.hopTimer > 0) return null;
  c.hopTimer = CRAWLER_SIM.HOP_REST_MIN + crand(c) * CRAWLER_SIM.HOP_REST_VAR;

  if (target && distSq < CRAWLER_SIM.AGGRO_D2) {
    c.state = 'chase';
    const d = Math.sqrt(distSq) || 0.001;
    c.vx = ((target.x - c.x) / d) * CRAWLER_SIM.HOP_SPEED;
    c.vz = ((target.z - c.z) / d) * CRAWLER_SIM.HOP_SPEED;
    c.vy = CRAWLER_SIM.HOP_UP;
    c.yaw = Math.atan2(c.vx, c.vz);
  } else {
    c.state = 'wander';
    if (crand(c) < 0.4) c.wanderYaw += (crand(c) - 0.5) * 2;
    c.vx = Math.sin(c.wanderYaw) * CRAWLER_SIM.HOP_SPEED * 0.35;
    c.vz = Math.cos(c.wanderYaw) * CRAWLER_SIM.HOP_SPEED * 0.35;
    c.vy = CRAWLER_SIM.HOP_UP * 0.8;
    c.yaw = c.wanderYaw;
  }
  return 'land'; // hop launch — clients use it for dust/anim edge
}

/** Server-side hit application — knockback staggers the hop clock. */
export function applyCrawlerDamage(c: SimCrawler, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, CRAWLER_SIM.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
