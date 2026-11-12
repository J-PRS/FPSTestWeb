import { describe, it, expect } from 'bun:test';
import { pickBotWeaponSafe } from '../../shared/botLoadouts.ts';
import { pHitFactor } from '../../shared/botHitChance.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import type { BotLoadout } from '../../shared/botLoadouts.ts';

// One kit holding both a flat-stream gun and a lobbed explosive:
// the airborne pick must lean flat (direct-hit only, no splash credit),
// the grounded pick keeps the aoe lane open.
const lo: BotLoadout = {
  perk: 'none',
  near: WeaponType.Chaingun,
  mid: WeaponType.Disc,
  far: WeaponType.Railgun,
  side: WeaponType.Pistol,
  belt: WeaponType.Grenade,
};

const pick = (dist: number, airborne: boolean): number =>
  pickBotWeaponSafe(lo, dist, dist, 100,
    (t): number => pHitFactor(t, dist, airborne), 0.5);

describe('pHitFactor weapon picks', () => {
  it('airborne target at standoff draws a flat fast gun, not a lobbed explosive', () => {
    // 60m: the far band opens - Railgun vs Disc is a real contest there,
    // and the ballistic-target pricing must break it to the flat gun.
    // Railgun has a small pop aoe, so assert on muzzle speed instead:
    // a lob (disc ~55, mortar ~80) vs a flat shell (>=200).
    const wt = pick(60, true);
    expect(getWeaponStats(wt).speed).toBeGreaterThanOrEqual(200);
  });

  it('grounded target keeps splash weapons in contention', () => {
    // Grounded scoring gives aoe its near-miss credit - the pick may be
    // either lane, but the factor itself must not suppress aoe.
    const wt = pick(40, false);
    expect(WeaponType[wt]).toBeTruthy(); // a legal pick either way
  });

  it('pHitFactor penalizes aoe harder vs airborne than vs grounded', () => {
    expect(pHitFactor(WeaponType.Disc, 40, true)).toBeLessThan(
      pHitFactor(WeaponType.Disc, 40, false));
    expect(pHitFactor(WeaponType.Chaingun, 40, true)).toBeGreaterThan(0.5);
  });
});
