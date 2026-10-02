/** Armor classes — the Tribes light/medium/heavy split, applied to bot
 *  loadouts (and later player loadout picks). Numbers are relative to
 *  CONFIG.playerMaxHealth: light trades bulk for ground speed, heavy is
 *  the anchor that tanks the stand. Mass is now real too: jet thrust and
 *  blast impulses divide by it, so the mech anchor that shrugs off
 *  shoves also burns more sky per drop of fuel. */
import { PLAYER_RADIUS } from './constants.ts';

export type ArmorClass = 'light' | 'medium' | 'heavy';

export interface ClassStats {
  maxHealth: number;
  speedScale: number;
  /** Sim mass — jet thrust and knockback impulses divide by it. */
  mass: number;
  /** Eye height above feet — the networked pos.y IS the eye point, so
   *  this is also the body's grounded stand height. */
  eyeHeight: number;
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
  light:  { maxHealth: -25, speedScale: 1.18, mass: 0.75, eyeHeight: 1.8 },
  medium: { maxHealth: 0,   speedScale: 1.0,  mass: 1.0,  eyeHeight: 2.0 },
  heavy:  { maxHealth: 50,  speedScale: 0.78, mass: 1.25, eyeHeight: 2.5 },
};

/** Headroom above the eye — the helmet must live inside the capsule. */
const HEADROOM = 0.2;

/** Per-class hit capsule derived from the eye height. `centerOff` is the
 *  capsule center's offset FROM the eye position (always negative —
 *  the axis midpoint sits below the eyes); `half` is the cylinder
 *  half-height. Radius stays shared: bulk reads through height. */
export function classCapsule(cls?: string): { eye: number; height: number; centerOff: number; half: number } {
  const eye = cls === 'light' || cls === 'medium' || cls === 'heavy'
    ? CLASS_STATS[cls].eyeHeight : CLASS_STATS.medium.eyeHeight;
  const height = eye + HEADROOM;
  return { eye, height, centerOff: height / 2 - eye, half: Math.max(0, (height - 2 * PLAYER_RADIUS) / 2) };
}

/** Sim mass for impulse scaling — jets and blast shoves divide by it. */
export function classMass(cls?: string): number {
  return cls === 'light' || cls === 'medium' || cls === 'heavy' ? CLASS_STATS[cls].mass : 1;
}
