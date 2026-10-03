/** Armor classes — the Tribes light/medium/heavy split, applied to bot
 *  loadouts (and later player loadout picks). Numbers are relative to
 *  CONFIG.playerMaxHealth: light trades bulk for ground speed, heavy is
 *  the anchor that tanks the stand. Mass is now real too: jet thrust and
 *  blast impulses divide by it, so the mech anchor that shrugs off
 *  shoves also burns more sky per drop of fuel. */
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

/** Tier-locked ordnance — WeaponType ids only heavies may fire (Mortar,
 *  PlasmaCannon, RocketLauncher, MRVLauncher). Enforced server-side in
 *  CombatHandler; the loadout menu filter is a convenience, not a
 *  boundary. */
export const HEAVY_ONLY_WEAPONS: ReadonlySet<number> = new Set([4, 7, 15, 28]);

/** Medium-only guns (Flak, PlasmaGun) — the mid-tier punch. An EXACT-class
 *  lock like the light tier: heavies trade it away for ordnance access. */
export const MEDIUM_ONLY_WEAPONS: ReadonlySet<number> = new Set([6, 23]);

/** Light-only finesse weapons (Railgun, Lightning) — precision gear for
 *  the frame that paid HP for twitch; heavies get ordnance instead.
 *  Unlike the other tiers this is an EXACT-class lock, not a floor. */
export const LIGHT_ONLY_WEAPONS: ReadonlySet<number> = new Set([9, 12]);

const TIER_RANK: Record<ArmorClass, number> = { light: 0, medium: 1, heavy: 2 };

/** The lowest tier allowed to fire weapon `w` (WeaponType id). Light-only
 *  guns report 'light' — the floor IS the ceiling for them. */
export function minClassForWeapon(w: number): ArmorClass {
  return HEAVY_ONLY_WEAPONS.has(w) ? 'heavy' : MEDIUM_ONLY_WEAPONS.has(w) ? 'medium' : 'light';
}

/** Server-side boundary: may `cls` fire weapon `w`? Unknown class = medium,
 *  same default the rest of the class plumbing assumes. */
export function classCanFire(cls: string | undefined, w: number): boolean {
  const have = cls === 'light' || cls === 'heavy' ? cls : 'medium';
  if (LIGHT_ONLY_WEAPONS.has(w)) return have === 'light';
  if (MEDIUM_ONLY_WEAPONS.has(w)) return have === 'medium';
  return TIER_RANK[have] >= TIER_RANK[minClassForWeapon(w)];
}

/** Silhouette bump per tier — one cast (mannequin), class reads as bulk:
 *  heavy a 15% taller/broader frame, light a leaner one. Shared so remotes
 *  and the local body agree. */
export const CLASS_MODEL_SCALE: Record<ArmorClass, number> = {
  // Scaled to the class eye height (mannequin eye ≈1.8 at scale 1) so the
  // rendered skull sits where the hit capsule says the head is — a heavy
  // that LOOKED 1.15× but hit-tested 2.5m was a lie.
  light: 1.0, medium: 2.0 / 1.8, heavy: 2.5 / 1.8,
};

export const CLASS_STATS: Record<ArmorClass, ClassStats> = {
  // Mass is a dimensionless divisor (accel = force/m) shared by jets and
  // knockback. Every tier must stay under jetForceUp/gravity (35/28=1.25)
  // or the pack can't lift the chassis off a stand — heavy sits at 1.2,
  // the heaviest frame that still climbs. Lighter mass also means bigger
  // blast shoves, so the tier spread doubles as the shove gradient.
  light:  { maxHealth: -25, speedScale: 1.2, mass: 1.1,  eyeHeight: 1.8, radius: 0.5 },
  medium: { maxHealth: 25,  speedScale: 1.0,  mass: 1.15, eyeHeight: 2.0, radius: 0.65 },
  heavy:  { maxHealth: 100, speedScale: 0.8, mass: 1.2,  eyeHeight: 2.5, radius: 0.8 },
};

/** Headroom above the eye — the helmet must live inside the capsule. */
const HEADROOM = 0.2;

/** Per-class hit capsule derived from the eye height. `centerOff` is the
 *  capsule center's offset FROM the eye position (always negative —
 *  the axis midpoint sits below the eyes); `half` is the cylinder
 *  half-height; `radius` is the class's own half-width — every hit test
 *  and the bodyblock resolve read it, so a narrower class is harder to
 *  hit AND harder to block. */
export function classCapsule(cls?: string): { eye: number; height: number; centerOff: number; half: number; radius: number } {
  const st = cls === 'light' || cls === 'medium' || cls === 'heavy' ? CLASS_STATS[cls] : CLASS_STATS.medium;
  const height = st.eyeHeight + HEADROOM;
  return { eye: st.eyeHeight, height, centerOff: height / 2 - st.eyeHeight, half: Math.max(0, (height - 2 * st.radius) / 2), radius: st.radius };
}

/** Sim mass for impulse scaling — jets and blast shoves divide by it. */
export function classMass(cls?: string): number {
  return cls === 'light' || cls === 'medium' || cls === 'heavy' ? CLASS_STATS[cls].mass : 1;
}
