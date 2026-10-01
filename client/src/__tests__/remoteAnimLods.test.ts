import { describe, expect, it } from 'vitest';

import { pickAnimCadence } from '../entities/remoteAnim.js';

// CADENCE — Infinity = offscreen freeze; 0 = full rate; everything in
// between is a burst interval. The tiers compose with the distal-bone
// freeze (>= 1/30) and geo LOD (>70m) gates in remoteAnim.
describe('pickAnimCadence', () => {
  it('offscreen freezes the mixer entirely', () => {
    expect(pickAnimCadence(false, 0, true)).toBe(Infinity);
    expect(pickAnimCadence(false, 200 * 200, false)).toBe(Infinity);
  });

  it('near bodies animate at full rate', () => {
    expect(pickAnimCadence(true, 59 * 59, false)).toBe(0);
    expect(pickAnimCadence(true, 59 * 59, true)).toBe(0);
  });

  it('far and moving keeps the distance tiers', () => {
    expect(pickAnimCadence(true, 61 * 61, true)).toBe(1 / 30);
    expect(pickAnimCadence(true, 121 * 121, true)).toBe(1 / 15);
  });

  it('far and idle drops to 5Hz regardless of which distance band', () => {
    expect(pickAnimCadence(true, 61 * 61, false)).toBe(1 / 5);
    expect(pickAnimCadence(true, 121 * 121, false)).toBe(1 / 5);
    expect(pickAnimCadence(true, 500 * 500, false)).toBe(1 / 5);
  });

  it('every decimated tier still qualifies for distal-bone freeze', () => {
    // stepMixer gates distal freezing on animDt >= 1/30 — no tier may
    // fall inside (0, 1/30) or the freeze table silently stops applying.
    for (const d of [61, 100, 121, 400]) {
      const c = pickAnimCadence(true, d * d, true);
      if (c > 0) expect(c).toBeGreaterThanOrEqual(1 / 30);
    }
  });
});
