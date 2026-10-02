/**
 * creatureSlither — the viper: serpentine S-weave at the committed
 * snapshot, coil telegraph, then a committed straight lunge — jukeable by
 * design. The weave phase lives in sim state (animT) so authority and
 * predictor produce the same wiggle. Edge kinds reuse windup/pounce/bite
 * — zero new wire vocab.
 */

import { type Heightfield, hmHeight } from './heightfield.js';
import { wrapAngleDelta } from './angles.ts';
import type { SimVec, StructureCollider } from './ballSim.js';
import { clipMotion, type CrawlerEvent, type SimCrawler } from './creatureCore.js';

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
  id: number, pos: SimVec, uber: boolean, seed: number, species = 'snake',
): SimSlither {
  const { x, y, z } = pos;
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
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.strikeCd = Math.max(0, c.strikeCd - dt);
  c.animT += dt;

  const dx = target ? target.x - c.x : 0;
  const dz = target ? target.z - c.z : 0;
  const dy = target ? target.y - c.y : 0;
  const geom = { dx, dz, distSq: dx * dx + dz * dz, hitSq: dx * dx + dz * dz + dy * dy };

  // Per-state steppers return the edge to emit, or null to fall through
  // to integration — the event kinds are the wire.
  let ev: CrawlerEvent | null = null;
  switch (c.state) {
    case 'windup': ev = stepCoil(c, dt, geom); break;
    case 'lunge':
      c.hopTimer -= dt;
      if (c.hopTimer <= 0) c.state = 'slither';
      break;
    default: ev = stepWeave(c, dt, target, geom); break;
  }
  if (ev !== null) return ev;

  const spx = c.x, spz = c.z;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  clipMotion(c, spx, c.y, spz, cols);
  c.y = hmHeight(field, c.x, c.z) + 0.5; // belly rides the terrain

  if (c.state === 'lunge' && target && geom.hitSq < c.sp.BITE_D2) {
    c.state = 'slither';
    c.hopTimer = 0;
    c.strikeCd = c.sp.STRIKE_CD;
    if (authoritative) c.pendingBite = true;
    return 'bite';
  }
  if (c.vx * c.vx + c.vz * c.vz > 0.1) {
    const want = Math.atan2(c.vx, c.vz);
    c.yaw += wrapAngleDelta(want - c.yaw) * Math.min(1, 6 * dt);
  }
  return null;
}

type SlitherGeom = { dx: number; dz: number; distSq: number; hitSq: number };

/** Coil — stationary telegraph; contact during the coil doesn't bite,
 *  the committed lunge does. */
function stepCoil(c: SimSlither, dt: number, g: SlitherGeom): CrawlerEvent | null {
  c.vx = 0; c.vz = 0;
  c.windupTimer -= dt;
  if (c.windupTimer <= 0 && c.stunTimer <= 0) {
    c.state = 'lunge';
    c.hopTimer = c.sp.LUNGE_T; // reuse hopTimer as the lunge clock
    const d = Math.sqrt(g.distSq) || 0.001;
    c.vx = (g.dx / d) * c.sp.LUNGE_SPEED;
    c.vz = (g.dz / d) * c.sp.LUNGE_SPEED;
    return 'pounce';
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
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  // A hit breaks the strike — matches the client's applyKnockback.
  if (c.state === 'windup' || c.state === 'lunge') { c.state = 'slither'; c.hopTimer = 0; }
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
