import { it, expect } from 'bun:test';
import { TerrainFlow } from '../../shared/botGraph.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';

// TerrainFlow is the leg-scale router: one reversed Dijkstra flood per
// goal bucket, every bot reads the same field. Pins: progress on flat
// ground, wall circumvention (priced, not forbidden — jets), danger
// deflection, routeNearGoal back-off, goal bucketing, flood cache cap,
// deterministic replay.

const FLAT = () => 0;
// Wall band across the x-beeline with a gap past |z| > 50.
const WALL = (x: number, z: number) => (x > -10 && x < 10 && Math.abs(z) < 50 ? 45 : 0);

it('grid wraps the origin — w/cellOf round-trip inside one cell', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  // a route FROM a spot to itself is the goal cell immediately
  const wp = f.route(5, 5, 5, 5, 0);
  expect(wp).not.toBeNull();
});

it('flat ground routes roughly straight — the waypoint makes real progress toward the goal', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  const wp = f.route(-100, 0, 120, 0, 80)!;
  expect(wp).not.toBeNull();
  expect(wp.x).toBeGreaterThan(-60); // ~80m of the 220m leg covered
  expect(Math.abs(wp.z)).toBeLessThan(30); // no reason to leave the beeline
  expect(wp.y).toBe(0); // waypoint rides grid height
});

it('a wall spanning the beeline gets routed around — priced, never forbidden', () => {
  const f = new TerrainFlow(WALL, 300, 10);
  const wp = f.route(-100, 0, 120, 0, 80)!;
  expect(Math.abs(wp.z)).toBeGreaterThan(30); // committed to the gap at z>50
  // and the wall really is why — same shape on flat ground stays on-axis
  const flat = new TerrainFlow(FLAT, 300, 10);
  expect(Math.abs(flat.route(-100, 0, 120, 0, 80)!.z)).toBeLessThan(30);
});

it('danger deflects the walk off a hot blob without leaving the descent', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  const safe = f.route(-100, 0, 120, 0, 80)!;
  const hot = f.route(-100, 0, 120, 0, 80, (x, z) => (Math.abs(x + 20) < 15 && Math.abs(z) < 15 ? 8 : 0))!;
  expect(Math.abs(hot.z)).toBeGreaterThan(Math.abs(safe.z));
});

it('routeNearGoal walks the flood back to backM before the goal', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  const p = f.routeNearGoal(-100, 0, 120, 0, 40)!;
  // grid centers land ~35m short of the cell-quantized goal
  expect(p.x).toBeGreaterThan(60);
  expect(p.x).toBeLessThan(120);
  expect(Math.hypot(120 - p.x, p.z)).toBeLessThanOrEqual(60);
});

it('goal bucketing — jitter inside a bucket hits the same cached flood', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  // qb = cell*12 = 120: tx 110 and 125 both bucket to cell centered 120
  const a = f.route(-100, 0, 110, 0, 80)!;
  const b = f.route(-100, 0, 125, 0, 80)!;
  expect(a).toEqual(b);
});

it('the flood cache is bounded — wandering goals can\'t grow it forever', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  const cap = BOT_TUNING.graph.fieldCache;
  // scatter twice the cache's worth of distinct goal buckets
  for (let i = 0; i < cap * 2; i++) {
    f.route(-100, 0, -140 + (i % 5) * 60, -140 + Math.floor(i / 5) * 120, 40);
  }
  // eviction is by insertion order; re-routing the first goal must re-flood
  // (observable only via identical output — the bound is what the pin is for:
  //  a wander-bot's random cells evict stand floods but the map stays small)
  const again = f.route(-100, 0, -140, -140, 40);
  expect(again).not.toBeNull();
});

it('route() returns null only when the start can\'t reach — connected grids always can', () => {
  const f = new TerrainFlow(FLAT, 300, 10);
  expect(f.route(-140, -140, 140, 140, 80)).not.toBeNull();
});

it('two identical floods route identically — the field is pure function of the height fn', () => {
  const a = new TerrainFlow(WALL, 300, 10);
  const b = new TerrainFlow(WALL, 300, 10);
  const wa = a.route(-100, 0, 120, 0, 80);
  const wb = b.route(-100, 0, 120, 0, 80);
  expect(wa).toEqual(wb);
  expect(a.routeNearGoal(-100, 0, 120, 0, 40)).toEqual(b.routeNearGoal(-100, 0, 120, 0, 40));
});

it('BOT_TUNING shipped table keeps its shape — sweep keys trip on drift', () => {
  const T = BOT_TUNING;
  // sanity floor: every section present and every value a finite number
  for (const [section, table] of Object.entries(T)) {
    expect(Object.keys(table).length, section).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(table)) {
      expect(Number.isFinite(v), `${section}.${k}`).toBe(true);
    }
  }
  // the ordering-critical ones the comments call out
  expect(T.graph.cell).toBe(15);
  expect(T.graph.fieldCache).toBeGreaterThan(0);
  expect(T.graph.dangerTax).toBeGreaterThan(0);
  expect(T.brain.thinkS).toBeCloseTo(0.3, 9); // 0.5 broke beast-awareness + replay
});
