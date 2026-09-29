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

type SimTunables = { readonly [K in keyof typeof CRAWLER_SIM]: number };

/** Hop-family species share the whole state machine — they differ only in
 *  the numbers. A table beats subclassing because the wire just carries
 *  the species NAME and both sides resolve the same row. `spd`/`hp`/
 *  `bite` scale or override the crawler baseline. */
export const MELEE_SPECIES: Record<string, {
  speed: number;        // multiplier on HOP_SPEED
  health: number;       // base (uber still ×~3.4)
  bite: number;         // pounce-contact damage
  aggro?: number;       // flat overrides for species that sense differently
  pounceD?: number;
}> = {
  crawler: { speed: 1.0, health: 70, bite: 25 },
  scarab:  { speed: 1.35, health: 40, bite: 15, aggro: 55 * 55, pounceD: 20 * 20 },
};

export type CrawlerState = 'wander' | 'chase' | 'windup';

export interface SimCrawler {
  id: number;
  species: string;      // key into MELEE_SPECIES — travels on the wire
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
function crand(c: { rng: number }): number {
  c.rng = crng(c.rng);
  return c.rng / 4294967296;
}

export function makeSimCrawler(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'crawler',
): SimCrawler {
  const row = MELEE_SPECIES[species] ?? MELEE_SPECIES.crawler!;
  const health = uber ? row.health * 3.4 : row.health;
  const sp: SimTunables = {
    ...CRAWLER_SIM,
    HOP_SPEED: CRAWLER_SIM.HOP_SPEED * row.speed,
    AGGRO_D2: row.aggro ?? CRAWLER_SIM.AGGRO_D2,
    POUNCE_D2: row.pounceD ?? CRAWLER_SIM.POUNCE_D2,
  };
  return {
    id, species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'wander', hopTimer: 0.5, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
  };
}

export type CrawlerEvent = 'windup' | 'pounce' | 'bite' | 'land' | 'stagger' | 'detonate';

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
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);

  // --- ballistic leg ---
  c.vy += c.sp.GRAVITY * dt;
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
        const t = Math.max(0.15, pd / c.sp.POUNCE_SPEED);
        c.vx = (dx / pd) * c.sp.POUNCE_SPEED;
        c.vz = (dz / pd) * c.sp.POUNCE_SPEED;
        c.vy = (target.y - c.y + 0.5 * Math.abs(c.sp.GRAVITY) * t * t) / t;
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

// ---- Flyer family (rakk pilot) ---------------------------------------
// Same committed-snapshot contract as the hop sim: the wire carries only
// state edges and both sides run this identically. The orbit→dive cycle
// maps onto the same edge kinds — 'windup' is the fold telegraph, 'pounce'
// is the dive launch, 'bite' is the claw contact. Climb and orbit re-entry
// are continuous motion, so they never need an event of their own.

export const FLYER_SIM = {
  ORBIT_R: 16.0,        // circle radius around the prey anchor
  ORBIT_ALT: 12.0,      // cruising height above the anchor's terrain
  ORBIT_SPEED: 13.0,    // tangential cruise speed
  DIVE_SPEED: 30.0,
  DIVE_CD_MIN: 2.5,     // RNG window between dives (seeded, shared)
  DIVE_CD_VAR: 2.0,
  WINDUP_S: 0.55,       // fold telegraph before the launch
  DIVE_T_MAX: 1.8,      // abort the dive past this — climb away
  CLIMB_RATE: 9.0,
  HIT_D2: 2.4 * 2.4,    // claw contact radius vs the committed point
  AGGRO_D2: 85 * 85,
  STEER_K: 3.5,         // exponential steering gain — 1/s
  STUN_S: 0.6,
} as const;

export const FLYER_SPECIES: Record<string, {
  speed: number;        // multiplier on ORBIT_SPEED + DIVE_SPEED
  health: number;
  bite: number;         // claw-contact damage
  orbitR?: number;
  orbitAlt?: number;
}> = {
  rakk: { speed: 1.0, health: 50, bite: 18 },
  gnat: { speed: 1.5, health: 20, bite: 8, orbitR: 10, orbitAlt: 8 },
};

export type FlyerState = 'orbit' | 'windup' | 'dive' | 'climb';

type FlyerTunables = { readonly [K in keyof typeof FLYER_SIM]: number };

/** Shares the hop sim's wire/sim fields so CreatureSim + the client replay
 *  helpers treat both families uniformly — only `state`, the tunables and
 *  the flyer-only anchors differ. */
