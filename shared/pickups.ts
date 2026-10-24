/**
 * Pickup/drop kinds — server-owned ground loot. Gems/tags are scoring
 * tokens (team modes); the rest are powerups that apply to whoever grabs
 * them, in any mode. One table owns both the wire `kind` strings and the
 * effect numbers so client colors and server tuning stay in lockstep.
 */
export type PickupKind = 'gem' | 'tag' | 'token' | 'heal' | 'armor' | 'regen' | 'dd';
// Tokens are held-score (headhunt), not a timed buff — they sit with
// gems/tags on the "score pickup" side of the kind split.
export type PowerupKind = Exclude<PickupKind, 'gem' | 'tag' | 'token'>;

/** Blast-tumble physics for knocked pickups — RoomPickups runs this
 *  integrator and the client replica MUST match: the server publishes the
 *  rest position when it settles, so any divergence is a guaranteed
 *  snap-back (the parity 'nugrest' counter). */
export const NUG_TUMBLE = {
  friction: 4,      // velocity bleed per second — gems skid, not slide
  groundLift: 0.5,  // rest height above the heightfield
  settle: 0.5,      // per-axis speed below which the tumble ends
  upPop: 0.4,       // up-kick as a fraction of the blast impulse
  restitution: 0.45, // vy bounce on terrain hits — a gem lands and hops, not sticks
} as const;

/** Headhunt denominations — base-3 coins so a hoard scatters a few
 *  readable objects instead of a confetti flood: a 40-token corpse is
 *  27+9+3+1, four coins, not forty. Color/size tier IS the value read
 *  at range — purple beams are jackpots. */
export const TOKEN_DENOMS = [
  { val: 27, color: 0xBB_66_FF, scale: 1.7 },  // purple
  { val: 9,  color: 0x3A_7A_FF, scale: 1.4 },  // blue
  { val: 3,  color: 0x44_FF_66, scale: 1.2 },  // green
  { val: 1,  color: 0xE8_E8_E8, scale: 1 },  // neutral white
] as const;

/** Display tier for a token's wire value — snaps odd values (thrown-in
 *  singles) to the largest denom they cover, never invents a tier. */
export function tokenTier(val: number): (typeof TOKEN_DENOMS)[number] {
  for (const d of TOKEN_DENOMS) {if (val >= d.val) {return d;}}
  return TOKEN_DENOMS[TOKEN_DENOMS.length - 1]!;
}

/** Greedy base-3 split — always exact (the 1-coin is the unit) and
 *  near-minimal coin count. */
export function decomposeTokens(n: number): number[] {
  const out: number[] = [];
  for (const d of TOKEN_DENOMS) {
    while (n >= d.val) { out.push(d.val); n -= d.val; }
  }
  return out;
}

/** Headhunt hoard-buffs — the walking jackpot pays for the target it
 *  paints on itself. Tiers unlock at denomination thresholds and rates
 *  scale with held count, but EVERY channel mutes for graceMs after the
 *  carrier takes a hit — the buff is sustain, not tanking. */
export const HELD_BUFF = {
  graceMs: 8000,        // last damage inside this → no regen at all
  hpAt: 3,               // green tier: held >= 3 → hp/s
  armorAt: 9,            // blue tier:  held >= 9 → + armor/s
  beltAt: 27,            // purple:    held >= 27 → + belt charges
  hpPerSec: 1,           // × held — flat 1 hp/s per token, no cap
  armorPerSec: 1,        // × held — the hoard IS the armor battery
  beltPerSec: 0.025,     // × held — 27 held ≈ 1 charge/1.5s
} as const;

/** Per-second hold-buff rates for a carrier; all-zero inside the
 *  post-damage grace window. Shared so server truth and client
 *  prediction compute the same drip. `sinceHitMs` = now - lastDamageAt. */
export function heldBuffRates(held: number, sinceHitMs: number): { hp: number; armor: number; belt: number } {
  if (held < HELD_BUFF.hpAt || sinceHitMs < HELD_BUFF.graceMs) {return { hp: 0, armor: 0, belt: 0 };}
  return {
    hp: held * HELD_BUFF.hpPerSec,
    armor: held >= HELD_BUFF.armorAt ? held * HELD_BUFF.armorPerSec : 0,
    belt: held >= HELD_BUFF.beltAt ? held * HELD_BUFF.beltPerSec : 0,
  };
}

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
const TOTAL_W = WEIGHTS.reduce((a, [, w]): number => a + w, 0);

/** Roll a creature-kill drop; null = no powerup this kill. Rolls are
 *  REQUIRED — a default Math.random here is a silent desync source. */
export function rollCreatureDrop(r0: number, r1: number): PowerupKind | null {
  if (r0 >= POWERUP.dropChance) {return null;}
  let acc = 0;
  const roll = r1 * TOTAL_W;
  for (const [kind, w] of WEIGHTS) {
    acc += w;
    if (roll < acc) {return kind;}
  }
  return 'heal';
}
