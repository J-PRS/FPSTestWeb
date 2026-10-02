import { describe, it, expect } from 'bun:test';
import { makeSimBall, stepBall, applySimDamage, BALL_MAX_SPEED } from '../../shared/ballSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// Flat field — every heightmap sample agrees trivially.
const FLAT: Heightfield = { size: 64, data: new Uint8Array(64 * 64), stride: 1 };
const DT = 1 / 30;

function run(b: ReturnType<typeof makeSimBall>, target: { x: number; y: number; z: number } | null, steps: number) {
  for (let i = 0; i < steps; i++) stepBall(b, DT, FLAT, target, true);
}

describe('ballSim speed caps', () => {
  it('stacked knockback impulses cannot push a ball past BALL_MAX_SPEED', () => {
    const b = makeSimBall(1, 0, 0, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 });
    // Sustained fire: every hit is capped at the impulse ceiling, but they
    // used to accumulate — a dozen 60 m/s kicks meant an 800 m/s ball and
    // a multi-kilometre enrage arc (observed parked at ~9km altitude).
    for (let i = 0; i < 30; i++) applySimDamage(b, 0, 20, 50, 10);
    expect(Math.hypot(b.vx, b.vy, b.vz)).toBeLessThanOrEqual(BALL_MAX_SPEED + 1e-6);
  });

  it('a max-speed ball enrage launch cannot reach orbit altitude', () => {
    const b = makeSimBall(1, 0, 0, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 30; i++) applySimDamage(b, 0, 20, 50, 10);
    const target = { x: 500, y: 0, z: 0 }; // drifting far past BALL_MAX_DIST
    let peak = 0;
    for (let i = 0; i < 30 * 60; i++) {
      stepBall(b, DT, FLAT, target, true);
      if (b.y > peak) peak = b.y;
    }
    // Ballistic cap: v<=140 total, upFrac sqrt(1/2) → vy<=99, apex ~175m.
    // Assert with headroom — what must never come back is km-scale arcs.
    expect(peak).toBeLessThan(400);
  });

  it('the cap keeps authority and predictor identical', () => {
    const a = makeSimBall(1, 0, 0, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 });
    const b = makeSimBall(1, 0, 0, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 30; i++) {
      applySimDamage(a, 0, 20, 50, 10);
      applySimDamage(b, 0, 20, 50, 10);
    }
    run(a, null, 300);
    for (let i = 0; i < 300; i++) stepBall(b, DT, FLAT, null, false);
    expect(b.x).toBeCloseTo(a.x, 10);
    expect(b.y).toBeCloseTo(a.y, 10);
    expect(b.z).toBeCloseTo(a.z, 10);
  });
});
