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
  light:  { maxHealth: -25, speedScale: 1.2, mass: 1.25, eyeHeight: 1.8, radius: 0.5 },
  medium: { maxHealth: 0,   speedScale: 1.0,  mass: 1.5,  eyeHeight: 2.0, radius: 0.65 },
  heavy:  { maxHealth: 50,  speedScale: 0.8, mass: 2.0, eyeHeight: 2.5, radius: 0.8 },
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
