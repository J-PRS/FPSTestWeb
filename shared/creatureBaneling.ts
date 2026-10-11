/**
 * creatureBaneling — the sac: roller chassis, but the pop IS the attack.
 * No bite cooldown — a fuse (3D proximity) or a lifetime clock emits
 * 'detonate', the one new edge kind on the wire, and the authority maps
 * it to an AOE blast + crawlDie. Shooting it pops it the same way, which
 * is the counterplay.
 */

import { type Heightfield, hmHeight, hmChord } from './heightfield.js';
import type { SimVec, StructureCollider } from './ballSim.js';
import { clipMotion, type CrawlerEvent, type SimCrawler } from './creatureCore.js';
import { SPECIES, speciesFamily, type SpeciesRow } from './species.js';
import { inv } from './invariants.js';

export const BANELING_SIM = {
  ACCEL: 22,
  TOPSPEED: 20,
  AGGRO_D2: 140 * 140,   // born homing — a wide chase envelope
  // Player capsule + sac radius stop it ~3m out via clipMotion — the fuse
  // must cover contact distance, else it orbits the body and never pops.
  FUSE_D2: 4.2 * 4.2,    // 3D proximity pop (includes body radii)
  LIFE_S: 25,          // self-detonates eventually
  STUN_S: 0.3,           // a hit staggers the fuse run
} as const;

// Baneling rows live in the unified SPECIES registry; derived view.
export const BANELING_SPECIES: Record<string, SpeciesRow> = Object.fromEntries(
  Object.entries(SPECIES).filter(([, r]) => r.family === 'baneling'),
);

export type BanelingState = 'chase';

type BanelingTunables = { readonly [K in keyof typeof BANELING_SIM]: number };

export interface SimBaneling extends Omit<SimCrawler, 'state' | 'sp' | 'family'> {
  family: 'baneling';
  state: BanelingState;
  sp: BanelingTunables;
  age: number;          // fuse life clock — deterministic, drives the pop
  blastRadius: number;  // authority reads this for the AOE sweep
}

export function isBanelingSpecies(species: string): boolean {
  return speciesFamily(species) === 'baneling';
}

export function makeSimBaneling(
  id: number, pos: SimVec, uber: boolean, seed: number, species = 'baneling',
): SimBaneling {
  const { x, y, z } = pos;
  const row = SPECIES[species] ?? SPECIES.baneling!;
  const health = uber ? row.health * 4 : row.health;
  const sp: BanelingTunables = { ...BANELING_SIM, TOPSPEED: BANELING_SIM.TOPSPEED * (row.speed ?? 1),ACCEL: BANELING_SIM.ACCEL * (row.speed ?? 1)};
  return {
    id, family: 'baneling', species, biteDamage: uber ? row.bite * 2 : row.bite, sp,
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
    state: 'chase', hopTimer: 0, windupTimer: 0, stunTimer: 0,
    wanderYaw: (seed % 628) / 100, health, maxHealth: health,
    uber, dead: false, rng: seed >>> 0 || 1,
    targetId: null, tx: 0, ty: 0, tz: 0, tgtValid: false, pendingBite: false,
    age: 0, blastRadius: uber ? (row.blast ?? 0) * 1.7 : (row.blast ?? 0),
  };
}

export function stepBaneling(
  c: SimBaneling,
  dt: number,
  field: Heightfield,
  target: SimVec | null,
  _authoritative: boolean,
  cols?: readonly StructureCollider[],
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
    // Terminal homing: inside the last stretch, bleed sideways speed so the
    // sac settles onto the target instead of orbiting it at TOPSPEED and
    // never entering fuse range.
    if (aggro && d < 12) {
      const drag = Math.min(1, 6 * dt);
      c.vx *= 1 - drag;
      c.vz *= 1 - drag;
      const s = Math.min(c.sp.TOPSPEED, d * 4 + 1);
      if (d > 0.01) { c.vx += (dx / d) * s; c.vz += (dz / d) * s; }
    }
  }

  const hSpeed = Math.hypot(c.vx, c.vz);
  if (hSpeed > c.sp.TOPSPEED) {
    const s = c.sp.TOPSPEED / hSpeed;
    c.vx *= s; c.vz *= s;
  }

  const bpx = c.x, bpz = c.z;
  c.x += c.vx * dt;
  c.z += c.vz * dt;
  clipMotion(c, bpx, c.y, bpz, cols);
  c.y = Math.max(hmHeight(field, c.x, c.z), hmChord(field, c.x, c.z)) + 0.7; // small sac, low ride
  if (hSpeed > 0.5) {c.yaw = Math.atan2(c.vx, c.vz);}

  if (target) {
    const d3 = (target.x - c.x) ** 2 + (target.y - c.y) ** 2 + (target.z - c.z) ** 2;
    if (d3 < c.sp.FUSE_D2) { c.dead = true; return 'detonate'; }
  }
  if (c.age >= c.sp.LIFE_S) { c.dead = true; return 'detonate'; }
  return null;
}

export function applyBanelingDamage(c: SimBaneling, damage: number): boolean {
  if (!Number.isFinite(damage)) { inv('creature-damage-finite', false, { damage, kind: 'baneling' }); return false; }
  c.health -= damage;
  c.stunTimer = Math.max(c.stunTimer, c.sp.STUN_S);
  if (c.health <= 0) { c.dead = true; return true; }
  return false;
}
