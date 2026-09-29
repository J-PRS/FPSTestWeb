import { describe, it, expect } from 'bun:test';
import {
  makeSimCrawler, stepCrawler, applyCrawlerDamage, commitTarget, CRAWLER_SIM,
  clipMotion,
} from '../../shared/creatureSim.ts';
import { structureColliders } from '../../shared/ballSim.ts';
import type { Heightfield } from '../../shared/heightfield.ts';

// Flat field — every runtime's heightmap sample agrees trivially.
const FLAT: Heightfield = {
  size: 64, data: new Uint8Array(64 * 64), stride: 1,
};

const DT = 1 / 30;
const TARGET = { x: 20, y: 0, z: 0 };

function committed(c: ReturnType<typeof makeSimCrawler>): void {
  commitTarget(c, 'p1', TARGET);
}

function run(c: ReturnType<typeof makeSimCrawler>, target: { x: number; y: number; z: number } | null, steps: number, authoritative = true) {
  const events: string[] = [];
  for (let i = 0; i < steps; i++) {
    const ev = stepCrawler(c, DT, FLAT, target, authoritative);
    if (ev) events.push(ev);
  }
  return events;
}

describe('creatureSim determinism', () => {
  it('authority and predictor replay identically for the same seed', () => {
    const a = makeSimCrawler(1, 0, 0, 0, false, 12345);
    const b = makeSimCrawler(1, 0, 0, 0, false, 12345);
    committed(a); committed(b);
    run(a, TARGET, 600);
    run(b, TARGET, 600, false);
    expect(b.x).toBeCloseTo(a.x, 10);
    expect(b.y).toBeCloseTo(a.y, 10);
    expect(b.z).toBeCloseTo(a.z, 10);
    expect(b.rng).toBe(a.rng);
    expect(b.state).toBe(a.state);
  });

  it('wanders when there is no target', () => {
    const c = makeSimCrawler(1, 0, 0, 0, false, 7);
    const events = run(c, null, 600);
    expect(c.state).toBe('wander');
    expect(events).not.toContain('windup');
    expect(events).not.toContain('bite');
    // moving — not parked
    expect(Math.hypot(c.x, c.z)).toBeGreaterThan(1);
  });

  it('chases, windups and pounces at a committed target', () => {
    const c = makeSimCrawler(1, 0, 0, 0, false, 42);
    committed(c);
    const events = run(c, TARGET, 1800); // 60s
    expect(events).toContain('windup');
    expect(events).toContain('pounce');
    expect(events).toContain('bite');
    expect(c.pendingBite).toBe(true);
  });

  it('bite flag is authority-only', () => {
    const a = makeSimCrawler(1, 0, 0, 0, false, 42);
    const b = makeSimCrawler(1, 0, 0, 0, false, 42);
    committed(a); committed(b);
    run(a, TARGET, 1800);
    run(b, TARGET, 1800, false);
    expect(a.pendingBite).toBe(true);
    expect(b.pendingBite).toBe(false);
  });

  it('damage kills and staggers', () => {
    const c = makeSimCrawler(1, 0, 0, 0, false, 1);
    expect(applyCrawlerDamage(c, 69)).toBe(false);
    expect(c.stunTimer).toBeGreaterThan(0);
    expect(applyCrawlerDamage(c, 1)).toBe(true);
    expect(c.dead).toBe(true);
  });

  it('hops consume the shared RNG stream, not Math.random', () => {
    const c = makeSimCrawler(1, 0, 0, 0, false, 99);
    const rng0 = c.rng;
    run(c, null, 300);
    expect(c.rng).not.toBe(rng0); // consumed — replay needs the same stream
  });

  it('a hop into a wall stops at the face instead of tunneling', () => {
    // Wall face at x=9 — a chase hop aimed straight at it must not pass.
    const wall = structureColliders([{ kind: 'wall', pos: { x: 10, y: 0, z: 10 }, size: { x: 2, y: 20, z: 20 } }]);
    const c = makeSimCrawler(1, 0, 0, 0, false, 7);
    commitTarget(c, 'p1', { x: 20, y: 0, z: 10 });
    c.x = 0; c.z = 10; c.state = 'chase';
    for (let i = 0; i < 120; i++) stepCrawler(c, DT, FLAT, { x: 20, y: 0, z: 10 }, false, wall);
    expect(c.x).toBeLessThan(9);
  });

  it('the same hop crosses cleanly when the collider list is empty', () => {
    const c = makeSimCrawler(1, 0, 0, 0, false, 7);
    commitTarget(c, 'p1', { x: 20, y: 0, z: 10 });
    c.x = 0; c.z = 10; c.state = 'chase';
    for (let i = 0; i < 120; i++) stepCrawler(c, DT, FLAT, { x: 20, y: 0, z: 10 }, false, []);
    expect(c.x).toBeGreaterThan(9);
  });

  it('clipMotion reports hits only where geometry exists', () => {
    const wall = structureColliders([{ kind: 'wall', pos: { x: 10, y: 0, z: 0 }, size: { x: 2, y: 10, z: 20 } }]);
    const c = { x: 12, y: 1, z: 0, vx: 5, vy: 0, vz: 0 };
    expect(clipMotion(c, 5, 1, 0, wall)).toBe(true);
    expect(c.x).toBeLessThan(10); // parked at the face
    expect(c.vx).toBe(0);
    const d = { x: 12, y: 1, z: 30, vx: 5, vy: 0, vz: 0 };
    expect(clipMotion(d, 5, 1, 30, wall)).toBe(false); // beside the wall — free
  });
});