export interface SimFlyer extends Omit<SimCrawler, 'state' | 'sp'> {
  state: FlyerState;
  sp: FlyerTunables;
  orbitPhase: number;
  orbitDir: 1 | -1;
  diveTimer: number;    // in windup: telegraph left; in dive: abort clock
  diveCooldown: number; // seeded RNG cooldown — both sides roll identically
  /** Orbit anchor — the committed prey snapshot when tgtValid, else the
   *  spawn-home point the flyer circles until a target commits. */
  hx: number; hy: number; hz: number;
}

export function isFlyerSpecies(species: string): boolean {
  return FLYER_SPECIES[species] !== undefined;
}

export function makeSimFlyer(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'rakk',
): SimFlyer {
  const row = FLYER_SPECIES[species] ?? FLYER_SPECIES.rakk!;
  const health = uber ? row.health * 3.4 : row.health;
  const sp: FlyerTunables = {
    ...FLYER_SIM,
    ORBIT_SPEED: FLYER_SIM.ORBIT_SPEED * row.speed,
    DIVE_SPEED: FLYER_SIM.DIVE_SPEED * row.speed,
    ORBIT_R: row.orbitR ?? FLYER_SIM.ORBIT_R,
    ORBIT_ALT: row.orbitAlt ?? FLYER_SIM.ORBIT_ALT,
  };
  const rng = seed >>> 0 || 1;
  return {
    id, species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'orbit', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: 0, health, maxHealth: health,
    uber, dead: false, rng,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    orbitPhase: (rng % 628) / 100,
    orbitDir: (rng & 1) ? 1 : -1,
    diveTimer: 0,
    diveCooldown: FLYER_SIM.DIVE_CD_MIN + ((rng >>> 8) % 1000) / 1000 * FLYER_SIM.DIVE_CD_VAR,
    hx: x, hy: y, hz: z,
  };
}

function flyToward(c: SimFlyer, gx: number, gy: number, gz: number, speed: number, dt: number): void {
  const dx = gx - c.x, dy = gy - c.y, dz = gz - c.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
  const k = Math.min(1, c.sp.STEER_K * dt);
  c.vx += ((dx / d) * speed - c.vx) * k;
  c.vy += ((dy / d) * speed - c.vy) * k;
  c.vz += ((dz / d) * speed - c.vz) * k;
}

/** One step — authority and predictor run the same transitions. `target`
 *  is the committed snapshot; the orbit anchor falls back to spawn-home
 *  when no prey is committed. */
export function stepFlyer(
  c: SimFlyer,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  const ax = c.tgtValid ? c.tx : c.hx;
  const ay = c.tgtValid ? c.ty : c.hy;
  const az = c.tgtValid ? c.tz : c.hz;

  switch (c.state) {
    case 'orbit': {
      c.diveCooldown -= dt;
      if (c.stunTimer <= 0) {
        c.orbitPhase += (c.sp.ORBIT_SPEED / c.sp.ORBIT_R) * c.orbitDir * dt;
        const gy = hmHeight(field, ax, az);
        flyToward(c,
          ax + Math.cos(c.orbitPhase) * c.sp.ORBIT_R,
          Math.max(ay, gy) + c.sp.ORBIT_ALT,
          az + Math.sin(c.orbitPhase) * c.sp.ORBIT_R,
          c.sp.ORBIT_SPEED, dt);
      }
      if (target && c.tgtValid && c.diveCooldown <= 0) {
        c.state = 'windup';
        c.diveTimer = c.sp.WINDUP_S;
        return 'windup';
      }
      break;
    }
    case 'windup': {
      // Fold telegraph — brake hard; the dive launch is the wire event.
      const k = Math.min(1, 6 * dt);
      c.vx -= c.vx * k; c.vy -= c.vy * k; c.vz -= c.vz * k;
      c.diveTimer -= dt;
      if (c.diveTimer <= 0) {
        c.state = 'dive';
        c.diveTimer = c.sp.DIVE_T_MAX;
        return 'pounce';
      }
      break;
    }
    case 'dive': {
      c.diveTimer -= dt;
      if (target) flyToward(c, target.x, target.y, target.z, c.sp.DIVE_SPEED, dt);
      const hit = target &&
        (target.x - c.x) ** 2 + (target.y - c.y) ** 2 + (target.z - c.z) ** 2 < c.sp.HIT_D2;
      if (hit) {
        if (authoritative) c.pendingBite = true;
        c.state = 'climb';
        return 'bite';
      }
      if (c.diveTimer <= 0 || (target && (target.x - c.x) ** 2 + (target.z - c.z) ** 2 < 4)) {
        c.state = 'climb';
      }
      break;
    }
    case 'climb': {
      const gy = hmHeight(field, c.x, c.z);
      flyToward(c, c.x, gy + c.sp.ORBIT_ALT + 4, c.z, c.sp.CLIMB_RATE, dt);
      if (c.y >= gy + c.sp.ORBIT_ALT) {
        c.state = 'orbit';
        c.diveCooldown = c.sp.DIVE_CD_MIN + crand(c) * c.sp.DIVE_CD_VAR;
        return 'land';
      }
      break;
    }
  }

  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  const gy = hmHeight(field, c.x, c.z);
  if (c.y < gy + 0.8) c.y = gy + 0.8;
  if (c.vx * c.vx + c.vz * c.vz > 1) c.yaw = Math.atan2(c.vx, c.vz);
  return null;
}

