// Hit-probability scoring for weapon picks: P(hit) estimated from
// flight-time error vs splash allowance, so situational weapon choice
// falls out of physics instead of a lookup table. Composed into the
// pick's skill(w) scorer by each host's arsenal.
import { getWeaponStats } from './weapons.ts';

/** Multiplier on a weapon's pick score for the CURRENT target.
 *  airborne: ballistic target - future pos deterministic, but splash
 *  can't help midair (no ground to catch near-misses), so only direct
 *  connects count; fast flat guns price that, lobbed explosives must
 *  nail the solve. grounded: dodge uncertainty rises but aoe converts
 *  near-misses into damage - the splash credit. */
export function pHitFactor(w: number, dist: number, airborne: boolean): number {
  const st = getWeaponStats(w);
  if (!st || st.speed <= 0) {return 1;}
  // Lateral aim error scales with shell time - the longer the shell
  // flies, the more the target's own velocity drags the miss. ~2.5m of
  // drift per second of flight, tuned to jitter01-scale error.
  const err = (dist / st.speed) * 2.5;
  if (airborne) {
    return st.aoeRadius > 0
      ? 1 / (1 + err * 3)    // air-shot explosive: P(direct) only
      : 1 / (1 + err * 0.4); // flat fast: stays on a ballistic path
  }
  return st.aoeRadius > 0
    ? 1 + Math.min(0.6, st.aoeRadius * 0.03)
    : 1 / (1 + err * 0.8);
}
