import { describe, test, expect } from 'bun:test';
import { projStep, segPointDist, segPointT } from '../../shared/projSim.ts';
import { dist3, distSq } from '../../shared/botVec.ts';

describe('projStep', () => {
  test('integrates gravity + position and returns the pre-step pos', () => {
    const p = { pos: { x: 0, y: 10, z: 0 }, vel: { x: 5, y: 0, z: 0 }, age: 0 };
    const from = projStep(p, 0.1, -9.8);
    expect(from).toEqual({ x: 0, y: 10, z: 0 });
    expect(p.vel.y).toBeCloseTo(-0.98, 5);
    expect(p.pos.x).toBeCloseTo(0.5, 5);
    expect(p.pos.y).toBeCloseTo(9.902, 5); // vel.y applies before pos integrates
    expect(p.age).toBeCloseTo(0.1, 5);
  });

  test('is deterministic — same inputs same outputs', () => {
    const a = { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 6 }, age: 0 };
    const b = { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: 6 }, age: 0 };
    for (let i = 0; i < 10; i++) { projStep(a, 0.05, -9.8); projStep(b, 0.05, -9.8); }
    expect(a).toEqual(b);
  });
});

describe('segPointDist', () => {
  const z = { x: 0, y: 0, z: 0 };
  test('perpendicular mid-segment approach', () => {
    expect(segPointDist(z, { x: 10, y: 0, z: 0 }, { x: 5, y: 3, z: 0 })).toBeCloseTo(3, 5);
  });
  test('clamps to endpoints beyond the segment', () => {
    expect(segPointDist(z, { x: 10, y: 0, z: 0 }, { x: 15, y: 4, z: 0 })).toBeCloseTo(Math.sqrt(41), 5);
    expect(segPointDist(z, { x: 10, y: 0, z: 0 }, { x: -3, y: 4, z: 0 })).toBeCloseTo(5, 5);
  });
  test('degenerate zero-length segment behaves as a point', () => {
    expect(segPointDist(z, z, { x: 3, y: 4, z: 0 })).toBeCloseTo(5, 5);
  });
});

describe('segPointT', () => {
  const z = { x: 0, y: 0, z: 0 };
  test('midpoint hit lands at t=0.5', () => {
    expect(segPointT(z, { x: 10, y: 0, z: 0 }, { x: 5, y: 9, z: 0 })).toBeCloseTo(0.5, 5);
  });
  test('orders competing hits along the segment', () => {
    const a = { x: 10, y: 0, z: 0 };
    const near = segPointT(z, a, { x: 2, y: 1, z: 0 });
    const far = segPointT(z, a, { x: 8, y: 1, z: 0 });
    expect(near).toBeLessThan(far);
  });
  test('clamps to [0,1] and survives zero-length input', () => {
    expect(segPointT(z, { x: 10, y: 0, z: 0 }, { x: -5, y: 1, z: 0 })).toBe(0);
    expect(segPointT(z, { x: 10, y: 0, z: 0 }, { x: 20, y: 1, z: 0 })).toBe(1);
    expect(segPointT(z, z, { x: 1, y: 0, z: 0 })).toBe(0);
  });
});

describe('botVec', () => {
  test('distSq avoids the sqrt; dist3 matches', () => {
    const a = { x: 1, y: 2, z: 3 }, b = { x: 4, y: 6, z: 3 };
    expect(distSq(a, b)).toBeCloseTo(25, 5);
    expect(dist3(a, b)).toBeCloseTo(5, 5);
  });
});
