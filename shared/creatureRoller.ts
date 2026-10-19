/**
 * creatureRoller — the simplest family: a terrain-following boulder that
 * steers at the committed snapshot. No telegraphs — 'bite' is the only
 * combat edge, everything else is continuous roll the predictor replays
 * on its own.
 */

import { type Heightfield, hmHeight } from './heightfield.js';
import { datan2, dhypot } from './dmath.ts';
import type { SimVec, StructureCollider } from './ballSim.js';
import { clipMotion, type CrawlerEvent, type SimCrawler } from './creatureCore.js';
import { SPECIES, speciesFamily, type SpeciesRow } from './species.js';

export const ROLLER_SIM = {
  ACCEL: 9,
  TOPSPEED: 8.5,
  AGGRO_D2: 90 * 90,   // beyond this it idles (drifts at 20% speed)
  HIT_R: 2.4,          // contact-bite reach around its center
  BITE_CD: 0.6,        // invuln window so one touch can't multi-tick
  DOWNHILL_K: 0.04,    // gravity assist rolling downhill
  STUN_S: 0.5,
} as const;

// Roller rows live in the unified SPECIES registry; derived view.
export const ROLLER_SPECIES: Record<string, SpeciesRow> = Object.fromEntries(
  Object.entries(SPECIES).filter(([, r]): boolean => r.family === 'roll'),
);

export type RollerState = 'roll';

type RollerTunables = { readonly [K in keyof typeof ROLLER_SIM]: number };

export interface SimRoller extends Omit<SimCrawler, 'state' | 'sp' | 'family'> {
  family: 'roll';
  state: RollerState;
  sp: RollerTunables;
  hitCd: number;        // contact invuln — deterministic cooldown
}

export function isRollerSpecies(species: string): boolean {
  return speciesFamily(species) === 'roll';
}

export function makeSimRoller(
  id: number, pos: SimVec, uber: boolean, seed: number, species = 'roller',
): SimRoller {
  const { x, y, z } = pos;
  const row = SPECIES[species] ?? SPECIES.roller!;
  const health = uber ? row.health * 3.4 : row.health;
  const sp: RollerTunables = Object.assign({}, ROLLER_SIM, {TOPSPEED: ROLLER_SIM.TOPSPEED * (row.speed ?? 1)});
  return {
    id, family: 'roll', species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'roll', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    hitCd: 0,
  };
}

/** Rolling contact — the body IS the weapon, no separate swing. */
function rollContact(c: SimRoller, target: SimVec | null, authoritative: boolean): CrawlerEvent | null {
  if (target && c.hitCd <= 0) {
    const d3 = (target.x - c.x) ** 2 + (target.y - c.y) ** 2 + (target.z - c.z) ** 2;
    if (d3 < c.sp.HIT_R * c.sp.HIT_R) {
      c.hitCd = c.sp.BITE_CD;
      if (authoritative) {c.pendingBite = true;}
      return 'bite';
    }
  }
  return null;
}



/** Push toward the committed snapshot, capped — stunned rollers coast. */
function rollSteer(c: SimRoller, dt: number, target: SimVec | null, dx: number, dz: number, distSq: number): void {
  if (c.stunTimer <= 0 && target && distSq > 0.01) {
    const aggro = distSq < c.sp.AGGRO_D2;
    const d = Math.sqrt(distSq);
    const k = c.sp.ACCEL * (aggro ? 1 : 0.2) * dt;
    c.vx += (dx / d) * k;
    c.vz += (dz / d) * k;
  }
  const hSpeed = dhypot(c.vx, c.vz);
  if (hSpeed > c.sp.TOPSPEED) {
    const s = c.sp.TOPSPEED / hSpeed;
    c.vx *= s; c.vz *= s;
  }
}



export function stepRoller(
  c: SimRoller,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.hitCd = Math.max(0, c.hitCd - dt);

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const distSq = dx * dx + dz * dz;

  rollSteer(c, dt, target, dx, dz, distSq);

  const hSpeed = dhypot(c.vx, c.vz);
  const prevY = c.y, px = c.x, pz = c.z;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  if (clipMotion(c, px, c.y, pz, cols)) { c.hitCd = Math.max(c.hitCd, 0.3); }
  const gy = hmHeight(field, c.x, c.z);
  if (Number.isFinite(gy)) {c.y = gy + 1.6;} // rides the surface — radius baked into the constant
  const drop = prevY - c.y;
  if (drop > 0 && hSpeed > 0.1 && target && distSq > 0.01) {
    const d = Math.sqrt(distSq);
    const g = Math.min(drop / dt * c.sp.DOWNHILL_K, 4);
    c.vx += (dx / d) * g * dt;
    c.vz += (dz / d) * g * dt;
  }
  if (hSpeed > 0.5) {c.yaw = datan2(c.vx, c.vz);}

  return rollContact(c, target, authoritative);
}

export function applyRollerDamage(c: SimRoller, damage: number): boolean {
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
