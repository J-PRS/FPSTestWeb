import { it, expect } from 'bun:test';
import {
  crng, crand, clipMotion, makeSimCrawler, commitTarget,
  stepCrawler, applyCrawlerDamage, CRAWLER_SIM,
} from '../../shared/creatureCore.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { StructureCollider } from '../../shared/ballSim.ts';

// The hop family's wire story is: edges only, both ends replay. These
// pins cover the substrate that makes that safe — the carried LCG, the
// committed snapshot, clipMotion's face parking, and the state machine.

const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };
const DT = 0.05;

const mk = (x = 0, z = 0) => makeSimCrawler(1, { x, y: 0, z }, false, 42);

it('the carried LCG reproduces the identical stream', () => {
  const a = { rng: 42 }, b = { rng: 42 };
  let expected = 42;
  for (let i = 0; i < 100; i++) {
    const v = crand(a), w = crand(b);
    expected = crng(expected);
    expect(v).toBe(w);
    expect(a.rng).toBe(expected); // rng state IS the stream position
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

it('two crawlers stepped identically stay bit-identical — replay holds', () => {
  const a = mk(), b = mk();
  commitTarget(a, 'p1', { x: 30, y: 0, z: 30 });
  commitTarget(b, 'p1', { x: 30, y: 0, z: 30 });
  const target = { x: 30, y: 0, z: 30 };
  for (let i = 0; i < 200; i++) {
    expect(stepCrawler(a, DT, FLAT, target, false)).toBe(
      stepCrawler(b, DT, FLAT, target, false));
  }
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'state', 'hopTimer', 'rng'] as const) {
    expect(a[k], k).toBe(b[k]);
  }
});

it('species rows scale the hop constants — scarab is faster and senses further', () => {
  const c = makeSimCrawler(1, { x: 0, y: 0, z: 0 }, false, 42, 'scarab');
  expect(c.sp.HOP_SPEED).toBeCloseTo(CRAWLER_SIM.HOP_SPEED * 1.35, 9);
  expect(c.sp.AGGRO_D2).toBe(55 * 55);
  expect(c.sp.POUNCE_D2).toBe(20 * 20);
  expect(c.health).toBe(40);
});

it('uber triples health; seed 0 still leaves a live LCG state', () => {
  const uber = makeSimCrawler(1, { x: 0, y: 0, z: 0 }, true, 42);
  expect(uber.health).toBeCloseTo(70 * 3.4, 6);
  expect(uber.maxHealth).toBe(uber.health);
  const zeroSeed = makeSimCrawler(1, { x: 0, y: 0, z: 0 }, false, 0);
  expect(zeroSeed.rng).toBe(1); // || 1 — a dead stream can never sit at 0
});

it('commitTarget snapshots the position — null clears validity, keeps the id', () => {
  const c = mk();
  commitTarget(c, 'p1', { x: 5, y: 1, z: 7 });
  expect(c.targetId).toBe('p1');
  expect([c.tx, c.ty, c.tz]).toEqual([5, 1, 7]);
  expect(c.tgtValid).toBe(true);
  commitTarget(c, null, null);
  expect(c.targetId).toBeNull();
  expect(c.tgtValid).toBe(false);
  expect(c.tx).toBe(5); // stale snapshot stays — validators use tgtValid, not the coords
});

it('clipMotion parks a whisker outside the face and kills velocity', () => {
  const cols: StructureCollider[] = [
    { cx: 5, cy: 1, cz: 0, hx: 0.5, hy: 2, hz: 5, cos: 1, sin: 0 },
  ];
  const c = { x: 0, y: 1, z: 0, vx: 10, vy: 0, vz: 0 };
  c.x = 6; // stepped into/through the wall this leg
  expect(clipMotion(c, 0, 1, 0, cols)).toBe(true);
  expect(c.x).toBeLessThan(4.5); // parked before the face (x=5 face at 4.5)
  expect(c.x).toBeGreaterThan(4);
  expect(c.vx).toBe(0);
  expect(clipMotion({ x: 0, y: 1, z: 0, vx: 1, vy: 0, vz: 0 }, 0, 1, 0, undefined)).toBe(false);
});

it('grounded with prey inside POUNCE_D2 → windup edge, then pounce launch', () => {
  const c = mk();
  const target = { x: 8, y: 0, z: 0 }; // 8m < 25m pounce range
  commitTarget(c, 'p1', target);
  expect(stepCrawler(c, DT, FLAT, target, false)).toBe('windup');
  expect(c.state).toBe('windup');
  expect(c.windupTimer).toBeCloseTo(CRAWLER_SIM.WINDUP_S, 9);
  let ev: string | null = null;
  for (let i = 0; i < 20 && ev !== 'pounce'; i++) {
    ev = stepCrawler(c, DT, FLAT, target, false);
  }
  expect(ev).toBe('pounce');
  expect(c.state).toBe('chase');
  // Launch heads at the committed snapshot horizontally at POUNCE_SPEED.
  const hs = Math.hypot(c.vx, c.vz);
  expect(hs).toBeCloseTo(CRAWLER_SIM.POUNCE_SPEED, 9);
  expect(c.vx).toBeGreaterThan(0);
});

it('landing within POUNCE_HIT_D2 of the committed point is the bite — authority flags it', () => {
  const auth = mk();
  commitTarget(auth, 'p1', { x: 1, y: 0, z: 0 });
  const at = { x: 1, y: 0, z: 0 };
  expect(stepCrawler(auth, DT, FLAT, at, true)).toBe('bite');
  expect(auth.pendingBite).toBe(true);
  const pred = mk();
  commitTarget(pred, 'p1', { x: 1, y: 0, z: 0 });
  expect(stepCrawler(pred, DT, FLAT, at, false)).toBe('bite');
  expect(pred.pendingBite).toBe(false); // predictor plays the anim, never the damage
});

it('prey inside aggro but outside pounce → chase hop at the snapshot', () => {
  const c = mk();
  c.hopTimer = 0;
  const target = { x: 40, y: 0, z: 0 }; // 40m: inside 70m aggro, outside 25m pounce
  commitTarget(c, 'p1', target);
  expect(stepCrawler(c, DT, FLAT, target, false)).toBe('land');
  expect(c.state).toBe('chase');
  expect(c.vx).toBeCloseTo(CRAWLER_SIM.HOP_SPEED, 9);
  expect(c.vy).toBe(CRAWLER_SIM.HOP_UP);
});

it('no prey → wander hop at reduced speed on the carried RNG', () => {
  const c = mk();
  c.hopTimer = 0;
  expect(stepCrawler(c, DT, FLAT, null, false)).toBe('land');
  expect(c.state).toBe('wander');
  const hs = Math.hypot(c.vx, c.vz);
  expect(hs).toBeCloseTo(CRAWLER_SIM.HOP_SPEED * 0.35, 9);
  expect(c.vy).toBeCloseTo(CRAWLER_SIM.HOP_UP * 0.8, 9);
});

it('stun suppresses hops until it clears; lethal damage flags dead', () => {
  const c = mk();
  c.hopTimer = 0;
  expect(applyCrawlerDamage(c, 10)).toBe(false);
  expect(c.stunTimer).toBeCloseTo(CRAWLER_SIM.STUN_S, 9);
  // Grounded hop clock is expired but the stagger holds the launch.
  expect(stepCrawler(c, DT, FLAT, null, false)).toBe(null);
  expect(c.vx).toBe(0);
  expect(applyCrawlerDamage(c, 999)).toBe(true);
  expect(c.dead).toBe(true);
});