export function applyFlyerDamage(c: SimFlyer, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}

// ---- Roller family ----------------------------------------------------
// The simplest family: a terrain-following boulder that steers at the
// committed snapshot. No telegraphs — 'bite' is the only combat edge,
// everything else is continuous roll the predictor replays on its own.

export const ROLLER_SIM = {
  ACCEL: 9.0,
  TOPSPEED: 8.5,
  AGGRO_D2: 90 * 90,   // beyond this it idles (drifts at 20% speed)
  HIT_R: 2.4,          // contact-bite reach around its center
  BITE_CD: 0.6,        // invuln window so one touch can't multi-tick
  DOWNHILL_K: 0.04,    // gravity assist rolling downhill
  STUN_S: 0.5,
} as const;

export const ROLLER_SPECIES: Record<string, {
  speed: number;        // multiplier on TOPSPEED
  health: number;
  bite: number;
}> = {
  roller: { speed: 1.0, health: 120, bite: 30 },
};

export type RollerState = 'roll';

type RollerTunables = { readonly [K in keyof typeof ROLLER_SIM]: number };

export interface SimRoller extends Omit<SimCrawler, 'state' | 'sp'> {
  state: RollerState;
  sp: RollerTunables;
  hitCd: number;        // contact invuln — deterministic cooldown
}

export function isRollerSpecies(species: string): boolean {
  return ROLLER_SPECIES[species] !== undefined;
}

export function makeSimRoller(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'roller',
): SimRoller {
  const row = ROLLER_SPECIES[species] ?? ROLLER_SPECIES.roller!;
  const health = uber ? row.health * 3.4 : row.health;
  const sp: RollerTunables = {
    ...ROLLER_SIM,
    TOPSPEED: ROLLER_SIM.TOPSPEED * row.speed,
  };
  return {
    id, species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'roll', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    hitCd: 0,
  };
}

export function stepRoller(
  c: SimRoller,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.hitCd = Math.max(0, c.hitCd - dt);

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const distSq = dx * dx + dz * dz;

  if (c.stunTimer <= 0 && target && distSq > 0.01) {
    const aggro = distSq < c.sp.AGGRO_D2;
    const d = Math.sqrt(distSq);
    const k = c.sp.ACCEL * (aggro ? 1 : 0.2) * dt;
    c.vx += (dx / d) * k;
    c.vz += (dz / d) * k;
  }

  const hSpeed = Math.hypot(c.vx, c.vz);
  if (hSpeed > c.sp.TOPSPEED) {
    const s = c.sp.TOPSPEED / hSpeed;
    c.vx *= s; c.vz *= s;
  }

  const prevY = c.y;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  const gy = hmHeight(field, c.x, c.z);
  c.y = gy + 1.6; // rides the surface — radius baked into the constant
  const drop = prevY - c.y;
  if (drop > 0 && hSpeed > 0.1 && target && distSq > 0.01) {
    const d = Math.sqrt(distSq);
    const g = Math.min(drop / dt * c.sp.DOWNHILL_K, 4);
    c.vx += (dx / d) * g * dt;
    c.vz += (dz / d) * g * dt;
  }
  if (hSpeed > 0.5) c.yaw = Math.atan2(c.vx, c.vz);

  if (target && c.hitCd <= 0) {
    const d3 = (target.x - c.x) ** 2 + (target.y - c.y) ** 2 + (target.z - c.z) ** 2;
    if (d3 < c.sp.HIT_R * c.sp.HIT_R) {
      c.hitCd = c.sp.BITE_CD;
      if (authoritative) c.pendingBite = true;
      return 'bite';
    }
  }
  return null;
}

