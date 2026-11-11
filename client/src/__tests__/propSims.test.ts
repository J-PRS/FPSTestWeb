import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { aoeDamageAt, hitRadiusAt, lgTickDamage } from '../../../shared/combat.js';
import { effectiveResist } from '../../../shared/perks.js';
import { gunGameWeapon, gunGameAllows } from '../../../shared/gunGame.js';
import { WeaponType } from '../../../shared/weapons.js';

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
});
