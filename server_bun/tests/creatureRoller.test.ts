import { it, expect } from 'bun:test';
import {
  makeSimRoller, stepRoller, applyRollerDamage,
  ROLLER_SIM, ROLLER_SPECIES,
} from '../../shared/creatureRoller.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { SPECIES } from '../../shared/species.ts';

// The boulder's wire story: one continuous roll the predictor replays,
// 'bite' the only combat edge. Pins: steer cap/accel, aggro-vs-idle
// throttle, contact invuln window, downhill assist, clipMotion parking,
// twin replay.

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimRoller(1, { x, y: 0, z }, false, 42);

const stepTo = (c: ReturnType<typeof mk>, target: { x: number; y: number; z: number } | null, authoritative = false, cols?: StructureCollider[]) =>
  stepRoller(c, DT, FLAT, target, authoritative, cols);

it('roller species come from the unified registry — roller exists, roll family filter holds', () => {
  expect(ROLLER_SPECIES.roller).toBeDefined();
  for (const [name, row] of Object.entries(ROLLER_SPECIES)) {
    expect(SPECIES[name], name).toBe(row);
    expect(row.family).toBe('roll');
  }
});

it('uber scales health 3.4x; seed 0 still leaves a live LCG state', () => {
  const uber = makeSimRoller(1, { x: 0, y: 0, z: 0 }, true, 42);
  expect(uber.health).toBeCloseTo(SPECIES.roller!.health * 3.4, 6);
  const zeroSeed = makeSimRoller(1, { x: 0, y: 0, z: 0 }, false, 0);
  expect(zeroSeed.rng).toBe(1);
});

it('no target means no steer — a rolling boulder keeps its velocity', () => {
  const c = mk();
  c.vx = 4; c.vz = 3;
  stepTo(c, null);
  expect(c.vx).toBe(4);
  expect(c.vz).toBe(3);
});

it('steer accelerates toward the committed snapshot, capped at TOPSPEED', () => {
  const c = mk();
  const target = { x: 60, y: 0, z: 0 }; // inside aggro, far enough it can't arrive mid-test
  for (let i = 0; i < 40; i++) stepTo(c, target);
  const speed = Math.hypot(c.vx, c.vz);
  expect(speed).toBeLessThanOrEqual(c.sp.TOPSPEED + 1e-9);
  expect(speed).toBeGreaterThan(c.sp.TOPSPEED * 0.9);
  expect(c.vx).toBeGreaterThan(0); // moving +x toward target
});

it('out-of-aggro steering throttles to 20% accel — idle drift, not pursuit', () => {
  const near = mk();
  const far = mk();
  // same geometry, different distances — near inside AGGRO, far outside
  for (let i = 0; i < 10; i++) {
    stepTo(near, { x: 50, y: 0, z: 0 });
    stepTo(far, { x: 150, y: 0, z: 0 });
  }
  expect(near.vx).toBeGreaterThan(far.vx * 3); // 5x accel gap, minus cap
});

it('a stunned roller coasts — steer skipped while stunTimer runs', () => {
  const c = mk();
  c.stunTimer = 1;
  c.vx = 2; c.vz = 0;
  stepTo(c, { x: 30, y: 0, z: 0 });
  expect(c.vx).toBe(2); // no accel added
});

it('contact bites once, then the invuln window suppresses re-ticks', () => {
  const c = mk();
  const target = { x: 1, y: c.y, z: 0 }; // inside HIT_R
  const first = stepTo(c, target, true);
  expect(first).toBe('bite');
  expect(c.hitCd).toBe(ROLLER_SIM.BITE_CD);
  expect(c.pendingBite).toBe(true);
  // still touching — no second edge while the window runs
  const second = stepTo(c, target, true);
  expect(second).toBeNull();
  // predictor side never sets the damage flag
  const p = mk();
  p.hitCd = 0;
  stepTo(p, { x: 1, y: p.y, z: 0 }, false);
  expect(p.pendingBite).toBe(false);
});

it('the invuln window expires — contact bites again after BITE_CD', () => {
  const c = mk();
  const target = { x: 1, y: c.y, z: 0 };
  expect(stepTo(c, target, true)).toBe('bite');
  // park velocity so it doesn't roll away; run out the cooldown
  let rebites = 0;
  for (let i = 0; i < Math.ceil(ROLLER_SIM.BITE_CD / DT) + 2; i++) {
    c.vx = 0; c.vz = 0;
    if (stepTo(c, target, true) === 'bite') rebites++;
  }
  expect(rebites).toBe(1); // exactly one re-arm once the window ran out
});

it('rides the surface — y tracks terrain + 1.6 every step', () => {
  const c = mk();
  c.y = 50; // dropped from the sky
  stepTo(c, null);
  expect(c.y).toBeCloseTo(0 + 1.6, 9);
});

it('clipMotion parks the roll on a wall face', () => {
  const c = mk(0, 0);
  const wall: StructureCollider = { cx: 3, cy: 1, cz: 0, hx: 0.5, hy: 2, hz: 10, cos: 1, sin: 0 };
  const target = { x: 40, y: 0, z: 0 };
  for (let i = 0; i < 200; i++) stepTo(c, target, false, [wall]);
  expect(c.x).toBeLessThan(4); // never through
});

it('lethal damage flags dead — the sim reports the kill edge', () => {
  const c = mk();
  const killed = applyRollerDamage(c, c.health + 1);
  expect(killed).toBe(true);
  expect(c.dead).toBe(true);
});

it('two rollers stepped identically stay bit-identical — replay holds', () => {
  const a = mk(), b = mk();
  const target = { x: 40, y: 0, z: 10 };
  for (let i = 0; i < 300; i++) {
    expect(stepTo(a, target)).toBe(stepTo(b, target));
  }
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'hitCd', 'rng', 'state'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});
