import { describe, it, expect } from 'bun:test';
import { PERKS, PERK_ORDER, perkMods, effectiveResist, isPerkId, type PerkId, type PerkMods } from '../../shared/perks.ts';

// The perk table is server-enforced economy: the wire validator gates
// join.perk through isPerkId, applyDamage reads effectiveResist, the
// heal cap reads maxHealth. A drifted row silently buffs or dead-perks
// a loadout — pin the contract both ends share.

// Derived from the ZERO row — a new mod key can never drift past this list.
const MOD_KEYS = Object.keys(perkMods('none')) as (keyof PerkMods)[];

describe('perks', () => {
  it('PERK_ORDER covers every PerkId exactly once', () => {
    expect(PERK_ORDER.length).toBe(Object.keys(PERKS).length);
    expect(new Set(PERK_ORDER).size).toBe(PERK_ORDER.length);
    for (const id of Object.keys(PERKS)) {
      expect(PERK_ORDER, id).toContain(id as PerkId);
    }
  });

  it('every mod field is a finite number within sane economy bounds', () => {
    for (const [id, p] of Object.entries(PERKS)) {
      for (const [k, v] of Object.entries(p.mods)) {
        expect(MOD_KEYS as readonly string[], `${id}.${k} is not a known mod`).toContain(k);
        expect(Number.isFinite(v as number), `${id}.${k}`).toBe(true);
        expect(v as number, `${id}.${k}`).toBeGreaterThanOrEqual(0);
        // Multipliers must stay inside a sane band — a 0 or 5x modifier
        // is a balance typo, not a perk.
        if (k !== 'maxHealth' && k !== 'regen' && k !== 'regenRamp' && k !== 'damageResist' && k !== 'fallSoak' && k !== 'jumpstart') {
          expect(v as number, `${id}.${k}`).toBeLessThanOrEqual(3);
        }
        if (k === 'damageResist') {expect(v as number).toBeLessThan(1);}
      }
    }
  });

  it('perkMods: unknown/absent ids fall back to the ZERO row, never null', () => {
    const zero = perkMods('none');
    const ADDITIVE = new Set(['maxHealth', 'regen', 'regenRamp', 'damageResist', 'meleeHeal', 'fallSoak', 'jumpstart']);
    for (const k of MOD_KEYS) {
      expect(zero[k]).toBe(ADDITIVE.has(k) ? 0 : 1);
    }
    expect(perkMods(undefined)).toEqual(zero);
    expect(perkMods(null)).toEqual(zero);
    expect(perkMods('goblin')).toEqual(zero);
    expect(perkMods('')).toEqual(zero);
    // A real perk fills its mods over the zero base.
    const p = perkMods('plated');
    expect(p.damageResist).toBe(0.4);
    expect(p.jetDrain).toBe(1); // untouched keys stay at the neutral 1
  });

  it('perkMods returns a fresh copy — mutating it cannot corrupt the table', () => {
    const a = perkMods('plated');
    a.damageResist = 99;
    expect(perkMods('plated').damageResist).toBe(0.4);
  });

  it('plated resist only counts below 20% max health — the underdog plate', () => {
    const mods = perkMods('plated');
    expect(effectiveResist(mods, 19, 100)).toBe(0.4);
    expect(effectiveResist(mods, 20, 100)).toBe(0); // at the line: healthy
    expect(effectiveResist(mods, 100, 100)).toBe(0);
    expect(effectiveResist(perkMods('none'), 10, 100)).toBe(0);
  });

  it('isPerkId gates the wire: every union member in, junk out', () => {
    for (const id of Object.keys(PERKS)) {expect(isPerkId(id)).toBe(true);}
    expect(isPerkId('god')).toBe(false);
    expect(isPerkId('')).toBe(false);
    expect(isPerkId(undefined)).toBe(false);
    expect(isPerkId(3)).toBe(false);
    expect(isPerkId('PLATED')).toBe(false); // case-sensitive ids
  });
});
