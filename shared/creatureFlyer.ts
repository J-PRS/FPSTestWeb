/**
 * creatureFlyer — the flyer family (rakk pilot, gnat). Same committed-
 * snapshot contract as the hop sim: the wire carries only state edges and
 * both sides run this identically. The orbit→dive cycle maps onto the
 * same edge kinds — 'windup' is the fold telegraph, 'pounce' is the dive
 * launch, 'bite' is the claw contact. Climb and orbit re-entry are
 * continuous motion, so they never need an event of their own.
 */

import { type Heightfield, hmHeight } from './heightfield.js';
import type { SimVec, StructureCollider } from './ballSim.js';
import { clipMotion, crand, type CrawlerEvent, type SimCrawler } from './creatureCore.js';

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
  cols?: readonly StructureCollider[],
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

  const px = c.x, py = c.y, pz = c.z;
  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  clipMotion(c, px, py, pz, cols);
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
