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

export type PerkId = 'none' | 'featherjets' | 'plated' | 'lifesteal' | 'regenerator' | 'overcharge' | 'sharpshooter' | 'bombardier' | 'juggernaut' | 'scavenger' | 'lightfoot' | 'airtank' | 'reach' | 'featherfall' | 'jumpstart';

export interface PerkMods {
  /** Jet fuel burn multiplier (1 = normal, 0.7 = 30% thriftier). */
  jetDrain: number;
  /** Jet fuel recharge multiplier while off the jet. */
  jetRegen: number;
  /** Fraction of incoming damage ignored (0.25 = quarter resist). */
  damageResist: number;
  /** Flat bonus to max health. */
  maxHealth: number;
  /** Fraction of max health restored on a MELEE kill (1 = heal to full).
   *  Event-shaped survivability: hits-to-kill math never changes — the
   *  payoff only lands on a kill edge, not inside every hit. */
  meleeHeal: number;
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
  /** Fall-damage hp soaked per 1 energy burned (20 = a full tank eats
   *  1200hp of landings — double the shield skill's 10:1 rate).
   *  Soak happens before the damage funnel: a covered landing never
   *  fires a hit at all. */
  fallSoak: number;
  /** m/s launch granted on the ski-press edge, only while below the
   *  class walk cap (0 = no Jumpstart). A get-moving burst — at pace
   *  it does nothing, so it can't be milked for speed. */
  jumpstart: number;
}

const ZERO: PerkMods = { jetDrain: 1, jetRegen: 1, damageResist: 0, maxHealth: 0, meleeHeal: 0, regen: 0, regenRamp: 0, energyRegen: 1, directDamage: 1, aoeRadius: 1, knockbackTaken: 1, healBoost: 1, selfDamage: 1, energyMax: 1, pickupRadius: 1, fallSoak: 0, jumpstart: 0 };

/** Regenerator wind-up: the ramp only accrues after this many unhurt
 *  seconds — sustained combat denies the perk entirely instead of
 *  trickling between hits. Shared: server tick + client mirror. */
export const REGEN_DELAY_S = 5;

export const PERKS: Record<PerkId, { name: string; blurb: string; mods: Partial<PerkMods> }> = {
  none:        { name: 'No Perk',     blurb: '', mods: {} },
  featherjets: { name: 'Featherjets', blurb: 'Jets burn 20% less', mods: { jetDrain: 0.8 } },
  plated:      { name: 'Plated',      blurb: 'Take 40% less damage below 20% health', mods: { damageResist: 0.4 } },
  lifesteal:   { name: 'Lifesteal',   blurb: 'Melee kills heal to full, lance kills half', mods: { meleeHeal: 1 } },
  regenerator: { name: 'Regenerator', blurb: 'Regenerate up to 4 hp/s — kicks in after 5s unhurt, then ramps', mods: { regenRamp: 0.4 } },
  overcharge:  { name: 'Overcharge',  blurb: 'Energy recharges 50% faster', mods: { energyRegen: 1.5 } },
  sharpshooter:{ name: 'Sharpshooter',blurb: '+20% direct hits, −40% blast radius', mods: { directDamage: 1.2, aoeRadius: 0.6 } },
  bombardier:  { name: 'Bombardier',  blurb: '+40% blast radius, −25% direct hits', mods: { directDamage: 0.75, aoeRadius: 1.4 } },
  juggernaut:  { name: 'Juggernaut',  blurb: 'Take 80% less knockback', mods: { knockbackTaken: 0.2 } },
  scavenger:   { name: 'Scavenger',   blurb: 'Pickups heal 50% more', mods: { healBoost: 1.5 } },
  lightfoot:   { name: 'Lightfoot',   blurb: 'Own blasts deal 50% less self-damage', mods: { selfDamage: 0.5 } },
  airtank:     { name: 'Airtank',     blurb: '+50% energy pool', mods: { energyMax: 1.5 } },
  reach:       { name: 'Reach',       blurb: 'Grab pickups and flags from 25% farther', mods: { pickupRadius: 1.25 } },
  featherfall: { name: 'Featherfall', blurb: 'Fall damage energy shield, 20 hp per energy point', mods: { fallSoak: 20 } },
  jumpstart:   { name: 'Jumpstart',   blurb: 'Ski launch: pressing ski boosts +8 m/s, up to run speed +8', mods: { jumpstart: 8 } },
};

export const PERK_ORDER: PerkId[] = ['none', 'featherjets', 'plated', 'lifesteal', 'regenerator', 'overcharge', 'sharpshooter', 'bombardier', 'juggernaut', 'scavenger', 'lightfoot', 'airtank', 'reach', 'featherfall', 'jumpstart'];

export function perkMods(id: string | undefined | null): PerkMods {
  const p = PERKS[(id ?? 'none') as PerkId];
  return p ? Object.assign({}, ZERO, p.mods) : Object.assign({}, ZERO);
}

/** Plated is an underdog plate — resist only counts below 20% max HP,
 *  so it saves a nearly-dead carrier instead of soaking every mid-fight hit. */
export function effectiveResist(mods: PerkMods, health: number, maxHealth: number): number {
  return health < maxHealth * 0.2 ? mods.damageResist : 0;
}

export function isPerkId(s: unknown): s is PerkId {
  return typeof s === 'string' && s in PERKS;
}
