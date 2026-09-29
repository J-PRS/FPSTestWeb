/**
 * creatureTotem — the sniper obelisk, the only family that hurts you
 * without touching you. It doesn't move, it BLINKS: peak-seeks to terrain
 * high ground, charges a telegraphed aim-beam at the committed target
 * snapshot, then fires a hitscan rail down the locked line. Everything is
 * a committed edge — lockPoint, lockDir and lockDist are all derived from
 * committed state (target snapshot + own position + static terrain), so
 * predictors replay the same telegraph and the same beam with zero
 * divergence.
 *
 * Edge vocab: 'windup' isn't reused for the charge — a NEW 'charge' edge
 * carries the lock commit (tp = locked point). 'fire' is the discharge
 * (authority resolves the hit against LIVE player positions — sidestep
 * after the lock shows and the beam whiffs, exactly like the client
 * model). 'blink' telegraphs the relocation before the position snaps.
 */

import { type Heightfield, hmHeight } from './heightfield.js';
import type { SimVec, StructureCollider } from './ballSim.js';
import { segSolidHit } from './solidWorld.js';
import { crand, type CrawlerEvent, type SimCrawler } from './creatureCore.js';

export const TOTEM_SIM = {
  RANGE: 105.0,          // engage envelope — inside readable fog distance
  MIN_RANGE: 22.0,       // player closer than this → blink away
  REFIRE: 2.6,           // seconds between shots
  CHARGE: 0.65,          // aim-beam telegraph — dodgeable, not free
  RELOCATE_SHOTS: 3,     // shots fired before seeking a new perch
  PEAK_RADIUS: 45.0,     // blink ring-search radius for high ground
  PEAK_MIN_GAIN: 3.0,    // min height gain to count as a better perch
  BLINK_OUT_S: 0.25,     // shrink-out telegraph
  BLINK_IN_S: 1.1,       // arrival shimmer before the body exists
  BLINK_CD_MIN: 2.0,     // random 2–5s between blinks — no chain escapes
  BLINK_CD_VAR: 3.0,
  EYE_HEIGHT: 3.9,       // beam origin per unit body radius (× c.radius)
  HIT_R2: 1.7,           // beam catch radius² vs a player on the line
  STAGGER_S: 1.1,        // damage pins the obelisk — it can't blink
} as const;

// Uber mirrors the client's crowned elder: slower, fatter, predictive.
const TOTEM_UBER = {
  REFIRE: 4.5,
  CHARGE: 1.0,
  HIT_R2: 1.5 * 1.5,
} as const;

export const TOTEM_SPECIES: Record<string, {
  health: number;
  bite: number;          // beam damage
}> = {
  totem: { health: 200, bite: 15 },
};

export type TotemState = 'aim' | 'charge' | 'blinkOut' | 'blinkIn';

type TotemTunables = { readonly [K in keyof typeof TOTEM_SIM]: number };

/** The stationary family still shares the melee wire/sim fields — only
 *  `state`, the tunables and the lock/blink payload differ. hopTimer is
 *  the per-state clock (charge timer / blink phase timer); windupTimer
 *  is the refire countdown; stunTimer doubles as the stagger pin. */
export interface SimTotem extends Omit<SimCrawler, 'state' | 'sp'> {
  state: TotemState;
  sp: TotemTunables;
  shotsFired: number;
  blinkCd: number;
  hitR2: number;
  /** Body scale — the beam eye rides at EYE_HEIGHT·radius (the client
   *  renders it there), so ubers muzzle higher than the base obelisk. */
  radius: number;
  /** Locked beam — committed at charge start, both sides replay the same
   *  line. lockDist = terrain-clipped beam length. */
  lockDirX: number; lockDirY: number; lockDirZ: number;
  lockDist: number;
  /** Blink destination — committed at blink decision, snapped on exit. */
  blinkX: number; blinkY: number; blinkZ: number;
}

export function isTotemSpecies(species: string): boolean {
  return TOTEM_SPECIES[species] !== undefined;
}

