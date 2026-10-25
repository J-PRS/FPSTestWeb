// Deploy belt economy — the gate that used to let a high tosser stack free
// pods (the charge only landed with the pod). Locks the two rules: the belt
// pays the per-kind cost at the throw, and pods still in the air occupy a
// cap slot before they seat.
import { describe, expect, it } from 'vitest';
import { canThrowPack, packCost, recyclesSeated } from '../game/deployEconomy.js';
import { PACK_KINDS } from '../../../shared/deployables.js';

describe('deploy belt economy', () => {
  it('bills the shared per-kind cost (turret class 5 = full belt)', () => {
    expect(packCost('turret')).toBe(5); // turret-class deployables are a full belt
    expect(packCost('mine')).toBe(2);
    expect(packCost('mortar')).toBe(5);
  });

  it('refuses a throw the belt cannot pay for', () => {
    expect(canThrowPack(1, 2, 0, 0, 2)).toBe(false);
    expect(canThrowPack(2, 2, 0, 0, 2)).toBe(true);
    // A mortar's 3 must be affordable in full — no partial charge.
    expect(canThrowPack(2, 3, 0, 0, 1)).toBe(false);
  });

  it('counts airborne pods against the cap — no stacking from the air', () => {
    // Station cap 1: one already in flight blocks the next toss.
    expect(canThrowPack(5, 2, 0, 1, 1)).toBe(false);
    // Turret cap 2: two in flight block the third, same as two seated.
    expect(canThrowPack(5, 2, 0, 2, 2)).toBe(false);
    expect(canThrowPack(5, 2, 1, 1, 2)).toBe(true);
  });

  it('recycles a seated item rather than refusing at cap', () => {
    expect(canThrowPack(5, 2, 2, 0, 2)).toBe(true);
  });

  it('recycles only a seated item, and only at cap', () => {
    expect(recyclesSeated(2, 0, 2)).toBe(true);   // cap reached, seated to retire
    expect(recyclesSeated(1, 1, 2)).toBe(true);   // cap reached with one airborne
    expect(recyclesSeated(1, 0, 2)).toBe(false);  // under cap — nothing to retire
    expect(recyclesSeated(0, 2, 2)).toBe(false);  // all airborne — nothing seated to retire
  });

  it('offers only throwable kinds in the pack menu (no map-only base assets)', () => {
    expect(PACK_KINDS).toContain('turret');
    expect(PACK_KINDS).toContain('nugget');
    expect(PACK_KINDS).not.toContain('generator');
    expect(PACK_KINDS).not.toContain('sensor');
    expect(PACK_KINDS).not.toContain('baseturret');
  });
});
