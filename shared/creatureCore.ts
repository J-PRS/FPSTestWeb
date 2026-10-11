/**
 * creatureCore — the shared deterministic-creature substrate: the hop
 * pilot family (crawler/scarab) plus the primitives every family builds
 * on — per-creature seeded LCG, clipMotion wall sweeps, committed target
 * snapshots, and the wire edge vocabulary.
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

import { type Heightfield, hmHeight, hmChord } from './heightfield.js';
import type { SimVec, StructureCollider } from './ballSim.js';
import { segSolidHit } from './solidWorld.js';
import { SPECIES, speciesFamily, type SpeciesRow } from './species.js';
import { GRAVITY } from './movement.js';

export const CRAWLER_SIM = {
  GRAVITY,
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

type SimTunables = { readonly [K in keyof typeof CRAWLER_SIM]: number };

/** Hop-family species share the whole state machine — they differ only in
 *  the numbers. The rows live in the unified SPECIES registry
 *  (species.ts); this derived view keeps the old import sites working. */
export const MELEE_SPECIES: Record<string, SpeciesRow> = Object.fromEntries(
  Object.entries(SPECIES).filter(([, r]) => r.family === 'hop'),
);
export const isHopSpecies = (species: string): boolean => speciesFamily(species) === 'hop';

export type CrawlerState = 'wander' | 'chase' | 'windup';

export interface SimCrawler {
  id: number;
  family: 'hop';        // dispatch discriminant — SPECIES_FAMILY[c.family]
  species: string;      // key into SPECIES — travels on the wire
  biteDamage: number;
  sp: SimTunables;      // resolved per-species constants
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
export function crand(c: { rng: number }): number {
  c.rng = crng(c.rng);
  return c.rng / 4294967296;
}

/** Sweep the just-taken move leg against solid structures. On hit the
 *  creature stops at the wall face with no velocity — the next step then
 *  sees it as grounded/falling and picks a new leg. Deterministic on both
 *  ends because both run the same test on the same collider list. */
export function clipMotion(
  c: { x: number; y: number; z: number; vx: number; vy: number; vz: number },
  px: number, py: number, pz: number,
  cols: readonly StructureCollider[] | undefined,
): boolean {
  if (!cols?.length) return false;
  const hit = segSolidHit({ x: px, y: py, z: pz }, { x: c.x, y: c.y, z: c.z }, cols);
  if (!hit) return false;
  // Park a whisker OUTSIDE the face — on-boundary parking leaves the next
  // leg starting inside the slab, where every step re-clips at t≈0 and
  // the creature floats pinned against the wall mid-air.
  const bt = Math.max(0, hit.t - 0.05);
  c.x = px + (c.x - px) * bt;
  c.y = py + (c.y - py) * bt;
  c.z = pz + (c.z - pz) * bt;
  c.vx = 0; c.vy = 0; c.vz = 0;
  return true;
}

export function makeSimCrawler(
  id: number, pos: SimVec, uber: boolean, seed: number, species = 'crawler',
): SimCrawler {
  const { x, y, z } = pos;
  const row = SPECIES[species] ?? SPECIES.crawler!;
  const health = uber ? row.health * 3.4 : row.health;
  const sp: SimTunables = {
    ...CRAWLER_SIM,
    HOP_SPEED: CRAWLER_SIM.HOP_SPEED * (row.speed ?? 1),
    AGGRO_D2: row.aggro ?? CRAWLER_SIM.AGGRO_D2,
    POUNCE_D2: row.pounceD ?? CRAWLER_SIM.POUNCE_D2,
  };
  return {
    id, family: 'hop', species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'wander', hopTimer: 0.5, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
  };
}

export type CrawlerEvent = 'windup' | 'pounce' | 'bite' | 'land' | 'stagger' | 'detonate' | 'charge' | 'fire' | 'blink';

/** Commit a target snapshot — called by the authority every RETARGET_S
 *  (broadcast as the `retarget` event) and by predictors when that event
 *  arrives, so both sides steer at the identical point. */
export function commitTarget(
  c: { targetId: string | null; tx: number; ty: number; tz: number; tgtValid: boolean },
  id: string | null, p: SimVec | null,
): void {
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
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);

