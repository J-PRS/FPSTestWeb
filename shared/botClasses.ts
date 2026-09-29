/** Armor classes — the Tribes light/medium/heavy split, applied to bot
 *  loadouts (and later player loadout picks). Numbers are relative to
 *  CONFIG.playerMaxHealth: light trades bulk for ground speed, heavy is
 *  the anchor that tanks the stand. Ski momentum and jet thrust are
 *  class-free — only foot speed and hit points differentiate. */
export type ArmorClass = 'light' | 'medium' | 'heavy';

export interface ClassStats { maxHealth: number; speedScale: number }

export const CLASS_STATS: Record<ArmorClass, ClassStats> = {
  light:  { maxHealth: -25, speedScale: 1.18 },
  medium: { maxHealth: 0,   speedScale: 1.0 },
  heavy:  { maxHealth: 50,  speedScale: 0.78 },
};
