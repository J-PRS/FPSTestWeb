// Belt-throw cadence — the fix for a stretched throw (satchel ≈ 1.9s) whose
// wind-up outlasts the 1s belt cadence: the ready-check must gate on the
// throw lock too, or a second throw starts inside the first's wind-up.
import { describe, expect, it } from 'vitest';
import { beltThrowReady, beltPressPaid } from '../entities/playerImpulse.js';

describe('belt throw cadence', () => {
  it('fires only on both the cadence and the throw lock', () => {
    expect(beltThrowReady(0, 0)).toBe(true);
    expect(beltThrowReady(1, 0)).toBe(false);   // belt cadence still running
    expect(beltThrowReady(0, 1.9)).toBe(false); // satchel wind-up still running
    expect(beltThrowReady(-0.1, -0.1)).toBe(true);
  });
});

// The javelin chamber bug: loading the last bolt left the belt dry, and
// the charge gate then swallowed the unload press too - loaded forever.
describe('belt press charge gate', () => {
  const JAVELIN = 20;
  it('lets a chambered javelin unload on a dry belt', () => {
    expect(beltPressPaid(0, 1, 'javelin', JAVELIN)).toBe(true);
  });
  it('still gates throws on charges', () => {
    expect(beltPressPaid(0, 1, 'javelin', undefined)).toBe(false);
    expect(beltPressPaid(0, 1, 'disc', JAVELIN)).toBe(false);
    expect(beltPressPaid(1, 1, 'disc', undefined)).toBe(true);
    expect(beltPressPaid(1, 2, 'satchel', undefined)).toBe(false);
  });
});