export function makeSimTotem(
  id: number, x: number, y: number, z: number,
  uber: boolean, seed: number, species = 'totem',
): SimTotem {
  const row = TOTEM_SPECIES[species] ?? TOTEM_SPECIES.totem!;
  const health = uber ? row.health * 2.5 : row.health;
  const sp: TotemTunables = {
    ...TOTEM_SIM,
    REFIRE: uber ? TOTEM_UBER.REFIRE : TOTEM_SIM.REFIRE,
    CHARGE: uber ? TOTEM_UBER.CHARGE : TOTEM_SIM.CHARGE,
  };
  return {
    id, species, biteDamage: uber ? row.bite * 2 : row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'aim', hopTimer: 0, windupTimer: sp.REFIRE, stunTimer: 0,
    wanderYaw: 0, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    shotsFired: 0, blinkCd: 0,
    hitR2: uber ? TOTEM_UBER.HIT_R2 : TOTEM_SIM.HIT_R2,
    radius: uber ? 1.8 : 1.0, // UBER_TOTEM_RADIUS / TOTEM_RADIUS — config twins
    lockDirX: 0, lockDirY: 0, lockDirZ: 0, lockDist: 0,
    blinkX: x, blinkY: y, blinkZ: z,
  };
}

/** Terrain + structure LOS along the eye→target line — same 10-sample
 *  march the client Totem uses (flat bolts, terrain grazing matters),
 *  plus a yaw-OBB sweep so a wall inside the compound blocks the lock. */
function totemLineClear(
  c: SimTotem, field: Heightfield,
  tx: number, ty: number, tz: number,
  cols?: readonly StructureCollider[],
): boolean {
  const sy = c.y + c.sp.EYE_HEIGHT * c.radius;
  if (cols?.length &&
      segSolidHit({ x: c.x, y: sy, z: c.z }, { x: tx, y: ty, z: tz }, cols)) {
    return false;
  }
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const x = c.x + (tx - c.x) * t;
    const z = c.z + (tz - c.z) * t;
    const y = sy + (ty - sy) * t;
    if (y < hmHeight(field, x, z) + 0.4) return false;
  }
  return true;
}

/** Solve the committed beam: direction eye→lockPoint, length clipped by
 *  terrain at 1m resolution. Deterministic — both sides get the same
 *  line, which is what makes 'fire' a pure display edge. */
export function totemSolveBeam(
  c: SimTotem, field: Heightfield,
  lx: number, ly: number, lz: number,
  cols?: readonly StructureCollider[],
): void {
  const ex = c.x, ey = c.y + c.sp.EYE_HEIGHT * c.radius, ez = c.z;
  let dx = lx - ex, dy = ly - ey, dz = lz - ez;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
  dx /= d; dy /= d; dz /= d;
  c.lockDirX = dx; c.lockDirY = dy; c.lockDirZ = dz;
  c.lockDist = c.sp.RANGE;
  for (let t = 1; t <= c.sp.RANGE; t += 1) {
    const bx = ex + dx * t, by = ey + dy * t, bz = ez + dz * t;
    if (by < hmHeight(field, bx, bz)) { c.lockDist = t; break; }
  }
  // Structures clip the same line — a beam stopping at a face can't
  // resolve a victim behind it either way, authority or predictor.
  if (cols?.length) {
    const hit = segSolidHit(
      { x: ex, y: ey, z: ez },
      { x: ex + dx * c.lockDist, y: ey + dy * c.lockDist, z: ez + dz * c.lockDist },
      cols,
    );
    if (hit) c.lockDist = Math.min(c.lockDist, hit.t * c.lockDist);
  }
}

/** Does a point lie inside the fired beam's catch envelope? The authority
 *  runs this vs each player's LIVE position at the fire tick — dodging
 *  after the lock committed is the whole counterplay. */
export function totemBeamHit(c: SimTotem, px: number, py: number, pz: number): boolean {
  const ex = c.x, ey = c.y + c.sp.EYE_HEIGHT * c.radius, ez = c.z;
  const rx = px - ex, ry = py - ey, rz = pz - ez;
  const proj = rx * c.lockDirX + ry * c.lockDirY + rz * c.lockDirZ;
  if (proj <= 0 || proj >= c.lockDist) return false;
  const dx = rx - c.lockDirX * proj;
  const dy = ry - c.lockDirY * proj;
  const dz = rz - c.lockDirZ * proj;
  return dx * dx + dy * dy + dz * dz < c.hitR2;
}

/** Peak-seek: sample a terrain ring, pick the highest point that keeps
 *  firing range to the committed target. Seeded LCG — the predictor
 *  picks the identical perch. */
