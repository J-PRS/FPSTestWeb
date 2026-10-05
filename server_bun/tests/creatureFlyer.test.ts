import { it, expect } from 'bun:test';
import {
  makeSimFlyer, stepFlyer, applyFlyerDamage,
  FLYER_SIM, FLYER_SPECIES,
} from '../../shared/creatureFlyer.ts';
import { commitTarget } from '../../shared/creatureCore.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { SPECIES } from '../../shared/species.ts';

// The flyer's wire story is the crawler contract: committed snapshot +
// edge events only — windup (fold telegraph) / pounce (dive launch) /
// bite (claw) / land (orbit re-entry). Pins: orbit→windup→dive→climb
// cycle, seeded dive cooldowns, abort paths, authority-only pendingBite,
// twin replay.

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimFlyer(1, { x, y: 0, z }, false, 42);

const stepTo = (c: ReturnType<typeof mk>, target: { x: number; y: number; z: number } | null, authoritative = false, cols?: StructureCollider[]) =>
  stepFlyer(c, DT, FLAT, target, authoritative, cols);

it('flyer species come from the unified registry — rakk + gnat, fly family filter holds', () => {
  expect(FLYER_SPECIES.rakk).toBeDefined();
  expect(FLYER_SPECIES.gnat).toBeDefined();
  for (const [name, row] of Object.entries(FLYER_SPECIES)) {
    expect(SPECIES[name], name).toBe(row);
    expect(row.family).toBe('fly');
  }
});

it('species rows scale the flyer constants — gnat overrides orbit radius and altitude', () => {
  const g = makeSimFlyer(1, { x: 0, y: 0, z: 0 }, false, 42, 'gnat');
  expect(g.sp.ORBIT_R).toBe(10);
  expect(g.sp.ORBIT_ALT).toBe(8);
  expect(g.sp.ORBIT_SPEED).toBeCloseTo(FLYER_SIM.ORBIT_SPEED * 1.5, 9);
  const uber = makeSimFlyer(1, { x: 0, y: 0, z: 0 }, true, 42);
  expect(uber.health).toBeCloseTo(SPECIES.rakk!.health * 3.4, 6);
});

it('seed derives the orbit state deterministically — phase, direction, cooldown', () => {
  const a = mk(), b = mk();
  expect(a.orbitPhase).toBe(b.orbitPhase);
  expect(a.orbitDir).toBe(b.orbitDir);
  expect(a.diveCooldown).toBe(b.diveCooldown);
  expect(a.diveCooldown).toBeGreaterThanOrEqual(FLYER_SIM.DIVE_CD_MIN);
  expect(a.diveCooldown).toBeLessThanOrEqual(FLYER_SIM.DIVE_CD_MIN + FLYER_SIM.DIVE_CD_VAR);
});

it('no committed prey means circling the home anchor — no windup edge', () => {
  const c = mk();
  c.diveCooldown = 0;
  // a raw target exists but tgtValid is false — no committed snapshot
  const ev = stepTo(c, { x: 5, y: 0, z: 0 });
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('orbit');
});

it('a committed target + expired cooldown folds — windup edge, brake telegraph', () => {
  const c = mk();
  commitTarget(c, 'p1', { x: 20, y: 0, z: 0 });
  c.diveCooldown = 0;
  const ev = stepTo(c, { x: 20, y: 0, z: 0 });
  expect(ev).toBe('windup');
  expect<string>(c.state).toBe('windup');
  expect(c.diveTimer).toBeCloseTo(FLYER_SIM.WINDUP_S, 9);
  // the fold brakes hard — velocity bleeds every step
  c.vx = 10; c.vy = 5; c.vz = 10;
  stepTo(c, { x: 20, y: 0, z: 0 });
  expect(Math.hypot(c.vx, c.vy, c.vz)).toBeLessThan(Math.hypot(10, 5, 10));
});

it('the fold commits into the dive — pounce edge, abort clock armed', () => {
  const c = mk();
  c.state = 'windup';
  c.diveTimer = DT;
  const ev = stepTo(c, { x: 20, y: 0, z: 0 });
  expect(ev).toBe('pounce');
  expect<string>(c.state).toBe('dive');
  expect(c.diveTimer).toBeCloseTo(FLYER_SIM.DIVE_T_MAX, 9);
});

