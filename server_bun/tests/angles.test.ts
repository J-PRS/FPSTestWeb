import { it, expect } from 'bun:test';
import { wrapAngleDelta, lerpAngle } from '../../shared/angles.ts';

// The wrap convention is a wire contract: live remote interp and demo
// playback share this file so a 10°→350° turn never reads as a backwards
// spin on one end and a short arc on the other.

const PI = Math.PI;

it('wrapAngleDelta returns the shortest signed arc in (-π, π]', () => {
  expect(wrapAngleDelta(0)).toBe(0);
  expect(wrapAngleDelta(PI / 2)).toBeCloseTo(PI / 2, 12);
  expect(wrapAngleDelta(-PI / 2)).toBeCloseTo(-PI / 2, 12);
  // exactly π stays +π — the half-open bound is the convention
  expect(wrapAngleDelta(PI)).toBeCloseTo(PI, 12);
});

it('wrapAngleDelta collapses multi-turn deltas to the shortest arc', () => {
  // 350° as a delta is really -10°
  expect(wrapAngleDelta(2 * PI - 0.17)).toBeCloseTo(-0.17, 9);
  // two full turns + π/2 → π/2
  expect(wrapAngleDelta(4 * PI + PI / 2)).toBeCloseTo(PI / 2, 9);
  // negative multi-turn: -(2π + 0.3) → -0.3
  expect(wrapAngleDelta(-(2 * PI + 0.3))).toBeCloseTo(-0.3, 9);
});

it('just past ±π flips sign — the discontinuity is at the poles, not ±π', () => {
  expect(wrapAngleDelta(PI + 0.01)).toBeCloseTo(-PI + 0.01, 9);
  expect(wrapAngleDelta(-PI - 0.01)).toBeCloseTo(PI - 0.01, 9);
});

it('lerpAngle picks the short arc across the ±π seam', () => {
  // 10° → 350° must go backwards 20°, not forwards 340°
  const a = 0.17, b = 2 * PI - 0.17;
  const mid = lerpAngle(a, b, 0.5);
  expect(mid).toBeCloseTo(0, 9); // halfway backwards through 0
  // the t=1 endpoint is angle-equivalent to b but lands on the short-arc
  // side (b - 2π) — equality is modulo the wrap, not literal
  expect(wrapAngleDelta(lerpAngle(a, b, 1) - b)).toBeCloseTo(0, 9);
});

it('lerpAngle endpoints are exact — t=0 and t=1 hit a and b', () => {
  expect(lerpAngle(1.0, 2.5, 0)).toBe(1.0);
  expect(lerpAngle(1.0, 2.5, 1)).toBe(2.5);
  expect(lerpAngle(1.0, 2.5, 0.5)).toBeCloseTo(1.75, 12);
});
