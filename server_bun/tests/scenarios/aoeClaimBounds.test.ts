// Pins the claimed-airtime bounds in checkFlightLegality — the field was
// isFiniteNumber-only on the wire, and an out-of-window value warps
// spawnAt bookkeeping or smuggles an impossible flight past the verdict.
import { describe, expect, it } from 'bun:test';
import { validateAoeClaim, type TrackedProjectile } from '../../../shared/combat.ts';
import { WEAPONS } from '../../../shared/weapons.ts';

const weaponType = Number(Object.keys(WEAPONS)[0]);
const now = 100_000;
const proj: TrackedProjectile = {
  ownerId: 'p1',
  weaponType,
  origin: { x: 0, y: 0, z: 0 },
  velocity: { x: 30, y: 0, z: 0 },
  spawnAt: now - 1000, // elapsed = 1s
};
const claim = (airtime: number, blastPos = { x: 30, y: 0, z: 0 }) =>
  validateAoeClaim({ projectile: proj, blastPos, airtime, shooterVel: { x: 0, y: 0, z: 0 }, now });

describe('validateAoeClaim airtime bounds', () => {
  it('rejects negative airtime', () => {
    expect(claim(-1).ok).toBe(false);
  });
  it('rejects airtime beyond wall-clock age + slack', () => {
    expect(claim(1.6).ok).toBe(false); // elapsed 1s + 0.5 slack
  });
  it('rejects a blast beyond ballistic reach', () => {
    expect(claim(1.0, { x: 10000, y: 0, z: 0 }).ok).toBe(false);
  });
  it('accepts an honest in-window claim', () => {
    expect(claim(0.8).ok).toBe(true);
  });
});
