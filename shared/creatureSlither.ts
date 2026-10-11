/**
 * creatureSlither — the viper: serpentine S-weave at the committed
 * snapshot, coil telegraph, then a committed straight lunge — jukeable by
 * design. The weave phase lives in sim state (animT) so authority and
 * predictor produce the same wiggle. Edge kinds reuse windup/pounce/bite
 * — zero new wire vocab.
 */

import { type Heightfield, hmHeight, hmChord } from './heightfield.js';
import { wrapAngleDelta } from './angles.ts';
import type { SimVec, StructureCollider } from './ballSim.js';
import { clipMotion, type CrawlerEvent, type SimCrawler } from './creatureCore.js';
import { SPECIES, speciesFamily, type SpeciesRow } from './species.js';
import { GRAVITY } from './movement.js';
import { inv } from './invariants.js';

export const SLITHER_SIM = {
  SPEED: 6.5,
  AGGRO_D2: 70 * 70,
  STRIKE_D2: 5.5 * 5.5,
  STRIKE_CD: 2.2,
  WINDUP_S: 0.45,
  LUNGE_T: 1.2,      // safety cap — landing ends the leap long before this
  LUNGE_SPEED: 14,
  GRAVITY,           // the leap arc pays world gravity — one source in movement.ts
  OVERSHOOT: 3.5,    // aim point past the target — the leap goes THROUGH
  BITE_D2: 2.4 * 2.4,
  WEAVE_HZ: 7,       // animT multiplier for the S-weave
  WEAVE_AMP: 0.5,    // radians of heading wobble
  STUN_S: 0.8,       // a hit breaks the strike — matches applyKnockback
} as const;

// Slither rows live in the unified SPECIES registry; derived view.
export const SLITHER_SPECIES: Record<string, SpeciesRow> = Object.fromEntries(
  Object.entries(SPECIES).filter(([, r]): boolean => r.family === 'slither'),
);

export type SlitherState = 'slither' | 'windup' | 'lunge';

type SlitherTunables = { readonly [K in keyof typeof SLITHER_SIM]: number };

export interface SimSlither extends Omit<SimCrawler, 'state' | 'sp' | 'family'> {
  family: 'slither';
  state: SlitherState;
  sp: SlitherTunables;
  animT: number;      // weave phase — sim-owned so the S is deterministic
  strikeCd: number;
  struck: boolean;    // the leap already spent its one pass-through bite
}

export function isSlitherSpecies(species: string): boolean {
  return speciesFamily(species) === 'slither';
}

