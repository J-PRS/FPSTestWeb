// Belt-throw cadence — the fix for a stretched throw (satchel ≈ 1.9s) whose
// wind-up outlasts the 1s belt cadence: the ready-check must gate on the
// throw lock too, or a second throw starts inside the first's wind-up.
import { describe, expect, it } from 'vitest';
import { beltThrowReady } from '../entities/playerImpulse.js';

describe('belt throw cadence', () => {
  it('fires only on both the cadence and the throw lock', () => {
    expect(beltThrowReady(0, 0)).toBe(true);
    expect(beltThrowReady(1, 0)).toBe(false);   // belt cadence still running
    expect(beltThrowReady(0, 1.9)).toBe(false); // satchel wind-up still running
    expect(beltThrowReady(-0.1, -0.1)).toBe(true);
  });
});
