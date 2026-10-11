/** One heal-cap path — seven sites used to hand-roll
 *  `Math.min(maxHealth, health + amount)`; the over-cap armornade heal
 *  is the same formula with a raised ceiling. */
export interface HealthPool { health: number; maxHealth: number }

export function healPool(e: HealthPool, amount: number, cap = e.maxHealth): void {
  // min(cap, NaN) is NaN — a poisoned amount or pool would write NaN
  // health that no comparison downstream can rescue.
  if (!Number.isFinite(amount + e.health + cap)) {return;}
  e.health = Math.min(cap, e.health + amount);
}