function totemPickBlink(c: SimTotem, field: Heightfield, tx: number, tz: number): void {
  let bestH = -Infinity;
  let found = false;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + crand(c) * 0.4;
    const r = 15 + crand(c) * c.sp.PEAK_RADIUS;
    const x = c.x + Math.cos(a) * r;
    const z = c.z + Math.sin(a) * r;
    const h = hmHeight(field, x, z);
    const pd = Math.hypot(tx - x, tz - z);
    if (pd > c.sp.RANGE * 0.9) continue;
    if (h > bestH) { bestH = h; c.blinkX = x; c.blinkY = h; c.blinkZ = z; found = true; }
  }
  const here = hmHeight(field, c.x, c.z);
  if (!found || bestH < here + c.sp.PEAK_MIN_GAIN) {
    // No worthwhile perch — flank the target instead.
    const a = crand(c) * Math.PI * 2;
    const r = 30 + crand(c) * 20;
    c.blinkX = tx + Math.cos(a) * r;
    c.blinkZ = tz + Math.sin(a) * r;
    c.blinkY = hmHeight(field, c.blinkX, c.blinkZ);
  }
}

export function stepTotem(
  c: SimTotem,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  authoritative: boolean,
  cols?: readonly StructureCollider[],
): CrawlerEvent | null {
  c.stunTimer = Math.max(0, c.stunTimer - dt);
  c.blinkCd = Math.max(0, c.blinkCd - dt);
  const distSq = target
    ? (target.x - c.x) ** 2 + (target.z - c.z) ** 2
    : Infinity;
  const dist = Math.sqrt(distSq);

  switch (c.state) {
    case 'aim': {
      c.windupTimer -= dt; // refire clock
      // Relocation checks — stagger (damage pin) and cooldown gate them.
      if (target && c.stunTimer <= 0 && c.blinkCd <= 0 &&
          (dist < c.sp.MIN_RANGE ||
           c.shotsFired >= c.sp.RELOCATE_SHOTS ||
           (c.windupTimer <= 0 && !totemLineClear(c, field, target.x, target.y, target.z, cols)))) {
        totemPickBlink(c, field, target.x, target.z);
        c.state = 'blinkOut';
        c.hopTimer = c.sp.BLINK_OUT_S;
        return 'blink';
      }
      if (target && c.windupTimer <= 0 && dist < c.sp.RANGE) {
        // Lock the line at the COMMITTED snapshot — the beam can't track,
        // and both sides replay the identical lock.
        c.state = 'charge';
        c.hopTimer = c.sp.CHARGE;
        totemSolveBeam(c, field, target.x, target.y, target.z, cols);
        return 'charge';
      }
      break;
    }
    case 'charge': {
      c.hopTimer -= dt;
      if (c.hopTimer <= 0) {
        c.state = 'aim';
        c.windupTimer = c.sp.REFIRE;
        c.shotsFired++;
        if (authoritative) c.pendingBite = true; // beam resolves in stepAll
        return 'fire';
      }
      break;
    }
    case 'blinkOut': {
      c.hopTimer -= dt;
      if (c.hopTimer <= 0) {
        c.x = c.blinkX; c.y = c.blinkY; c.z = c.blinkZ;
        c.y = hmHeight(field, c.x, c.z);
        c.state = 'blinkIn';
        c.hopTimer = c.sp.BLINK_IN_S;
      }
      break;
    }
    case 'blinkIn': {
      c.hopTimer -= dt;
      if (c.hopTimer <= 0) {
        c.state = 'aim';
        c.windupTimer = c.sp.REFIRE;
        c.shotsFired = 0;
        c.blinkCd = c.sp.BLINK_CD_MIN + crand(c) * c.sp.BLINK_CD_VAR;
        return 'land'; // arrival resync — shimmer ends
      }
      break;
    }
  }
  return null;
}

/** Beam-vs-player resolution at the 'fire' edge — the authority sweeps
 *  live player positions along the committed line. */
export function totemFireTargets(c: SimTotem, players: { id: string; pos: SimVec }[]): string[] {
  const hits: string[] = [];
  for (const p of players) {
    if (totemBeamHit(c, p.pos.x, p.pos.y + 1.0, p.pos.z)) hits.push(p.id); // +1 ≈ chest
  }
  return hits;
}

export function applyTotemDamage(c: SimTotem, damage: number): boolean {
  // Intangible mid-blink — matches the client's untargetable phases.
  if (c.state === 'blinkOut' || c.state === 'blinkIn') return false;
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, TOTEM_SIM.STAGGER_S); // pinned
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
