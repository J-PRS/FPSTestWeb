// Pins the weaponType boundary: an out-of-table index used to pass
// validation (isFiniteNumber only) and then skip both the cadence law
// (WEAPON_FIRE_INTERVAL_S lookup = undefined) and the belt-cost check.
import { describe, expect, it } from 'bun:test';
import { WIRE } from '../../src/wire.ts';
import { WEAPONS } from '../../../shared/weapons.ts';

const entries = ['shot', 'aoeShot', 'shotFired'] as const;

describe('wire: weaponType validation', () => {
  it('rejects out-of-table weaponType on every claim type', () => {
    for (const type of entries) {
      const v = WIRE[type]!.validate({ type, weaponType: 9999 });
      expect(v.success).toBe(false);
    }
  });

  it('rejects non-integer weaponType', () => {
    const v = WIRE.shot!.validate({ type: 'shot', weaponType: 1.5 });
    expect(v.success).toBe(false);
  });

  it('rejects oversized projectileId on every claim site', () => {
    // projectileId is a ledger/record map key — unbounded strings from a
    // 1MB frame were attacker-shaped key memory. Legit ids are short.
    const fat = 'p'.repeat(4096);
    const base = { shot: { targetId: null }, aoeShot: { position: { x: 0, y: 0, z: 0 } } } as const;
    expect(WIRE.shot!.validate({ type: 'shot', ...base.shot, projectileId: fat }).success).toBe(false);
    expect(WIRE.aoeShot!.validate({ type: 'aoeShot', ...base.aoeShot, projectileId: fat }).success).toBe(false);
    expect(WIRE.projectileDestroy!.validate({ type: 'projectileDestroy', projectileId: fat }).success).toBe(false);
    expect(WIRE.shot!.validate({ type: 'shot', ...base.shot, projectileId: 'p1' }).success).toBe(true);
  });

  it('accepts absent weaponType (optional) and every real table key', () => {
    // shot needs targetId (string|null); aoeShot needs position.
    const base = { shot: { targetId: null }, aoeShot: { position: { x: 0, y: 0, z: 0 } }, shotFired: {} } as const;
    for (const type of entries) {
      expect(WIRE[type]!.validate({ type, ...base[type] }).success).toBe(true);
      for (const k of Object.keys(WEAPONS)) {
        const v = WIRE[type]!.validate({ type, ...base[type], weaponType: Number(k) });
        expect(v.success).toBe(true);
      }
    }
  });
});