export function makeSimSlither(
  id: number, pos: SimVec, uber: boolean, seed: number, species = 'snake',
): SimSlither {
  const { x, y, z } = pos;
  const row = SPECIES[species] ?? SPECIES.snake!;
  const health = uber ? row.health * 4 : row.health;
  const sp: SlitherTunables = Object.assign({}, SLITHER_SIM, {SPEED: SLITHER_SIM.SPEED * (row.speed ?? 1)});
  const rng = seed >>> 0 || 1;
  return {
    id, family: 'slither', species, biteDamage: row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'slither', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (rng % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    animT: (rng % 1000) / 100, strikeCd: ((rng >>> 8) % 1000) / 1000 * sp.STRIKE_CD,
    struck: false,
  };
}

export function stepSlither(
  c: SimSlither,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.strikeCd = Math.max(0, c.strikeCd - dt);
  c.animT += dt;

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const dy = target ? target.y - c.y : 0;
  const geom = { dx, dz, dy, ty: target ? target.y : c.y, distSq: dx * dx + dz * dz, hitSq: dx * dx + dz * dz + dy * dy };

  // Per-state steppers return the edge to emit, or null to fall through
  // to integration — the event kinds are the wire.
  // oxlint-disable-next-line init-declarations -- assigned later
  let ev!: CrawlerEvent | null;
  switch (c.state) {
    case 'windup': { ev = stepCoil(c, dt, geom); break;
    }
    case 'lunge': { return stepLeap(c, dt, field, target, authoritative, cols);
    }
    default: { ev = stepWeave(c, dt, target, geom); break;
    }
  }
  if (ev !== null) {return ev;}

  const spx = c.x, spz = c.z;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  clipMotion(c, spx, c.y, spz, cols);
  c.y = Math.max(hmHeight(field, c.x, c.z), hmChord(field, c.x, c.z)) + 0.5; // belly rides the drawn surface

  if (c.vx * c.vx + c.vz * c.vz > 0.1) {
    const want = Math.atan2(c.vx, c.vz);
    c.yaw += wrapAngleDelta(want - c.yaw) * Math.min(1, 6 * dt);
  }
  return null;
}

type SlitherGeom = { dx: number; dz: number; dy: number; ty: number; distSq: number; hitSq: number };

/** Coil — stationary telegraph; contact during the coil doesn't bite,
 *  the committed leap does. */
function stepCoil(c: SimSlither, dt: number, g: SlitherGeom): CrawlerEvent | null {
  c.vx = 0; c.vz = 0;
  c.windupTimer -= dt;
  if (c.windupTimer <= 0 && c.stunTimer <= 0) {
    c.state = 'lunge';
    c.struck = false;
    // The leap is ballistic THROUGH the target, not a dash to it: the
    // aim point rides an OVERSHOOT past the prey, and vy is solved like
    // the crawler pounce so the arc arrives at the target's own height —
    // it passes through legs-to-chest and keeps flying.
    const d = Math.sqrt(g.distSq) || 0.001;
    const ux = g.dx / d, uz = g.dz / d;
    const t = Math.max(0.2, (d + c.sp.OVERSHOOT) / c.sp.LUNGE_SPEED);
    c.hopTimer = t + 0.4; // safety clock just past the planned touchdown
    c.vx = ux * c.sp.LUNGE_SPEED;
    c.vz = uz * c.sp.LUNGE_SPEED;
    c.vy = (g.ty - c.y + 0.5 * Math.abs(c.sp.GRAVITY) * t * t) / t;
    return 'pounce';
  }
  return null;
}

/** Leap leg — airborne arc. One bite on the pass-through; the flight
 *  keeps going (that's the point) and touchdown ends the strike. */
function stepLeap(
  c: SimSlither, dt: number, field: Heightfield,
  target: SimVec | null, authoritative: boolean,
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.hopTimer -= dt;
  const px = c.x, py = c.y, pz = c.z;
  c.vy += c.sp.GRAVITY * dt;
  c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
  clipMotion(c, px, py, pz, cols);

  // Pass-through contact — fires once per leap, mid-flight, and the
  // snake keeps moving. A body already past still counts on the frame.
  if (target && !c.struck) {
    const bdx = target.x - c.x, bdz = target.z - c.z, bdy = target.y - c.y;
    if (bdx * bdx + bdz * bdz + bdy * bdy < c.sp.BITE_D2) {
      c.struck = true;
      if (authoritative) {c.pendingBite = true;}
      return 'bite';
    }
  }

  const gy = Math.max(hmHeight(field, c.x, c.z), hmChord(field, c.x, c.z)) + 0.5;
  if ((Number.isFinite(gy) && c.y <= gy) || c.hopTimer <= 0) {
    if (Number.isFinite(gy)) {c.y = Math.min(c.y, gy);} c.vx = 0; c.vy = 0; c.vz = 0;
    c.state = 'slither';
    c.strikeCd = c.sp.STRIKE_CD;
    return null;
  }

  if (c.vx * c.vx + c.vz * c.vz > 0.1) {
    const want = Math.atan2(c.vx, c.vz);
    c.yaw += wrapAngleDelta(want - c.yaw) * Math.min(1, 6 * dt);
  }
  return null;
}

/** S-weave pursuit at the committed snapshot; bleeds off when no prey
 *  is in aggro, telegraphs into the coil when the strike lands. */
function stepWeave(
  c: SimSlither, dt: number, target: SimVec | null, g: SlitherGeom,
): CrawlerEvent | null {
  if (c.stunTimer <= 0 && target && g.distSq < c.sp.AGGRO_D2) {
    const wantYaw = Math.atan2(g.dx, g.dz);
    const weave = Math.sin(c.animT * c.sp.WEAVE_HZ) * c.sp.WEAVE_AMP;
    const wy = wantYaw + weave;
    c.vx = Math.sin(wy) * c.sp.SPEED;
    c.vz = Math.cos(wy) * c.sp.SPEED;
    if (g.hitSq < c.sp.STRIKE_D2 && c.strikeCd <= 0) {
      c.state = 'windup';
      c.windupTimer = c.sp.WINDUP_S;
      return 'windup';
    }
  } else {
    c.vx *= Math.max(0, 1 - 4 * dt);
    c.vz *= Math.max(0, 1 - 4 * dt);
  }
  return null;
}

export function applySlitherDamage(c: SimSlither, damage: number): boolean {
  if (!Number.isFinite(damage)) { inv('creature-damage-finite', false, { damage, kind: 'slither' }); return false; }
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  // A hit breaks the strike — matches the client's applyKnockback.
  if (c.state === 'windup' || c.state === 'lunge') { c.state = 'slither'; c.hopTimer = 0; }
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
