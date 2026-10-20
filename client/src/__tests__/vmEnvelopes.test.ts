import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { VmEnvelopes, type EnvHost } from '../entities/vmEnvelopes';

// Spawn arms the default slot with switchWeapon(wt) — but when wt IS the
// class's default activeWeapon (0 = BoltLauncher), the same-weapon guard
// skipped the dip AND the visibility swap, leaving the gun built-hidden
// until the first real switch.

const mkHost = (built: number[]): EnvHost => {
  const weapons = new Map<number, THREE.Group>();
  for (const wt of built) {
    const g = new THREE.Group();
    g.visible = false; // every viewmodel ships hidden — the envelope shows one
    weapons.set(wt, g);
  }
  return {
    weapons,
    activeWeapon: 0,
    flashMesh: new THREE.Group(),
    flashMesh2: new THREE.Group(),
    fistGroup: new THREE.Group(),
    hammerGroup: new THREE.Group(),
    shieldShells: [],
    shellColor: 0,
    setShield: (): void => { return; },
    muzzleZ: (): number => -0.35,
    muzzleGroupPos: (): false => false,
  };
};

describe('VmEnvelopes.switchWeapon', (): void => {
  it('arming the already-active weapon still unhides it (spawn with BoltLauncher)', (): void => {
    const h = mkHost([0, 1, 2]);
    const env = new VmEnvelopes(h);
    env.switchWeapon(0); // wt 0 === default activeWeapon — the old early-return left it hidden
    expect(h.weapons.get(0)!.visible).toBe(true);
  });

  it('a same-weapon re-switch does not re-dip or hide anything', (): void => {
    const h = mkHost([0]);
    h.weapons.get(0)!.visible = true;
    const env = new VmEnvelopes(h);
    env.switchWeapon(0);
    expect(h.weapons.get(0)!.visible).toBe(true);
    expect(env.tick(0.1).switchDip).toBe(0);
  });

  it('a real switch still hides the old gun and shows the new one', (): void => {
    const h = mkHost([0, 1]);
    h.weapons.get(0)!.visible = true;
    const env = new VmEnvelopes(h);
    env.switchWeapon(1);
    env.tick(0.2); // past SWITCH_LOWER_TIME — the swap lands at the dip bottom
    expect(h.weapons.get(0)!.visible).toBe(false);
    expect(h.weapons.get(1)!.visible).toBe(true);
    expect(h.activeWeapon).toBe(1);
  });
});

describe('VmEnvelopes.draw', (): void => {
  it('starts lowered and raises without replaying a belt windup', (): void => {
    const env = new VmEnvelopes(mkHost([0]));
    env.draw();
    expect(env.tick(0).dip).toBe(1);
    const raising = env.tick(0.15).dip;
    expect(raising).toBeGreaterThan(0);
    expect(raising).toBeLessThan(1);
    expect(env.tick(0.3).dip).toBe(0);
  });

  it('does not inherit the previous belt throw time scale', (): void => {
    const env = new VmEnvelopes(mkHost([0]));
    env.startThrow(3);
    env.draw();
    expect(env.tick(0).dip).toBe(1);
    expect(env.tick(0.4).dip).toBe(0);
  });
});
