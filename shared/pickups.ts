/**
 * Pickup/drop kinds — server-owned ground loot. Gems/tags are scoring
 * tokens (team modes); the rest are powerups that apply to whoever grabs
 * them, in any mode. One table owns both the wire `kind` strings and the
 * effect numbers so client colors and server tuning stay in lockstep.
 */
export type PickupKind = 'gem' | 'tag' | 'heal' | 'armor' | 'regen' | 'dd';
export type PowerupKind = Exclude<PickupKind, 'gem' | 'tag'>;

export const POWERUP = {
  heal: 50,           // flat hp on grab
  armor: 100,         // flat armor on grab (caps at maxArmor)
  maxArmor: 100,
  armorAbsorb: 0.8,   // armor eats 80% of incoming damage, 20% leaks to hp
  regenHpPerSec: 5,
  regenMs: 10_000,
  ddMult: 2,
  ddMs: 10_000,
  /** Fraction of creature kills that drop a powerup at all. */
  dropChance: 0.35,
} as const;

// Weighted drop table — sustain drops (heal) are most common, combat
// multipliers (dd) rarest.
const WEIGHTS: [PowerupKind, number][] = [
  ['heal', 4],
  ['armor', 3],
  ['regen', 3],
  ['dd', 2],
];
const TOTAL_W = WEIGHTS.reduce((a, [, w]) => a + w, 0);

/** Roll a creature-kill drop; null = no powerup this kill. */
export function rollCreatureDrop(r0: number = Math.random(), r1: number = Math.random()): PowerupKind | null {
  if (r0 >= POWERUP.dropChance) return null;
  let acc = 0;
  const roll = r1 * TOTAL_W;
  for (const [kind, w] of WEIGHTS) {
    acc += w;
    if (roll < acc) return kind;
  }
  return 'heal';
}