it('claw contact ends the dive — bite edge, climb state, authority-only pendingBite', () => {
  const c = mk();
  c.y = 5;
  c.state = 'dive';
  c.diveTimer = 5;
  const target = { x: 0.5, y: 4.5, z: 0 }; // inside HIT_D2
  const ev = stepTo(c, target, true);
  expect(ev).toBe('bite');
  expect<string>(c.state).toBe('climb');
  expect(c.pendingBite).toBe(true);
  // predictor never sets the damage flag
  const p = mk();
  p.y = 5;
  p.state = 'dive';
  p.diveTimer = 5;
  expect(stepTo(p, { x: 0.5, y: 4.5, z: 0 }, false)).toBe('bite');
  expect(p.pendingBite).toBe(false);
});

it('the abort clock re-orbits a missed dive — climb, no bite edge', () => {
  const c = mk();
  c.state = 'dive';
  c.diveTimer = DT; // expires this step
  const ev = stepTo(c, { x: 100, y: 0, z: 100 }, true);
  expect(ev).toBeNull();
  expect<string>(c.state).toBe('climb');
});

it('climb re-enters orbit at altitude — land edge, seeded cooldown re-rolled', () => {
  const c = mk();
  c.y = FLYER_SIM.ORBIT_ALT - 2; // below re-entry — flyToward needs a few steps
  c.state = 'climb';
  const rngBefore = c.rng;
  let ev: string | null = null;
  for (let i = 0; i < 60 && ev !== 'land'; i++) ev = stepTo(c, null);
  expect(ev).toBe('land');
  expect<string>(c.state).toBe('orbit');
  expect(c.diveCooldown).toBeGreaterThanOrEqual(FLYER_SIM.DIVE_CD_MIN);
  expect(c.rng).not.toBe(rngBefore); // the cooldown roll consumed the stream
});

it('the orbit anchor falls back to spawn-home until a target commits', () => {
  const c = mk(10, 20);
  c.tgtValid = false;
  c.orbitPhase = 0;
  c.stunTimer = 0;
  stepTo(c, null);
  // steering toward home-orbit point (hx=10, hz=20 + R offset on x)
  expect(c.vx).not.toBe(0);
});

it('lethal damage flags dead; a hit stuns but does not force a state reset', () => {
  const c = mk();
  c.state = 'dive';
  applyFlyerDamage(c, 1);
  expect(c.stunTimer).toBeGreaterThan(0);
  expect(applyFlyerDamage(c, c.health + 1)).toBe(true);
  expect(c.dead).toBe(true);
});

it('flyer never sinks below terrain + 0.8', () => {
  const c = mk();
  c.y = -10;
  c.vy = -100;
  stepTo(c, null);
  expect(c.y).toBeGreaterThanOrEqual(0.8 - 1e-9);
});

it('clipMotion applies mid-flight — a wall deflects the orbit', () => {
  const c = mk(0, 0);
  c.y = 12;
  const wall: StructureCollider = { cx: 5, cy: 10, cz: 0, hx: 0.5, hy: 15, hz: 10, cos: 1, sin: 0 };
  commitTarget(c, 'p1', { x: 40, y: 0, z: 0 });
  for (let i = 0; i < 100; i++) stepTo(c, { x: 40, y: 0, z: 0 }, false, [wall]);
  expect(c.x).toBeLessThan(30); // it may orbit around but never tunnels
});

it('two flyers stepped identically stay bit-identical — replay holds', () => {
  const a = mk(), b = mk();
  commitTarget(a, 'p1', { x: 25, y: 0, z: 10 });
  commitTarget(b, 'p1', { x: 25, y: 0, z: 10 });
  const target = { x: 25, y: 0, z: 10 };
  for (let i = 0; i < 400; i++) {
    expect(stepTo(a, target)).toBe(stepTo(b, target));
  }
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'state', 'orbitPhase', 'orbitDir', 'diveTimer', 'diveCooldown', 'rng'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});
