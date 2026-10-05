import { it, expect, beforeEach, afterEach } from 'bun:test';
import { BotLines } from '../../shared/botLines.ts';
import { BOT_TUNING as T } from '../../shared/botTuning.ts';
import { sharedEnv } from '../../shared/env.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

// BotLines: meso-scale line picking. Pins: close-out hands off to the
// steerer, commit window holds a line, downhill bias + sheer veto in
// the fan, goal-drift tolerance, the orbit latch's beeline escape,
// runner dive-glide straight at the objective, flow-field consult on
// long legs, twin replay.

const FLAT = () => 0;
const ctx = (over: Partial<BrainCtx> = {}): BrainCtx => ({ pos, enemies: [], now: 0, groundY: FLAT, ...over } as BrainCtx);
const dest = { x: 300, y: 0, z: 0 };
const pos = { x: 0, y: 0, z: 0 };

beforeEach(() => { sharedEnv.thinkProf = undefined; });
afterEach(() => { sharedEnv.thinkProf = undefined; });

it('inside the steerer\'s ring the goal passes straight through', () => {
  const l = new BotLines();
  const near = { x: T.lines.minGd - 5, y: 0, z: 0 };
  expect(l.plan(0.05, ctx(), pos, near)).toEqual(near);
});

it('runners get the wider close-out ring', () => {
  const l = new BotLines();
  const near = { x: T.lines.runnerDirectGd - 5, y: 0, z: 0 };
  expect(l.plan(0.05, ctx({ runner: true }), pos, near)).toEqual(near);
});

it('flat ground mid-range picks a waypoint inside the fan, biased toward the goal', () => {
  const l = new BotLines();
  const wp = l.plan(0.05, ctx(), pos, dest);
  expect(wp).not.toBe(dest);
  const d = Math.hypot(wp.x - pos.x, wp.z - pos.z);
  expect(d).toBeGreaterThan(T.lines.near);
  expect(d).toBeLessThanOrEqual(T.lines.reach + 1);
  expect(wp.x).toBeGreaterThan(0); // goal side of the bot
});

it('the commit window holds the rolled line — identical wp while lineT runs', () => {
  const l = new BotLines();
  const wp1 = l.plan(0.05, ctx(), pos, dest);
  for (let i = 0; i < 10; i++) {
    expect(l.plan(0.05, ctx(), pos, dest)).toBe(wp1);
  }
});

it('goal drift inside the cone keeps the committed line', () => {
  const l = new BotLines();
  const wp = l.plan(0.05, ctx(), pos, dest);
  const slid = { x: 290, y: 0, z: 20 }; // inside the fan of the old goal
  expect(l.plan(0.05, ctx(), pos, slid)).toBe(wp);
});

it('a ray fanned into a sheer drop is vetoed — all-sheer terrain rolls empty and returns the goal', () => {
  // cliff on every heading: 20m wall ring around the bot dropping -20 beyond
  const cliff = (x: number, z: number) => (Math.hypot(x, z) < 12 ? 0 : -25);
  const l = new BotLines();
  const wp = l.plan(0.05, ctx({ groundY: cliff }), pos, dest);
  expect(wp).toEqual(dest); // empty roll: walk at the goal, latch the result
});

it('downhill pockets beat flats — the drop wins over straightness', () => {
  // a dip dead ahead of the goal direction
  const dip = (x: number, z: number) => (x > 20 && x < 55 && Math.abs(z) < 20 ? -12 : 0);
  const l = new BotLines();
  const wp = l.plan(0.05, ctx({ groundY: dip }), pos, dest);
  // waypoint should land inside/through the dip, not off-angle
  expect(Math.abs(wp.z)).toBeLessThan(25);
  expect(wp.x).toBeGreaterThan(10);
});

it('the stagnation latch arms after staleLimit dead rolls and beelines the escape', () => {
  const l = new BotLines();
  // dt > commitS each call forces a re-roll with no progress → stale++
  let wp = pos;
  for (let i = 0; i < T.lines.staleLimit + 2; i++) {
    wp = l.plan(T.lines.commitS + 1, ctx(), pos, dest);
  }
  // orbit/give-up path: beeline leg at reach = min(40, gd)
  const d = Math.hypot(wp.x - pos.x, wp.z - pos.z);
  expect(d).toBeLessThanOrEqual(41);
  expect(d).toBeGreaterThan(5);
  expect(wp.x).toBeGreaterThan(0); // toward the goal, not sideways
});

it('a runner high over the objective dive-glides straight at it', () => {
  const l = new BotLines();
  const objective = { x: 280, y: 0, z: 0 };
  const high = { x: 0, y: 100, z: 0 }; // AGL 100, objective inside alt*4 glide
  const c = ctx({ runner: true, objective });
  const wp = l.plan(0.05, c, high, objective);
  expect(wp).toEqual(objective);
});

it('long legs consult the flow field before rolling', () => {
  const l = new BotLines();
  const routed = { x: 50, y: 3, z: 9 };
  let called = 0;
  const c = ctx({
    route: () => { called++; return routed; },
  });
  const far = { x: 300, y: 0, z: 0 }; // gd 300 > T.graph.minGd=140
  const wp = l.plan(0.05, c, pos, far);
  expect(called).toBe(1);
  expect(wp).toEqual(routed);
});

it('short legs skip the flow field — the fan owns them', () => {
  const l = new BotLines();
  let called = 0;
  const c = ctx({ route: () => { called++; return null; } });
  const near = { x: T.graph.minGd - 20, y: 0, z: 0 }; // still > minGd steerer ring
  l.plan(0.05, c, pos, near);
  expect(called).toBe(0);
});

it('the orbit latch tries remembered passes first, then beelines', () => {
  const l = new BotLines();
  const c = ctx();
  // Bank a pass: |Δy|>12 with gd < lastGd+60 files terrain the bot earned
  l.plan(0.05, c, { x: 10, y: -20, z: 0 }, dest); // lastY=-Inf → files (10,-20,0)
  l.plan(0.05, c, { x: 10, y: 0, z: 0 }, dest);   // files (10,0,0); note these
  // setup calls already tick the stagnation meter — the latch arms early
  const still = { x: 0, y: 0, z: 0 };
  const seen: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    seen.push(l.plan(T.lines.commitS + 1, c, still, dest));
  }
  // While the latch first arms, a goal-side remembered pass wins
  const passPick = seen.find(w => Math.hypot(w.x - 10, w.z) < 1);
  expect(passPick).toBeDefined();
  // After two escape picks without release, terrain scoring is abandoned —
  // the beeline leg lands at reach = min(40, gd) straight at the goal
  const last = seen[seen.length - 1]!;
  expect(last.x).toBeCloseTo(40, 3);
  expect(last.z).toBeCloseTo(0, 6);
});

it('two planners stepped identically stay identical — replay holds', () => {
  const a = new BotLines(), b = new BotLines();
  const ground = (x: number, z: number) => Math.sin(x * 0.01) * 15 + Math.cos(z * 0.02) * 8;
  const c = ctx({ groundY: ground, runner: true });
  let p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 40; i++) {
    const wa = a.plan(0.1, c, p, dest);
    const wb = b.plan(0.1, c, p, dest);
    expect(wa).toEqual(wb);
    p = { x: p.x + 3, y: ground(p.x + 3, p.z), z: p.z };
  }
});
