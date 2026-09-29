/** Armor classes — the Tribes light/medium/heavy split, applied to bot
 *  loadouts (and later player loadout picks). Numbers are relative to
 *  CONFIG.playerMaxHealth: light trades bulk for ground speed, heavy is
 *  the anchor that tanks the stand. Ski momentum and jet thrust are
 *  class-free — only foot speed and hit points differentiate. */
export type ArmorClass = 'light' | 'medium' | 'heavy';

export interface ClassStats { maxHealth: number; speedScale: number }

/** Tier-locked ordnance — WeaponType ids only heavies may fire (Mortar,
 *  PlasmaCannon, RocketLauncher). Enforced server-side in CombatHandler;
 *  the loadout menu filter is a convenience, not a boundary. */
export const HEAVY_ONLY_WEAPONS: ReadonlySet<number> = new Set([4, 7, 15]);

/** Silhouette bump per tier — one cast (mannequin), class reads as bulk:
 *  heavy a 15% taller/broader frame, light a leaner one. Shared so remotes
 *  and the local body agree. */
export const CLASS_MODEL_SCALE: Record<ArmorClass, number> = {
  light: 0.92, medium: 1.0, heavy: 1.15,
};

export const CLASS_STATS: Record<ArmorClass, ClassStats> = {
  light:  { maxHealth: -25, speedScale: 1.18 },
  medium: { maxHealth: 0,   speedScale: 1.0 },
  heavy:  { maxHealth: 50,  speedScale: 0.78 },
};
