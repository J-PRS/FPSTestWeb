/**
 * Pickup/drop kinds — server-owned ground loot. Gems/tags are scoring
 * tokens (team modes); the rest are powerups that apply to whoever grabs
 * them, in any mode. One table owns both the wire `kind` strings and the
 * effect numbers so client colors and server tuning stay in lockstep.
 */
export type PickupKind = 'gem' | 'tag' | 'heal' | 'armor' | 'regen' | 'dd';
export type PowerupKind = Exclude<PickupKind, 'gem' | 'tag'>;

/** Blast-tumble physics for knocked pickups — RoomPickups runs this
 *  integrator and the client replica MUST match: the server publishes the
 *  rest position when it settles, so any divergence is a guaranteed
 *  snap-back (the parity 'nugrest' counter). */
export const NUG_TUMBLE = {
  friction: 4,      // velocity bleed per second — gems skid, not slide
  groundLift: 0.5,  // rest height above the heightfield
  settle: 0.5,      // per-axis speed below which the tumble ends
  upPop: 0.4,       // up-kick as a fraction of the blast impulse
} as const;

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

/** Roll a creature-kill drop; null = no powerup this kill. Rolls are
 *  REQUIRED — a default Math.random here is a silent desync source. */
export function rollCreatureDrop(r0: number, r1: number): PowerupKind | null {
  if (r0 >= POWERUP.dropChance) return null;
  let acc = 0;
  const roll = r1 * TOTAL_W;
  for (const [kind, w] of WEIGHTS) {
    acc += w;
    if (roll < acc) return kind;
  }
  return 'heal';
}