  // --- ballistic leg ---
  const px = c.x, py = c.y, pz = c.z;
  c.vy += c.sp.GRAVITY * dt;
  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  clipMotion(c, px, py, pz, cols);
  // Drawn-chord floor — see nuggets/flags: the smooth field sits under
  // the rendered mesh in gullies, parking a crawler there reads buried.
  const gy = Math.max(hmHeight(field, c.x, c.z), hmChord(field, c.x, c.z));
  const airborne = c.y > gy + 0.05;

  if (airborne) return null; // mid-hop — nothing to decide until touchdown

  // Touchdown: park exactly on the surface.
  c.y = gy; c.vx = 0; c.vy = 0; c.vz = 0;

  // Windup is a timed edge, not a position event — but the pounce LAUNCH is
  // the discontinuity, so it's the event the wire carries.
  if (c.state === 'windup') return windupPounce(c, dt, target);

  // A pounce that already landed beside the target = the bite. Both sides
  // take the same early return — only the pendingBite flag is authority
  // bookkeeping (the predictor still needs 'bite' for the lunge anim). */
  if (target && c.tgtValid) {
    const dx = target.x - c.x, dz = target.z - c.z;
    if (dx * dx + dz * dz < c.sp.POUNCE_HIT_D2) {
      if (authoritative) c.pendingBite = true;
      return 'bite';
    }
  }

  const distSq = target
    ? (target.x - c.x) ** 2 + (target.z - c.z) ** 2
    : Infinity;

  if (target && distSq < c.sp.POUNCE_D2) {
    c.state = 'windup';
    c.windupTimer = c.sp.WINDUP_S;
    return 'windup';
  }

  return hopLaunch(c, dt, target, distSq);
}

/** Grounded windup countdown → ballistic pounce at the committed point. */
function windupPounce(c: SimCrawler, dt: number, target: SimVec | null): CrawlerEvent | null {
  c.windupTimer -= dt;
  if (c.windupTimer <= 0) {
    c.state = 'chase';
    if (target) {
      const dx = target.x - c.x, dz = target.z - c.z;
      const pd = Math.sqrt(dx * dx + dz * dz) || 0.001;
      const t = Math.max(0.15, pd / c.sp.POUNCE_SPEED);
      c.vx = (dx / pd) * c.sp.POUNCE_SPEED;
      c.vz = (dz / pd) * c.sp.POUNCE_SPEED;
      c.vy = (target.y - c.y + 0.5 * Math.abs(c.sp.GRAVITY) * t * t) / t;
      return 'pounce';
    }
  }
  return null;
}

/** Hop clock → chase launch at the snapshot, or a wander hop. */
function hopLaunch(c: SimCrawler, dt: number, target: SimVec | null, distSq: number): CrawlerEvent | null {
  if (c.stunTimer > 0) return null; // staggered — no hops until it clears

  c.hopTimer -= dt;
  if (c.hopTimer > 0) return null;
  c.hopTimer = c.sp.HOP_REST_MIN + crand(c) * c.sp.HOP_REST_VAR;

  if (target && distSq < c.sp.AGGRO_D2) {
    c.state = 'chase';
    const d = Math.sqrt(distSq) || 0.001;
    c.vx = ((target.x - c.x) / d) * c.sp.HOP_SPEED;
    c.vz = ((target.z - c.z) / d) * c.sp.HOP_SPEED;
    c.vy = c.sp.HOP_UP;
    c.yaw = Math.atan2(c.vx, c.vz);
  } else {
    c.state = 'wander';
    if (crand(c) < 0.4) c.wanderYaw += (crand(c) - 0.5) * 2;
    c.vx = Math.sin(c.wanderYaw) * c.sp.HOP_SPEED * 0.35;
    c.vz = Math.cos(c.wanderYaw) * c.sp.HOP_SPEED * 0.35;
    c.vy = c.sp.HOP_UP * 0.8;
    c.yaw = c.wanderYaw;
  }
  return 'land'; // hop launch — clients use it for dust/anim edge
}

/** Server-side hit application — knockback staggers the hop clock. */
export function applyCrawlerDamage(c: SimCrawler, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
