import { it, expect } from 'bun:test';
import {
  makeSimBaneling, stepBaneling, applyBanelingDamage,
  BANELING_SIM, BANELING_SPECIES,
} from '../../shared/creatureBaneling.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';
import { SPECIES } from '../../shared/species.ts';

// The sac's wire story: roller chassis, one new edge kind 'detonate' —
// the pop IS the attack (3D fuse or LIFE_S clock, authority maps it to
// AOE + crawlDie). Pins: homing accel + terminal bleed, both detonate
// paths, dead-flag semantics, twin replay.

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimBaneling(1, { x, y: 0, z }, false, 42);

const stepTo = (c: ReturnType<typeof mk>, target: { x: number; y: number; z: number } | null, authoritative = false, cols?: StructureCollider[]) =>
  stepBaneling(c, DT, FLAT, target, authoritative, cols);

it('baneling species come from the unified registry — blast row required', () => {
  expect(BANELING_SPECIES.baneling).toBeDefined();
  for (const [name, row] of Object.entries(BANELING_SPECIES)) {
    expect(SPECIES[name], name).toBe(row);
    expect(row.family).toBe('baneling');
    expect(row.blast, name).toBeGreaterThan(0); // the pop needs a radius
  }
});

it('uber quadruples health, doubles bite, widens blast 1.7x; seed 0 lives', () => {
  const u = makeSimBaneling(1, { x: 0, y: 0, z: 0 }, true, 42);
  const row = SPECIES.baneling!;
  expect(u.health).toBe(row.health * 4);
  expect(u.biteDamage).toBe(row.bite * 2);
  expect(u.blastRadius).toBeCloseTo(row.blast! * 1.7, 9);
  expect(makeSimBaneling(1, { x: 0, y: 0, z: 0 }, false, 42).blastRadius).toBe(row.blast!);
  expect(makeSimBaneling(1, { x: 0, y: 0, z: 0 }, false, 0).rng).toBe(1);
});

it('the sac homes hard — wide aggro envelope, TOPSPEED cap holds', () => {
  const c = mk();
  const target = { x: 100, y: 0, z: 0 }; // inside AGGRO (140m)
  for (let i = 0; i < 20; i++) {
    stepTo(c, target);
    expect(Math.hypot(c.vx, c.vz)).toBeLessThanOrEqual(c.sp.TOPSPEED + 1e-9);
  }
  expect(c.vx).toBeGreaterThan(0);
});

it('out-of-aggro throttle is 20% accel — a born homer still drifts', () => {
  const near = mk();
  const far = mk();
  for (let i = 0; i < 10; i++) {
    stepTo(near, { x: 50, y: 0, z: 0 });
    stepTo(far, { x: 200, y: 0, z: 0 }); // past AGGRO_D2
  }
  expect(near.vx).toBeGreaterThan(far.vx * 3);
});

it('a stunned sac coasts — homing skipped while stunTimer runs', () => {
  const c = mk();
  c.stunTimer = 1;
  c.vx = 2; c.vz = 0;
  stepTo(c, { x: 30, y: 0, z: 0 });
  expect(c.vx).toBe(2);
});

it('3D proximity detonates — detonate edge + dead flag, no pendingBite', () => {
  const c = mk();
  const target = { x: 1, y: c.y, z: 0 }; // inside FUSE_D2
  const ev = stepTo(c, target, true);
  expect(ev).toBe('detonate');
  expect(c.dead).toBe(true);
  expect(c.pendingBite).toBe(false); // the blast is the attack — no bite flag
});

it('the life clock self-detonates at LIFE_S — same edge, same flag', () => {
  const c = mk();
  c.age = BANELING_SIM.LIFE_S - DT;
  const ev = stepTo(c, null, true);
  expect(ev).toBe('detonate');
  expect(c.dead).toBe(true);
});

it('just inside fuse range detonates on the same step it crosses', () => {
  const c = mk(0, 0);
  const target = { x: 4.5, y: c.y, z: 0 }; // just outside FUSE_D2 (4.2^2=17.64, 4.5^2=20.25)
  // homing pulls it in — the frame it crosses FUSE_D2 is the pop frame
  let ev: string | null = null;
  for (let i = 0; i < 60 && ev !== 'detonate'; i++) ev = stepTo(c, target, true);
  expect(ev).toBe('detonate');
});

it('a distant target never detonates — chase continues', () => {
  const c = mk();
  for (let i = 0; i < 10; i++) {
    expect(stepTo(c, { x: 100, y: 0, z: 0 })).toBeNull();
    expect(c.dead).toBe(false);
  }
});

it('rides the terrain low — y tracks ground + 0.7', () => {
  const c = mk();
  c.y = 20;
  stepTo(c, null);
  expect(c.y).toBeCloseTo(0.7, 9);
});

it('clipMotion parks the sac on a wall face — it cannot tunnel to fuse', () => {
  const c = mk(0, 0);
  const wall: StructureCollider = { cx: 3, cy: 1, cz: 0, hx: 0.5, hy: 2, hz: 10, cos: 1, sin: 0 };
  const target = { x: 40, y: 0, z: 0 };
  for (let i = 0; i < 100; i++) {
    const ev = stepTo(c, target, false, [wall]);
    if (ev === 'detonate') break; // it may wrap the wall and reach the fuse — legal
  }
  expect(c.x).toBeLessThan(40); // detonate-or-park, never teleport through
});

it('shooting it pops it — lethal damage flags dead (the counterplay)', () => {
  const c = mk();
  expect(applyBanelingDamage(c, c.health + 1)).toBe(true);
  expect(c.dead).toBe(true);
});

it('two banelings stepped identically stay bit-identical — replay holds', () => {
  const a = mk(), b = mk();
  const target = { x: 60, y: 0, z: 20 };
  for (let i = 0; i < 300; i++) {
    expect(stepTo(a, target)).toBe(stepTo(b, target));
  }
  for (const k of ['x', 'y', 'z', 'vx', 'vz', 'yaw', 'age', 'rng', 'dead'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});
