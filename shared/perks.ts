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

export type PerkId = 'none' | 'featherjets' | 'plated' | 'vitality' | 'regenerator' | 'overcharge' | 'sharpshooter' | 'bombardier' | 'juggernaut' | 'scavenger' | 'lightfoot' | 'airtank' | 'reach';

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
  /** Extra regen accrued per unhurt second (ramps up the longer you go untouched). */
  regenRamp: number;
  /** Energy pool recharge multiplier (cloak/shield/mend all share it). */
  energyRegen: number;
  /** Direct-hit damage multiplier (1.2 = +20% on hits that land dead-on). */
  directDamage: number;
  /** Blast radius multiplier — NOT damage (0.6 = tighter boom). */
  aoeRadius: number;
  /** Knockback impulse taken multiplier (0.6 = hard to push around). */
  knockbackTaken: number;
  /** Self-heal pickup effectiveness (1.5 = nuggets patch 50% more). */
  healBoost: number;
  /** Damage taken from your own blasts (0.5 = disc-jumps half price). */
  selfDamage: number;
  /** Energy pool multiplier (1.5 = cloak/shield/mend last half again as long). */
  energyMax: number;
  /** Pickup + flag touch radius multiplier (1.25 = grab a quarter farther out). */
  pickupRadius: number;
}

const ZERO: PerkMods = { jetDrain: 1, jetRegen: 1, damageResist: 0, maxHealth: 0, regen: 0, regenRamp: 0, energyRegen: 1, directDamage: 1, aoeRadius: 1, knockbackTaken: 1, healBoost: 1, selfDamage: 1, energyMax: 1, pickupRadius: 1 };

export const PERKS: Record<PerkId, { name: string; blurb: string; mods: Partial<PerkMods> }> = {
  none:        { name: 'No Perk',     blurb: '', mods: {} },
  featherjets: { name: 'Featherjets', blurb: 'Jets burn 20% less', mods: { jetDrain: 0.8 } },
  plated:      { name: 'Plated',      blurb: 'Take 25% less damage below 80% health', mods: { damageResist: 0.25 } },
  vitality:    { name: 'Vitality',    blurb: '+50 max health', mods: { maxHealth: 50 } },
  regenerator: { name: 'Regenerator', blurb: 'Regenerate 4 hp/s', mods: { regen: 4 } },
  overcharge:  { name: 'Overcharge',  blurb: 'Energy recharges 50% faster', mods: { energyRegen: 1.5 } },
  sharpshooter:{ name: 'Sharpshooter',blurb: '+20% direct hits, −40% blast radius', mods: { directDamage: 1.2, aoeRadius: 0.6 } },
  bombardier:  { name: 'Bombardier',  blurb: '+40% blast radius, −15% direct hits', mods: { directDamage: 0.85, aoeRadius: 1.4 } },
  juggernaut:  { name: 'Juggernaut',  blurb: 'Take 80% less knockback', mods: { knockbackTaken: 0.2 } },
  scavenger:   { name: 'Scavenger',   blurb: 'Pickups heal 50% more', mods: { healBoost: 1.5 } },
  lightfoot:   { name: 'Lightfoot',   blurb: 'Own blasts deal 50% less self-damage', mods: { selfDamage: 0.5 } },
  airtank:     { name: 'Airtank',     blurb: '+50% energy pool', mods: { energyMax: 1.5 } },
  reach:       { name: 'Reach',       blurb: 'Grab pickups and flags from 25% farther', mods: { pickupRadius: 1.25 } },
};

export const PERK_ORDER: PerkId[] = ['none', 'featherjets', 'plated', 'vitality', 'regenerator', 'overcharge', 'sharpshooter', 'bombardier', 'juggernaut', 'scavenger', 'lightfoot', 'airtank', 'reach'];

export function perkMods(id: string | undefined | null): PerkMods {
  const p = PERKS[(id ?? 'none') as PerkId];
  return p ? { ...ZERO, ...p.mods } : { ...ZERO };
}

/** Plated is an underdog plate — resist only counts below 80% max HP,
 *  so a big hit on a healthy target punches straight through it. */
export function effectiveResist(mods: PerkMods, health: number, maxHealth: number): number {
  return health < maxHealth * 0.8 ? mods.damageResist : 0;
}

export function isPerkId(s: unknown): s is PerkId {
  return typeof s === 'string' && s in PERKS;
}
