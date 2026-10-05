import { describe, test, expect } from 'bun:test';
import {
  WEAPONS,
  WeaponType,
  scaledDirectDamage,
  directHitAoeBonus,
  beltThrowCost,
  MAX_HIT_CLAIM_DMG,
  getWeaponStats,
  BELT_THROW_WEAPONS,
  BELT_THROW_COST,
  WEAPON_FIRE_INTERVAL_S,
  AIRTIME_DMG_CAP,
} from '../../shared/weapons.ts';

// The weapon table is THE wire-authoritative contract: every claim
// ceiling, cadence gate, and airtime ramp re-derives from it on the
// server. A silent table drift is a silent desync, so the derivations
// are pinned, not just the constants.
describe('weapons', () => {
  test('scaledDirectDamage ramps +50% per 0.5s on airtime-scaled weapons', () => {
    const base = WEAPONS[WeaponType.BoltLauncher]!.directDamage;
    expect(scaledDirectDamage(WeaponType.BoltLauncher, 0.5)).toBe(base * 1.5);
    expect(scaledDirectDamage(WeaponType.BoltLauncher, 2.0)).toBe(base * 3);
  });

  test('airtime ramp caps at AIRTIME_DMG_CAP', () => {
    const base = WEAPONS[WeaponType.Disc]!.directDamage;
    expect(scaledDirectDamage(WeaponType.Disc, 99)).toBe(base * AIRTIME_DMG_CAP);
    expect(scaledDirectDamage(WeaponType.Disc, 2.0)).toBe(base * 3);
  });

  test('non-scaled weapons ignore airtime entirely', () => {
    const w = WEAPONS[WeaponType.Chaingun]!;
    expect(scaledDirectDamage(WeaponType.Chaingun, 9)).toBe(w.directDamage);
  });

  test('missing or zero airtime returns flat directDamage', () => {
    const w = WEAPONS[WeaponType.BoltLauncher]!;
    expect(scaledDirectDamage(WeaponType.BoltLauncher)).toBe(w.directDamage);
    expect(scaledDirectDamage(WeaponType.BoltLauncher, 0)).toBe(w.directDamage);
    expect(scaledDirectDamage(WeaponType.BoltLauncher, -1)).toBe(w.directDamage);
  });

  test('unknown weaponType returns 0 — a doctored claim can\'t inherit damage', () => {
    expect(scaledDirectDamage(9999, 5)).toBe(0);
  });

  test('directHitAoeBonus only blooms canonical launchers', () => {
    expect(directHitAoeBonus(WeaponType.BoltLauncher)).toBeGreaterThan(1);
    expect(directHitAoeBonus(WeaponType.Disc)).toBeGreaterThan(1);
    expect(directHitAoeBonus(WeaponType.Mortar)).toBe(1);
    expect(directHitAoeBonus(WeaponType.Javelin)).toBe(1);
  });

  test('beltThrowCost: SatchelCharge pays 2, every other throw pays flat cost', () => {
    expect(beltThrowCost(WeaponType.SatchelCharge)).toBe(2);
    expect(beltThrowCost(WeaponType.Grenade)).toBe(BELT_THROW_COST);
    expect(beltThrowCost(WeaponType.Javelin)).toBe(BELT_THROW_COST);
    expect(beltThrowCost(WeaponType.BoltLauncher)).toBe(BELT_THROW_COST);
  });

  test('Sticky stays out of BELT_THROW_WEAPONS — launcher and toss share a type', () => {
    expect(BELT_THROW_WEAPONS.has(WeaponType.Sticky)).toBe(false);
    expect(BELT_THROW_WEAPONS.has(WeaponType.Grenade)).toBe(true);
    expect(BELT_THROW_WEAPONS.has(WeaponType.Concussion)).toBe(true);
  });

  test('MAX_HIT_CLAIM_DMG covers the widest honest single claim incl airtime cap', () => {
    // Re-derive: every legal single-hit claim (max scaled direct + splash)
    // must fit under the ceiling, and the ceiling must stay integer.
    const widest = Math.max(
      ...Object.entries(WEAPONS).map(([wt, w]) =>
        scaledDirectDamage(Number(wt), 99) + w.aoeDamage));
    expect(MAX_HIT_CLAIM_DMG).toBeGreaterThanOrEqual(widest);
    expect(MAX_HIT_CLAIM_DMG).toBe(Math.ceil(widest * 1.4));
    expect(Number.isInteger(MAX_HIT_CLAIM_DMG)).toBe(true);
  });

  test('getWeaponStats falls back to BoltLauncher for undefined/unknown', () => {
    expect(getWeaponStats(undefined)).toBe(WEAPONS[WeaponType.BoltLauncher]!);
    expect(getWeaponStats(9999)).toBe(WEAPONS[WeaponType.BoltLauncher]!);
    expect(getWeaponStats(WeaponType.Mortar)).toBe(WEAPONS[WeaponType.Mortar]!);
  });

  test('fire cadences: mortars fire slower than bolts, HealBeam ticks at 0.1s', () => {
    expect(WEAPON_FIRE_INTERVAL_S[WeaponType.Mortar]).toBeGreaterThan(
      WEAPON_FIRE_INTERVAL_S[WeaponType.BoltLauncher]!);
    expect(WEAPON_FIRE_INTERVAL_S[WeaponType.HealBeam]).toBe(0.1);
    for (const [wt, s] of Object.entries(WEAPON_FIRE_INTERVAL_S)) {
      expect(s).toBeGreaterThan(0);
      expect(Number.isFinite(s)).toBe(true);
      expect(WEAPONS[Number(wt)]).toBeDefined();
    }
  });
});
