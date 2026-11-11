/** Armor classes — the Tribes light/medium/heavy split, applied to bot
 *  loadouts (and later player loadout picks). Numbers are relative to
 *  CONFIG.playerMaxHealth: light trades bulk for ground speed, heavy is
 *  the anchor that tanks the stand. Mass is now real too: jet thrust and
 *  blast impulses divide by it, so the mech anchor that shrugs off
 *  shoves also burns more sky per drop of fuel. */
import { WEAPONS } from './weaponRows.js';
import { WeaponType } from './weaponTable.js';

export type ArmorClass = 'light' | 'medium' | 'heavy';

export interface ClassStats {
  maxHealth: number;
  speedScale: number;
  /** Sim mass — jet thrust and knockback impulses divide by it. */
  mass: number;
  /** Eye height above feet — the networked pos.y IS the eye point, so
   *  this is also the body's grounded stand height. */
  eyeHeight: number;
  /** Hit/contact capsule half-width — narrow frames are harder to hit. */
  radius: number;
}

/** Tier-locked ordnance — derived from `tier` markers on the stat rows
 *  (weaponRows.ts); a new weapon declares its class in the row, never
 *  here. Enforced server-side in CombatHandler; the loadout menu filter
 *  is a convenience, not a boundary. */
const tierOf = (t: 'light' | 'medium' | 'heavy'): Set<number> =>
  new Set(Object.entries(WEAPONS).filter(([, w]) => w.tier === t).map(([wt]) => Number(wt)));
export const HEAVY_ONLY_WEAPONS: ReadonlySet<number> = tierOf('heavy');

/** Medium-only guns — the mid-tier punch. An EXACT-class lock like the
 *  light tier: heavies trade it away for ordnance access. */
export const MEDIUM_ONLY_WEAPONS: ReadonlySet<number> = tierOf('medium');

/** Light-only finesse weapons — precision gear for the frame that paid
 *  HP for twitch; heavies get ordnance instead. Exact-class like
 *  medium, NOT a floor (heavy is the only floor tier). */
export const LIGHT_ONLY_WEAPONS: ReadonlySet<number> = tierOf('light');

const TIER_RANK: Record<ArmorClass, number> = { light: 0, medium: 1, heavy: 2 };

/** Spawn-only types — child shells and skill pseudo-weapons, never a
 *  muzzle weapon. Without this fence a forged fire intent on one rides
 *  the default-light tier through every gate that whitelists on class. */
export const NEVER_FIRED: ReadonlySet<number> = new Set([
  WeaponType.ClusterBomblet,
  WeaponType.MRVBomblet,
  WeaponType.Slam,
]);

/** The lowest tier allowed to fire weapon `w` (WeaponType id). Light-only
 *  guns report 'light' — the floor IS the ceiling for them. */
export function minClassForWeapon(w: number): ArmorClass {
  if (HEAVY_ONLY_WEAPONS.has(w)) {return 'heavy';}
  if (MEDIUM_ONLY_WEAPONS.has(w)) {return 'medium';}
  return 'light';
}

/** Server-side boundary: may `cls` fire weapon `w`? Unknown class = medium,
 *  same default the rest of the class plumbing assumes. */
export function classCanFire(cls: string | undefined, w: number): boolean {
  if (NEVER_FIRED.has(w)) {return false;}
  const have = cls === 'light' || cls === 'heavy' ? cls : 'medium';
  if (LIGHT_ONLY_WEAPONS.has(w)) {return have === 'light';}
  if (MEDIUM_ONLY_WEAPONS.has(w)) {return have === 'medium';}
  return TIER_RANK[have] >= TIER_RANK[minClassForWeapon(w)];
}

/** Silhouette bump per tier — one cast (mannequin), class reads as bulk:
 *  heavy a 15% taller/broader frame, light a leaner one. Shared so remotes
 *  and the local body agree. */
export const CLASS_MODEL_SCALE: Record<ArmorClass, number> = {
  // Scaled to the class eye height (mannequin eye ≈1.8 at scale 1) so the
  // rendered skull sits where the hit capsule says the head is — a heavy
  // that LOOKED 1.15× but hit-tested 2.5m was a lie. Medium shares the
  // mannequin rig with light and gets a small silhouette bump so the
  // tier still reads at distance (capsule stays 2.0m, model ~2.07m).
  light: 1, medium: 2.07 / 1.8, heavy: 2.5 / 1.8,
};

export const CLASS_STATS: Record<ArmorClass, ClassStats> = {
  // Mass is a dimensionless divisor (accel = force/m) shared by jets and
  // knockback. Every tier must stay under jetForceUp/gravity (35/28=1.25)
  // or the pack can't lift the chassis off a stand — heavy sits at 1.2,
  // the heaviest frame that still climbs. Lighter mass also means bigger
  // blast shoves, so the tier spread doubles as the shove gradient.
  light:  { maxHealth: -25, speedScale: 14 / 12, mass: 1.1,  eyeHeight: 1.8, radius: 0.5 },
  medium: { maxHealth: 25,  speedScale: 11 / 12, mass: 1.15, eyeHeight: 2, radius: 0.65 },
  heavy:  { maxHealth: 100, speedScale: 8 / 12,  mass: 1.2,  eyeHeight: 2.5, radius: 0.8 },
};

/** Headroom above the eye — the helmet must live inside the capsule. */
const HEADROOM = 0.2;

/** Per-class hit capsule derived from the eye height. `centerOff` is the
 *  capsule center's offset FROM the eye position (always negative —
 *  the axis midpoint sits below the eyes); `half` is the cylinder
 *  half-height; `radius` is the class's own half-width — every hit test
 *  and the bodyblock resolve read it, so a narrower class is harder to
 *  hit AND harder to block. */
const capsuleCache = new Map<string, Readonly<{ eye: number; height: number; centerOff: number; half: number; radius: number }>>();
export function classCapsule(cls?: string): Readonly<{ eye: number; height: number; centerOff: number; half: number; radius: number }> {
  const key = cls === 'light' || cls === 'medium' || cls === 'heavy' ? cls : 'medium';
  let c = capsuleCache.get(key);
  if (!c) {
    const st = CLASS_STATS[key];
    const height = st.eyeHeight + HEADROOM;
    // Frozen — callers get the shared instance, so nobody may scribble.
    c = Object.freeze({ eye: st.eyeHeight, height, centerOff: height / 2 - st.eyeHeight, half: Math.max(0, (height - 2 * st.radius) / 2), radius: st.radius });
    capsuleCache.set(key, c);
  }
  return c;
}

/** Sim mass for impulse scaling - jets and blast shoves divide by it. */
export function classMass(cls?: string): number {
  return cls === 'light' || cls === 'medium' || cls === 'heavy' ? CLASS_STATS[cls].mass : 1;
}
