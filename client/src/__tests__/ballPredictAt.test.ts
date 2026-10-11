import { describe, it, expect } from 'vitest';
import { predictAt, newNetBag, type NetStatics } from '../entities/ballNet.js';
import { makeSimBall, BALL_GRAVITY } from '../../../shared/ballSim.js';
import type { Heightfield } from '../../../shared/heightfield.js';
import * as THREE from 'three';

// predictAt is the rubberband watch's probe: it must clone-and-step the
// live replay (never mutate it), bound its horizon to min(t, simNow,
// simT+8), and land the sub-cell remainder ballistically — the same
// contract tickNet renders by.
const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };

function rig(simNow: () => number | undefined = () => Infinity) {
  const st: NetStatics = {
    field: () => FLAT,
    simNow,
    colliders: () => [],
    colliderIndex: () => null,
  };
  const bag = newNetBag();
  bag.sim = makeSimBall(1, 0, 0, { x: 0, y: 1000, z: 0 }, { x: 10, y: 0, z: 0 });
  return { st, bag };
}

describe('predictAt — probe bounds and isolation', () => {
  const out = new THREE.Vector3();

  it('returns false when no replay sim exists', () => {
    const { st, bag } = rig();
    bag.sim = null;
    expect(predictAt(st, bag, 1, out)).toBe(false);
  });

  it('steps on the 0.05 grid then lands the remainder ballistically', () => {
    const { st, bag } = rig();
    expect(predictAt(st, bag, 0.22, out)).toBe(true);
    // 4 cells (0.20) stepped under gravity; rem 0.02 ballistic.
    const steppedX = 10 * 0.2; // vx=10 horizontal flight
    expect(out.x).toBeCloseTo(steppedX + 10 * 0.02, 6);
  });

  it('clamps the horizon to the stamped sim clock', () => {
    const { st, bag } = rig(() => 0.1);
    predictAt(st, bag, 5, out);
    // end = min(5, 0.10, 8) = 0.10 → 2 cells
    expect(out.x).toBeCloseTo(10 * 0.1, 6);
  });

  it('caps the chase at simT + 8s — stale legs cannot runaway', () => {
    const { st, bag } = rig();
    bag.simT = 2;
    predictAt(st, bag, 1000, out);
    // end = 2.0 + 8 = 10.0 → the ball travelled only 8s of vx=10 plus
    // gravity fall — but y=1000 ran out of altitude long before;
    // assert the x horizon specifically.
    expect(out.x).toBeLessThanOrEqual(10 * 8 + 10 * 0.05 + 1e-6);
  });

  it('never mutates the live replay sim', () => {
    const { st, bag } = rig();
    const x0 = bag.sim!.x, y0 = bag.sim!.y, vy0 = bag.sim!.vy;
    predictAt(st, bag, 0.5, out);
    expect(bag.sim!.x).toBe(x0);
    expect(bag.sim!.y).toBe(y0);
    expect(bag.sim!.vy).toBe(vy0);
    expect(bag.simT).toBe(0);
    expect(bag.netAcc).toBe(0);
  });
});
