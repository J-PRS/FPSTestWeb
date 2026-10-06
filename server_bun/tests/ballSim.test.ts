import { describe, it, expect } from 'bun:test';
import {
  makeSimBall, stepBall, applySimDamage,
  BALL_BASE_RADIUS, BALL_MAX_DIST, BALL_MIN_SPEED, BALL_STALL_TIME,
  BALL_ENRAGE_TIMEOUT, BALL_TELE_MIN, BALL_TELE_MAX, BALL_TELE_HEIGHT,
  BALL_VARIANT_SCALE, BALL_VARIANT_HEALTH, BALL_BOUNCE, BALL_OVERSPEED,
} from '../../shared/ballSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// The ball sim's committed-path guarantees — the authority and every
// client predictor run this same function, so every trigger and segment
// kind has to fire identically on both ends. ballCaps pins the speed
// ceilings; this pins the state machine underneath them.

const FLAT: Heightfield = { size: 64, data: new Uint8Array(64 * 64), stride: 1 };
const DT = 1 / 30;
const mk = (over: Partial<{ x: number; y: number; z: number }> = {}, vel = { x: 0, y: 0, z: 0 }) =>
  makeSimBall(1, 0, 0, { x: 10, y: 20, z: 10, ...over }, vel);

describe('ballSim state machine', () => {
  it('makeSimBall derives radius and health from the variant tables', () => {
    for (const v of [0, 1, 2, 3] as const) {
      const b = makeSimBall(9, v, 2, { x: 0, y: 5, z: 0 }, { x: 1, y: 2, z: 3 });
      expect(b.scale).toBe(BALL_VARIANT_SCALE[v]);
      expect(b.radius).toBeCloseTo(BALL_BASE_RADIUS * BALL_VARIANT_SCALE[v], 10);
      expect(b.health).toBe(BALL_VARIANT_HEALTH[v]);
      expect(b.maxHealth).toBe(b.health);
      expect(b.enraged).toBe(false);
      expect(b.dead).toBe(false);
    }
  });

  it('a slow ball on the ground settles to rest instead of bouncing forever', () => {
    const b = mk({ y: BALL_BASE_RADIUS * 1 + 0.01 }, { x: 1, y: -1, z: 0 });
    const kind = stepBall(b, DT, FLAT, null, true);
    expect(Math.hypot(b.vx, b.vy, b.vz)).toBe(0);
    expect(kind).toBeNull(); // settle is not a segment — no broadcast
  });

  it('a resting ball wakes on the stall clock and launches at the target', () => {
    const b = mk({ y: BALL_BASE_RADIUS }, { x: 0, y: 0, z: 0 });
    const target = { x: 100, y: 0, z: 10 };
    let kind: string | null = null;
    for (let i = 0; i < Math.ceil(BALL_STALL_TIME / DT) + 5 && !kind; i++) {
      kind = stepBall(b, DT, FLAT, target, true);
    }
    expect(kind).toBe('stall');
    // launched roughly toward the target with an upward arc
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vy).toBeGreaterThan(0);
  });

  it('a ball too far from its target enrages and springs back', () => {
    const b = mk({ y: BALL_BASE_RADIUS }, { x: 30, y: -30, z: 0 });
    // Target beyond BALL_MAX_DIST → the ground-bounce drift check enrages.
    const target = { x: 10 + BALL_MAX_DIST + 50, y: 0, z: 10 };
    const kind = stepBall(b, DT, FLAT, target, true);
    expect(kind).toBe('enrage');
    expect(b.enraged).toBe(true);
    expect(b.vx).toBeGreaterThan(0); // spring points at the target
  });

  it('enrage pull accelerates toward the target each step', () => {
    const b = mk({ y: 50 }, { x: 0, y: 0, z: 0 });
    b.enraged = true;
    const target = { x: 10, y: 0, z: 200 };
    stepBall(b, DT, FLAT, target, true);
    expect(b.vz).toBeGreaterThan(0);
  });

  it('enrage timeout teleports near the target — authority only', () => {
    const a = mk({ y: 50 });
    a.enraged = true; a.enrageTimer = BALL_ENRAGE_TIMEOUT;
    const target = { x: 100, y: 0, z: 100 };
    const kind = stepBall(a, DT, FLAT, target, true, { rand: () => 0.5 });
    expect(kind).toBe('teleport');
    expect(a.enraged).toBe(false);
    const d = Math.hypot(a.x - target.x, a.z - target.z);
    expect(d).toBeGreaterThanOrEqual(BALL_TELE_MIN - 0.01);
    expect(d).toBeLessThanOrEqual(BALL_TELE_MAX + 0.01);
    expect(a.y).toBeGreaterThanOrEqual(BALL_TELE_HEIGHT - 0.01);
    // Predictor path: no teleport — it lets the ball fly and waits for
    // the authority's segment to snap it.
    const p = mk({ y: 50 });
    p.enraged = true; p.enrageTimer = BALL_ENRAGE_TIMEOUT;
    expect(stepBall(p, DT, FLAT, target, false)).toBeNull();
    expect(Math.hypot(p.x - 10, p.z - 10)).toBeLessThan(1); // never moved
  });

  it('a moving ball reflects off the ground with BALL_BOUNCE elasticity', () => {
    const b = mk({ y: BALL_BASE_RADIUS + 0.001 }, { x: 0, y: -10, z: 0 });
    const kind = stepBall(b, DT, FLAT, null, true);
    expect(kind).toBe('bounce');
    expect(b.vy).toBeCloseTo(10 * BALL_BOUNCE - (-28) * DT, 1); // reflected, minus this step's gravity
  });

  it('an overspeed impact lands at half elasticity — thud, not ricochet', () => {
    const b = mk({ y: BALL_BASE_RADIUS + 0.001 }, { x: 0, y: -(BALL_OVERSPEED + 20), z: 0 });
    stepBall(b, DT, FLAT, null, true);
    // Half the incoming 120-ish impact velocity survives (gravity this
    // step deepens dot slightly before the reflect) — still a thud.
    expect(b.vy).toBeLessThan(BALL_OVERSPEED * 0.65);
    expect(b.vy).toBeGreaterThan(0);
  });

  it('applySimDamage returns true only at death and keeps the impulse', () => {
    const b = mk();
    expect(applySimDamage(b, b.maxHealth - 1, 5, 0, 0)).toBe(false);
    expect(b.health).toBe(1);
    expect(b.vx).toBe(5);
    expect(applySimDamage(b, 1, 0, 0, 0)).toBe(true);
    expect(b.health).toBe(0);
  });

  it('a below-min-speed ball without a target stays parked — stall needs prey', () => {
    const b = mk({ y: BALL_BASE_RADIUS }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < Math.ceil(BALL_STALL_TIME / DT) + 10; i++) {
      expect(stepBall(b, DT, FLAT, null, true)).toBeNull();
    }
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(BALL_MIN_SPEED);
  });
});
