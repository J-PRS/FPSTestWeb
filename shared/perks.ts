/**
 * Perk table — passive loadout modifiers. One perk per player, chosen in
 * the loadout UI and announced at join (`join.perk`) so the SERVER can
 * enforce the mechanics it owns: damage resist applies in applyDamage,
 * max health sets the heal/spawn cap, passive regen ticks in GameServer.
 *
 * All numbers are modifiers on the base values in client/core/config.ts —
 * multipliers default to 1, additive fields to 0. A new perk is one row
 * here + its modifiers being read where they apply (they're looked up by
 * name, never scattered).
 */

export type PerkId = 'none' | 'featherjets' | 'plated' | 'vitality' | 'regenerator' | 'overcharge';

export interface PerkMods {
  /** Jet fuel burn multiplier (1 = normal, 0.7 = 30% thriftier). */
  jetDrain: number;
  /** Jet fuel recharge multiplier while off the jet. */
  jetRegen: number;
  /** Fraction of incoming damage ignored (0.25 = quarter resist). */
  damageResist: number;
  /** Flat bonus to max health. */
  maxHealth: number;
  /** Passive health regen, hp per second. */
  regen: number;
  /** Energy pool recharge multiplier (cloak/shield/mend all share it). */
  energyRegen: number;
}

const ZERO: PerkMods = { jetDrain: 1, jetRegen: 1, damageResist: 0, maxHealth: 0, regen: 0, energyRegen: 1 };

export const PERKS: Record<PerkId, { name: string; blurb: string; mods: Partial<PerkMods> }> = {
  none:        { name: 'No Perk',     blurb: '', mods: {} },
  featherjets: { name: 'Featherjets', blurb: 'Jets burn 30% less, recharge 50% faster', mods: { jetDrain: 0.7, jetRegen: 1.5 } },
  plated:      { name: 'Plated',      blurb: 'Take 25% less damage', mods: { damageResist: 0.25 } },
  vitality:    { name: 'Vitality',    blurb: '+50 max health', mods: { maxHealth: 50 } },
  regenerator: { name: 'Regenerator', blurb: 'Regenerate 4 hp/s', mods: { regen: 4 } },
  overcharge:  { name: 'Overcharge',  blurb: 'Energy recharges 50% faster', mods: { energyRegen: 1.5 } },
};

export const PERK_ORDER: PerkId[] = ['none', 'featherjets', 'plated', 'vitality', 'regenerator', 'overcharge'];

export function perkMods(id: string | undefined | null): PerkMods {
  const p = PERKS[(id ?? 'none') as PerkId];
  return p ? { ...ZERO, ...p.mods } : { ...ZERO };
}

export function isPerkId(s: unknown): s is PerkId {
  return typeof s === 'string' && s in PERKS;
}
