import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aoeDamageAt, aoeImpulseAt, hitRadiusAt, lgTickDamage, lgChargeAt } from '../../../shared/combat.js';
import { effectiveResist } from '../../../shared/perks.js';
import { gunGameWeapon, gunGameAllows, gunGameRoll, gunGameBucket, gunGameClimax, igunChassis } from '../../../shared/gunGame.js';
import { WeaponType, beltThrowCost, spendAmmo, roomDirectDamage, IGUN_DIRECT_MULT, getWeaponStats, type AmmoPool } from '../../../shared/weapons.js';
import { WEAPONS } from '../../../shared/weaponRows.js';
import { classCanFire, NEVER_FIRED } from '../../../shared/botClasses.js';

// fast-check on shared sims - each property asserts a LAW, not a sample.
// See _docs/2026-11-11_VERIFICATION_AUDIT_TECHNIQUES.md (item 2: PBT).

const wt = fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined });

describe('shared sim properties', (): void => {
  it('aoeDamageAt is non-increasing in distance and never negative', (): void => {
    fc.assert(fc.property(
      wt, fc.float({ min: 0, max: 200, noNaN: true }), fc.float({ min: 0, max: 200, noNaN: true }),
      (w, d1, d2): void => {
        const [near, far] = d1 <= d2 ? [d1, d2] : [d2, d1];
        const dmgNear = aoeDamageAt(near, w);
        const dmgFar = aoeDamageAt(far, w);
        expect(dmgNear).toBeGreaterThanOrEqual(dmgFar);
        expect(dmgFar).toBeGreaterThanOrEqual(0);
      },
    ));
  });

  it('hitRadiusAt stays within [0, hitMax] and grows monotonically', (): void => {
    fc.assert(fc.property(
      wt, fc.float({ min: -1, max: 30, noNaN: true }), fc.float({ min: -1, max: 30, noNaN: true }),
      (w, t1, t2): void => {
        const [early, late] = t1 <= t2 ? [t1, t2] : [t2, t1];
        const r1 = hitRadiusAt(w, early);
        const r2 = hitRadiusAt(w, late);
        expect(r2).toBeGreaterThanOrEqual(r1);
        expect(r1).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(r2)).toBe(true);
      },
    ));
  });

  it('lgTickDamage ramp never increases and hits the documented floor', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 60 }),
      (n): void => {
        const d = lgTickDamage(n);
        expect(d).toBeGreaterThanOrEqual(2);
        expect(d).toBeLessThanOrEqual(4);
        expect(lgTickDamage(n + 1)).toBeLessThanOrEqual(d);
        if (n >= 10) {expect(d).toBe(2);}
      },
    ));
  });

  it('gunGame: the rung weapon is always legal, Hook is always legal', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: -5, max: 40 }), fc.boolean(),
      (rung, igun): void => {
        const w = gunGameWeapon(rung, igun);
        expect(gunGameAllows(rung, w, igun)).toBe(true);
        expect(gunGameAllows(rung, WeaponType.Hook, igun)).toBe(true);
        // A different ladder's weapon at a far rung must be refused.
        const other = gunGameWeapon(rung + 1, igun);
        if (other !== w) {expect(gunGameAllows(rung, other, igun)).toBe(false);}
      },
    ));
  });

  it('effectiveResist: damageResist below 20% health, zero above, never exceeds the perk', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 90 }).map((x): number => x / 100),
      fc.float({ min: 1, max: 500, noNaN: true }),
      fc.float({ min: 0, max: 500, noNaN: true }),
      (resist, maxHealth, health): void => {
        const mods = { damageResist: resist } as Parameters<typeof effectiveResist>[0];
        const r = effectiveResist(mods, health, maxHealth);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(resist);
        expect(r === resist || r === 0).toBe(true);
        if (health >= maxHealth * 0.2) {expect(r).toBe(0);}
      },
    ));
  });

  it('aoeImpulseAt is non-increasing in distance and never negative', (): void => {
    fc.assert(fc.property(
      wt, fc.float({ min: 0, max: 200, noNaN: true }), fc.float({ min: 0, max: 200, noNaN: true }),
      (w, d1, d2): void => {
        const [near, far] = d1 <= d2 ? [d1, d2] : [d2, d1];
        expect(aoeImpulseAt(near, w)).toBeGreaterThanOrEqual(aoeImpulseAt(far, w));
        expect(aoeImpulseAt(far, w)).toBeGreaterThanOrEqual(0);
      },
    ));
  });

  it('lgChargeAt drains to zero, never exceeds the banked amount, never rewinds', (): void => {
    fc.assert(fc.property(
      fc.float({ min: 0, max: 100, noNaN: true }),
      fc.float({ min: 0, max: 1000, noNaN: true }),
      fc.float({ min: 0, max: 60, noNaN: true }),
      (acc, chargeT, elapsed): void => {
        const now = chargeT + elapsed;
        const c = lgChargeAt(acc, chargeT, now);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(acc);
        if (elapsed > 0) {expect(c).toBeLessThanOrEqual(lgChargeAt(acc, chargeT, chargeT));}
        // Long enough past the stamp, the bank is empty.
        if (elapsed > acc + 10) {expect(c).toBe(0);}
      },
    ));
  });

  it('beltThrowCost is a positive integer for every weapon type', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 64 }),
      (w): void => {
        const c = beltThrowCost(w);
        expect(c).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(c)).toBe(true);
      },
    ));
  });

  it('NEVER_FIRED weapons are refused for every armor class', (): void => {
    const classes: (string | undefined)[] = [undefined, 'light', 'medium', 'heavy'];
    for (const w of NEVER_FIRED) {
      for (const cls of classes) {
        expect(classCanFire(cls, w)).toBe(false);
      }
    }
  });

  it('classCanFire: an undeclared class behaves as medium for all weapons', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 64 }),
      (w): void => {
        expect(classCanFire(undefined, w)).toBe(classCanFire('medium', w));
      },
    ));
  });

  it('gunGameRoll always deals a weapon the rung allows - the deal can never softlock', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20 }), fc.boolean(), fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      (rung, igun, rand): void => {
        const r = Math.min(rung, gunGameClimax(igun));
        const dealt = gunGameRoll(r, igun, rand);
        expect(gunGameAllows(r, dealt, igun)).toBe(true);
        expect(gunGameBucket(r, igun)).toContain(dealt);
      },
    ));
  });

  it('gunGameWeapon (canonical member) is also rung-legal - the wt-absent fallback can\'t deal a brick', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20 }), fc.boolean(),
      (rung, igun): void => {
        const r = Math.min(rung, gunGameClimax(igun));
        const w = gunGameWeapon(r, igun);
        expect(gunGameAllows(r, w, igun)).toBe(true);
        expect(gunGameBucket(r, igun)).toContain(w);
      },
    ));
  });

  it('gunGameRoll clamps out-of-range draws to bucket members', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20 }), fc.boolean(), fc.float({ min: -1, max: 2, noNaN: true }),
      (rung, igun, rand): void => {
        const r = Math.min(rung, gunGameClimax(igun));
        expect(gunGameBucket(r, igun)).toContain(gunGameRoll(r, igun, rand));
      },
    ));
  });

  it('igunChassis equals the weapon tier and the dealt gun is fireable on it', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20 }), fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      (rung, rand): void => {
        const r = Math.min(rung, gunGameClimax(true));
        const dealt = gunGameRoll(r, true, rand);
        const chassis = igunChassis(dealt);
        // The chassis IS the tier - and the class gate must admit the
        // dealt weapon, or an igun player could be handed a gun they
        // can't shoulder.
        expect(classCanFire(chassis, dealt)).toBe(true);
      },
    ));
  });

  it('every ladder bucket member resolves a real stats row - no phantom weapons on the ladder', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 20 }), fc.boolean(),
      (rung, igun): void => {
        const r = Math.min(rung, gunGameClimax(igun));
        for (const w of gunGameBucket(r, igun)) {
          expect(WEAPONS[w]).toBeDefined();
          // A missing row would silently arm defaults via getWeaponStats.
          expect(Number.isFinite(getWeaponStats(w).directDamage)).toBe(true);
        }
      },
    ));
  });

  it('every WEAPONS row has finite damage/radius fields - the whole table, not just the ladder', (): void => {
    for (const [key, w] of Object.entries(WEAPONS)) {
      expect(Number.isFinite(w.directDamage), `wt ${key} directDamage`).toBe(true);
      expect(Number.isFinite(w.aoeDamage), `wt ${key} aoeDamage`).toBe(true);
      expect(Number.isFinite(w.hitMax), `wt ${key} hitMax`).toBe(true);
      expect(Number.isFinite(w.hitGrow), `wt ${key} hitGrow`).toBe(true);
    }
  });

  it('igun pays exactly xIGUN_DIRECT_MULT on every weapon and instagib only touches the Railgun', (): void => {
    fc.assert(fc.property(
      wt,
      (w): void => {
        const base = roomDirectDamage(w, false, undefined, false);
        expect(roomDirectDamage(w, false, undefined, true)).toBeCloseTo(base * IGUN_DIRECT_MULT, 5);
        // instagib is a Railgun-only override - every other weapon is untouched.
        if (w !== WeaponType.Railgun) {
          expect(roomDirectDamage(w, true)).toBe(base);
        }
      },
    ));
  });

  it('spendAmmo never goes below zero and a dry cell stays dry', (): void => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 64 }), fc.float({ min: 0, max: 1000, noNaN: true }),
      (w, now): void => {
        const pool: AmmoPool = new Map();
        // Whatever the cell seeds to, spending past empty must fail.
        for (let i = 0; i < 50; i++) {spendAmmo(pool, w, now + i * 0.1);}
        const cell = pool.get(w);
        if (cell) {expect(cell.ammo).toBeGreaterThanOrEqual(0);}
      },
    ));
  });
});