export function applyRollerDamage(c: SimRoller, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}

// ---- Slither family ---------------------------------------------------
// The viper: serpentine S-weave at the committed snapshot, coil telegraph,
// then a committed straight lunge — jukeable by design. The weave phase
// lives in sim state (animT) so authority and predictor produce the same
// wiggle. Edge kinds reuse windup/pounce/bite — zero new wire vocab.

export const SLITHER_SIM = {
  SPEED: 6.5,
  AGGRO_D2: 70 * 70,
  STRIKE_D2: 5.5 * 5.5,
  STRIKE_CD: 2.2,
  WINDUP_S: 0.45,
  LUNGE_T: 0.4,
  LUNGE_SPEED: 14.0,
  BITE_D2: 2.4 * 2.4,
  WEAVE_HZ: 7,       // animT multiplier for the S-weave
  WEAVE_AMP: 0.5,    // radians of heading wobble
  STUN_S: 0.8,       // a hit breaks the strike — matches applyKnockback
} as const;

export const SLITHER_SPECIES: Record<string, {
  speed: number;
  health: number;
  bite: number;
}> = {
  snake: { speed: 1.0, health: 45, bite: 14 },
};

export type SlitherState = 'slither' | 'windup' | 'lunge';

type SlitherTunables = { readonly [K in keyof typeof SLITHER_SIM]: number };

export interface SimSlither extends Omit<SimCrawler, 'state' | 'sp'> {
  state: SlitherState;
  sp: SlitherTunables;
  animT: number;      // weave phase — sim-owned so the S is deterministic
  strikeCd: number;
}

export function isSlitherSpecies(species: string): boolean {
  return SLITHER_SPECIES[species] !== undefined;
}

