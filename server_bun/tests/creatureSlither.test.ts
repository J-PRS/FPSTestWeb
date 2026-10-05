import { it, expect } from 'bun:test';
import {
  makeSimSlither, stepSlither, applySlitherDamage,
  SLITHER_SIM, SLITHER_SPECIES,
} from '../../shared/creatureSlither.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { SPECIES } from '../../shared/species.ts';

// The viper's wire story is the crawler family's: committed snapshot +
// edge events only — windup/pounce/bite, no new vocab. These pins cover
// the weave→coil→leap state machine, the once-per-leap pass-through
// bite, and identical replay (the weave lives in sim-state animT, not
// wall-clock, or authority and predictor would diverge).

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimSlither(1, { x, y: 0, z }, false, 42);

const stepTo = (c: ReturnType<typeof mk>, target: { x: number; y: number; z: number } | null, authoritative = false, cols?: StructureCollider[]) =>
  stepSlither(c, DT, FLAT, target, authoritative, cols);

it('slither species come from the unified registry — snake exists, viper family filter holds', () => {
  expect(SLITHER_SPECIES.snake).toBeDefined();
  for (const [name, row] of Object.entries(SLITHER_SPECIES)) {
    expect(SPECIES[name], name).toBe(row);
    expect(row.family).toBe('slither');
  }
});

it('uber quadruples health; seed 0 still leaves a live LCG state', () => {
  const uber = makeSimSlither(1, { x: 0, y: 0, z: 0 }, true, 42);
  expect(uber.health).toBe(SPECIES.snake!.health * 4);
  expect(uber.maxHealth).toBe(uber.health);
  const zeroSeed = makeSimSlither(1, { x: 0, y: 0, z: 0 }, false, 0);
  expect(zeroSeed.rng).toBe(1);
});

it('out-of-aggro target gets no weave — the snake bleeds speed instead', () => {
  const c = mk();
  c.vx = 3; c.vz = 4;
  const ev = stepTo(c, { x: 200, y: 0, z: 0 }); // way past AGGRO_D2
  expect(ev).toBeNull();
  expect(c.state).toBe('slither');
  expect(Math.hypot(c.vx, c.vz)).toBeLessThan(5); // bleeds 4/s
});

it('in-range target with a ready cooldown coils — windup edge, stationary telegraph', () => {
  const c = mk();
  c.strikeCd = 0;
  const ev = stepTo(c, { x: 3, y: 0, z: 0 }); // inside STRIKE_D2
  expect(ev).toBe('windup');
  expect(c.state).toBe('windup');
  expect(c.windupTimer).toBeCloseTo(SLITHER_SIM.WINDUP_S, 9);
  // the coil is a telegraph: velocity zeroed, no movement
  stepTo(c, { x: 3, y: 0, z: 0 });
  expect(c.vx).toBe(0);
  expect(c.vz).toBe(0);
});

it('a ready cooldown is required to coil — post-strike cd blocks the telegraph', () => {
  const c = mk();
  c.strikeCd = SLITHER_SIM.STRIKE_CD;
  const ev = stepTo(c, { x: 3, y: 0, z: 0 });
  expect(ev).toBeNull(); // pursues instead
  expect(c.state).toBe('slither');
});

it('the coil commits into a ballistic leap — pounce edge, velocity through the target', () => {
  const c = mk();
  const target = { x: 8, y: 0, z: 0 };
  // force the windup state directly, run the coil clock out
  c.state = 'windup';
  c.windupTimer = DT;
  const ev = stepTo(c, target);
  expect(ev).toBe('pounce');
  expect<string>(c.state).toBe('lunge');
  expect(c.struck).toBe(false);
  // leap speed is the lunge constant, aimed at +x
  expect(c.vx).toBeCloseTo(SLITHER_SIM.LUNGE_SPEED, 6);
  expect(Math.abs(c.vz)).toBeLessThan(1e-6);
  expect(c.vy).toBeGreaterThan(0); // arc arrives at target height
});

it('a leap bites once on pass-through, authority-only pendingBite, then never again', () => {
  const c = mk();
  c.y = 2.2; // airborne — y<=terrain+0.5 lands the leap instantly
  const target = { x: 4, y: 0.5, z: 0 };
  c.state = 'lunge';
  c.hopTimer = 5;
  c.vx = SLITHER_SIM.LUNGE_SPEED; c.vz = 0; c.vy = 0;
  // step until the first contact — must emit 'bite' exactly once
  let bites = 0;
  for (let i = 0; i < 40 && c.state === 'lunge'; i++) {
    const ev = stepTo(c, target, true);
    if (ev === 'bite') bites++;
  }
  expect(bites).toBe(1);
  expect(c.struck).toBe(true);
  expect(c.pendingBite).toBe(true);
  // predictor side never sets the damage flag
  const p = mk();
  p.y = 2.2;
  p.state = 'lunge';
  p.hopTimer = 5;
  p.vx = SLITHER_SIM.LUNGE_SPEED; p.vz = 0; p.vy = 0;
  for (let i = 0; i < 40 && p.state === 'lunge'; i++) stepTo(p, target, false);
  expect(p.pendingBite).toBe(false);
});

it('touchdown ends the strike — state resets, cooldown rearms', () => {
  const c = mk();
  c.state = 'lunge';
  c.hopTimer = 0.01; // expires this step → force the landing branch
  c.vx = 10; c.vz = 0; c.vy = 1;
  c.y = 5;
  stepTo(c, { x: 50, y: 0, z: 0 }, true);
  expect<string>(c.state).toBe('slither');
  expect(c.strikeCd).toBe(SLITHER_SIM.STRIKE_CD);
  expect(c.vx).toBe(0);
});

it('a hit breaks the strike — windup or lunge collapses back to slither', () => {
  for (const s of ['windup', 'lunge'] as const) {
    const c = mk();
    c.state = s;
    applySlitherDamage(c, 1);
    expect<string>(c.state).toBe('slither');
    expect(c.stunTimer).toBeGreaterThan(0);
  }
});

it('lethal damage flags dead — the sim reports the kill edge', () => {
  const c = mk();
  const killed = applySlitherDamage(c, c.health + 1);
  expect(killed).toBe(true);
  expect(c.dead).toBe(true);
});

it('two slithers stepped identically stay bit-identical — replay holds', () => {
  const a = mk(), b = mk();
  const target = { x: 12, y: 0, z: 6 };
  for (let i = 0; i < 300; i++) {
    expect(stepTo(a, target)).toBe(stepTo(b, target));
  }
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'state', 'animT', 'strikeCd', 'hopTimer', 'rng', 'struck'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});

it('the weave is deterministic — animT drives the S, identical twins wiggle in lockstep', () => {
  const a = mk(), b = mk();
  const target = { x: 40, y: 0, z: 0 }; // in aggro, out of strike
  stepTo(a, target);
  stepTo(b, target);
  expect(a.vx).toBe(b.vx);
  expect(a.vz).toBe(b.vz);
  // speed is the weave speed constant, heading wobbled off the target yaw
  expect(Math.hypot(a.vx, a.vz)).toBeCloseTo(a.sp.SPEED, 6);
});

it('clipMotion still applies on the weave leg — a wall stops the S', () => {
  const c = mk(0, 0);
  const wall: StructureCollider = { cx: 2, cy: 1, cz: 0, hx: 0.5, hy: 2, hz: 10, cos: 1, sin: 0 };
  const target = { x: 40, y: 0, z: 0 };
  for (let i = 0; i < 100; i++) stepTo(c, target, false, [wall]);
  expect(c.x).toBeLessThan(3); // parked on the face, never through
});
