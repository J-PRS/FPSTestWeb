import { test, expect, describe } from 'bun:test';
import { makeSimBall, stepBall, structureColliders } from '../../shared/ballSim.ts';
import { hmHeight } from '../../shared/heightfield.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// Flat, high field — the test exercises structure contact, not terrain.
const FIELD: Heightfield = { size: 4, data: new Uint8Array(16).fill(0), stride: 1 };
const wall = structureColliders([{
  kind: 'wall',
  pos: { x: 10, y: 0, z: 0 },
  size: { x: 2, y: 10, z: 20 },
}]);

function ballAt(x: number, vx: number) {
  // Ball radius 1.2; field height 0 everywhere.
  return makeSimBall(1, 0, 0, { x, y: 1.2, z: 0 }, { x: vx, y: 0, z: 0 });
}

describe('ball vs structure collision', () => {
  test('a ball flying into a wall ricochets back with a bounce event', () => {
    const b = ballAt(6, 20); // wall face at x=9
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 10; i++) kinds.push(stepBall(b, 0.05, FIELD, null, true, { colliders: wall }));
    expect(kinds).toContain('bounce');
    expect(b.vx).toBeLessThan(0); // reflected
    expect(b.x).toBeLessThan(9); // pushed out, never inside
  });

  test('a ball that never reaches the wall produces no bounce', () => {
    const b = ballAt(0, 1);
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 5; i++) kinds.push(stepBall(b, 0.05, FIELD, null, true, { colliders: wall }));
    expect(b.x).toBeLessThan(8); // never reached the wall face at x=9
  });

  test('a rotated wall still reflects', () => {
    const rot = structureColliders([{
      kind: 'wall', pos: { x: 10, y: 0, z: 0 }, size: { x: 2, y: 10, z: 20 }, rotY: Math.PI / 2,
    }]);
    // rotY=90° swaps the box axes: now it's a thin slab spanning ±10 in x.
    const b = ballAt(5, -1); // moving -x, inside the slab's x-extent already? slab z-extent =1
    b.x = 5; b.z = 5; b.vx = 0; b.vz = 20; // fly +z into the slab face at z=1... below
    // slab after rotation: hx=10, hz=1 → face at z=1. Ball at z=5 flying +z misses; aim -z:
    b.vz = -20;
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 10; i++) kinds.push(stepBall(b, 0.05, FIELD, null, true, { colliders: rot }));
    expect(kinds).toContain('bounce');
    expect(b.vz).toBeGreaterThan(0);
  });

  test('no colliders → free flight unchanged', () => {
    const b = ballAt(6, 20);
    for (let i = 0; i < 10; i++) stepBall(b, 0.05, FIELD, null, true, { colliders: [] });
    expect(b.x).toBeGreaterThan(6); // flew through where the wall would be
  });
});

describe('terrain probe scheduler', () => {
  // Half-raised field: the x=0 column is a 29m plateau, rest is flat.
  // Near wx=0 hmHeight blends toward it — a rising slope, i.e. terrain
  // that climbs INTO a flying ball's path.
  const BUMP: Heightfield = {
    size: 4,
    data: new Uint8Array([60, 0, 0, 0, 60, 0, 0, 0, 60, 0, 0, 0, 60, 0, 0, 0]),
    stride: 1,
  };

  test('a dropped ball still bounces — and the field is sampled every step', () => {
    const b = makeSimBall(1, 0, 0, { x: 0, y: 40, z: 0 }, { x: 0, y: 0, z: 0 });
    const kinds: (string | null)[] = [];
    let probesEveryStep = true;
    for (let i = 0; i < 200 && !kinds.includes('bounce'); i++) {
      kinds.push(stepBall(b, 0.05, FIELD, null, true));
      // No scheduled gate: groundContact resamples the true position
      // every step, so the probe freshness stamp never goes stale.
      if (b.gt !== 0) probesEveryStep = false;
    }
    expect(kinds).toContain('bounce');
    expect(probesEveryStep).toBe(true);
    expect(b.y).toBeGreaterThanOrEqual(b.radius - 0.01); // never buried
  });

  test('terrain rising into the flight path still collides — bounded undershoot', () => {
    // Ball cruises at ~8m toward the plateau face; the drift trigger +
    // early resample must catch the climb within a few ticks.
    const b = makeSimBall(1, 0, 0, { x: -60, y: 12, z: 0 }, { x: 20, y: 0, z: 0 });
    let worst = 0;
    let bounced = false;
    for (let i = 0; i < 200 && !bounced; i++) {
      if (stepBall(b, 0.05, BUMP, null, true) === 'bounce') bounced = true;
      const clearance = b.y - b.radius - hmHeight(BUMP, b.x, b.z);
      if (clearance < worst) worst = clearance;
    }
    expect(bounced).toBe(true);
    expect(worst).toBeGreaterThan(-4); // clipped a bit, never tunneled through
  });
});