export function makeSimSlither(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'snake',
): SimSlither {
  const row = SLITHER_SPECIES[species] ?? SLITHER_SPECIES.snake!;
  const health = uber ? row.health * 4 : row.health;
  const sp: SlitherTunables = {
    ...SLITHER_SIM,
    SPEED: SLITHER_SIM.SPEED * row.speed,
  };
  const rng = seed >>> 0 || 1;
  return {
    id, species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'slither', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (rng % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    animT: (rng % 1000) / 100, strikeCd: ((rng >>> 8) % 1000) / 1000 * sp.STRIKE_CD,
  };
}

export function stepSlither(
  c: SimSlither,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.strikeCd = Math.max(0, c.strikeCd - dt);
  c.animT += dt;

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const distSq = dx * dx + dz * dz;
  const dy = target ? target.y - c.y : 0;
  const hitSq = distSq + dy * dy;

  switch (c.state) {
    case 'windup': {
      // Coil — stationary telegraph; contact during the coil doesn't bite,
      // the committed lunge does.
      c.vx = 0; c.vz = 0;
      c.windupTimer -= dt;
      if (c.windupTimer <= 0 && c.stunTimer <= 0) {
        c.state = 'lunge';
        c.hopTimer = c.sp.LUNGE_T; // reuse hopTimer as the lunge clock
        const d = Math.sqrt(distSq) || 0.001;
        c.vx = (dx / d) * c.sp.LUNGE_SPEED;
        c.vz = (dz / d) * c.sp.LUNGE_SPEED;
        return 'pounce';
      }
      break;
    }
    case 'lunge': {
      c.hopTimer -= dt;
      if (c.hopTimer <= 0) c.state = 'slither';
      break;
    }
    default: { // slither
      if (c.stunTimer <= 0 && target && distSq < c.sp.AGGRO_D2) {
        const wantYaw = Math.atan2(dx, dz);
        const weave = Math.sin(c.animT * c.sp.WEAVE_HZ) * c.sp.WEAVE_AMP;
        const wy = wantYaw + weave;
        c.vx = Math.sin(wy) * c.sp.SPEED;
        c.vz = Math.cos(wy) * c.sp.SPEED;
        if (hitSq < c.sp.STRIKE_D2 && c.strikeCd <= 0) {
          c.state = 'windup';
          c.windupTimer = c.sp.WINDUP_S;
          return 'windup';
        }
      } else {
        c.vx *= Math.max(0, 1 - 4 * dt);
        c.vz *= Math.max(0, 1 - 4 * dt);
      }
      break;
    }
  }

  c.x += c.vx * dt;
  c.z += c.vz * dt;
  c.y = hmHeight(field, c.x, c.z) + 0.5; // belly rides the terrain

  if (c.state === 'lunge' && target && hitSq < c.sp.BITE_D2) {
    c.state = 'slither';
    c.hopTimer = 0;
    c.strikeCd = c.sp.STRIKE_CD;
    if (authoritative) c.pendingBite = true;
    return 'bite';
  }
  if (c.vx * c.vx + c.vz * c.vz > 0.1) {
    const want = Math.atan2(c.vx, c.vz);
    let dyy = want - c.yaw;
    while (dyy > Math.PI) dyy -= Math.PI * 2;
    while (dyy < -Math.PI) dyy += Math.PI * 2;
    c.yaw += dyy * Math.min(1, 6 * dt);
  }
  return null;
}

export function applySlitherDamage(c: SimSlither, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  // A hit breaks the strike — matches the client's applyKnockback.
  if (c.state === 'windup' || c.state === 'lunge') { c.state = 'slither'; c.hopTimer = 0; }
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}

// ---- Kamikaze family ---------------------------------------------------
// The sac: roller chassis, but the pop IS the attack. No bite cooldown —
// a fuse (3D proximity) or a lifetime clock emits 'detonate', the one new
// edge kind on the wire, and the authority maps it to an AOE blast +
// crawlDie. Shooting it pops it the same way, which is the counterplay.

export const BANELING_SIM = {
  ACCEL: 22.0,
  TOPSPEED: 20.0,
  AGGRO_D2: 140 * 140,   // born homing — a wide chase envelope
  FUSE_D2: 2.6 * 2.6,    // 3D proximity pop
  LIFE_S: 25.0,          // self-detonates eventually
  STUN_S: 0.3,           // a hit staggers the fuse run
} as const;

export const BANELING_SPECIES: Record<string, {
  speed: number;
  health: number;
  bite: number;         // blast damage at zero distance
  blast: number;        // blast radius
}> = {
  baneling: { speed: 1.0, health: 15, bite: 18, blast: 5.0 },
};

export type BanelingState = 'chase';

type BanelingTunables = { readonly [K in keyof typeof BANELING_SIM]: number };

export interface SimBaneling extends Omit<SimCrawler, 'state' | 'sp'> {
  state: BanelingState;
  sp: BanelingTunables;
  age: number;          // fuse life clock — deterministic, drives the pop
  blastRadius: number;  // authority reads this for the AOE sweep
}

export function isBanelingSpecies(species: string): boolean {
  return BANELING_SPECIES[species] !== undefined;
}

export function makeSimBaneling(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'baneling',
): SimBaneling {
  const row = BANELING_SPECIES[species] ?? BANELING_SPECIES.baneling!;
  const health = uber ? row.health * 4 : row.health;
  const sp: BanelingTunables = {
    ...BANELING_SIM,
    TOPSPEED: BANELING_SIM.TOPSPEED * row.speed,
    ACCEL: BANELING_SIM.ACCEL * row.speed,
  };
  return {
    id, species, biteDamage: uber ? row.bite * 2 : row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'chase', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    age: 0, blastRadius: uber ? row.blast * 1.7 : row.blast,
  };
}

export function stepBaneling(
  c: SimBaneling,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.age += dt;

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const distSq = dx * dx + dz * dz;

  if (c.stunTimer <= 0 && target && distSq > 0.01) {
    const aggro = distSq < c.sp.AGGRO_D2;
    const d = Math.sqrt(distSq);
    const k = c.sp.ACCEL * (aggro ? 1 : 0.2) * dt;
    c.vx += (dx / d) * k;
    c.vz += (dz / d) * k;
  }

  const hSpeed = Math.hypot(c.vx, c.vz);
  if (hSpeed > c.sp.TOPSPEED) {
    const s = c.sp.TOPSPEED / hSpeed;
    c.vx *= s; c.vz *= s;
  }

  c.x += c.vx * dt;
  c.z += c.vz * dt;
  c.y = hmHeight(field, c.x, c.z) + 0.7; // small sac, low ride
  if (hSpeed > 0.5) c.yaw = Math.atan2(c.vx, c.vz);

  if (target) {
    const d3 = (target.x - c.x) ** 2 + (target.y - c.y) ** 2 + (target.z - c.z) ** 2;
    if (d3 < c.sp.FUSE_D2) { c.dead = true; return 'detonate'; }
  }
  if (c.age >= c.sp.LIFE_S) { c.dead = true; return 'detonate'; }
  return null;
}

export function applyBanelingDamage(c: SimBaneling, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
