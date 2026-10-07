import { it, expect, afterEach } from 'bun:test';
import { stuckBreak, dodge, type EscapeState } from '../../shared/botEscape.ts';
import { botRng, botRngRelease } from '../../shared/botRand.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

// botEscape: the get-out-of-the-way senses. Pins: dodge range/step,
// momentum-side pick, runner final-approach exemption, posted leash
// clamp + halved hop, hero sharpening; stuckBreak's fast pinned window,
// posted exemption, slow goal-distance window, escalating jet burst.

const FLAT = () => 0;
const dest = { x: 100, y: 0, z: 0 };
const origin = { x: 0, y: 0, z: 0 };

const ctx = (over: Partial<BrainCtx> = {}): BrainCtx =>
  ({ pos: origin, enemies: [], now: 0, groundY: FLAT, ...over } as BrainCtx);

const mkState = (): EscapeState => ({
  stuckStreak: 0, orbitStreak: 0, pinStreak: 0, escapeJetT: 0, detour: null, detourT: 0,
  progressPos: { x: 0, y: 0, z: 0 }, progressT: 0, goalWinT: 0,
  progressGoalD: 0, pinX: 0, pinZ: 0, pinT: 0, goal: { ...dest },
});

afterEach(() => botRngRelease());

// ---------- dodge ----------

it('no threats → the step destination passes through', () => {
  expect(dodge(ctx(), origin, dest, false)).toBe(dest);
});

it('a shell beyond the range gets ignored', () => {
  const c = ctx({ threats: [{ x: 20, y: 0, z: 0 }] });
  expect(dodge(c, origin, dest, false)).toBe(dest);
});

it('a closing shell gets a perpendicular hop that keeps momentum', () => {
  // shell closing from +z, bot moving +x → side should keep vx
  const c = ctx({ threats: [{ x: 0, y: 0, z: 6 }], vel: { x: 8, y: 0, z: 0 } });
  const w = dodge(c, origin, dest, false);
  const step = Math.hypot(w.x - origin.x, w.z - origin.z);
  expect(step).toBeCloseTo(9, 6); // DODGE_STEP
  // perpendicular to the threat vector (threat is on +z axis)
  expect(Math.abs(w.x)).toBeCloseTo(9, 6);
  expect(Math.abs(w.z)).toBeLessThan(1);
});

it('a runner inside 80m of the objective never jukes — arrival speed is the armor', () => {
  const objective = { x: 50, y: 0, z: 0 };
  const c = ctx({ runner: true, objective, threats: [{ x: 0, y: 0, z: 5 }] });
  expect(dodge(c, origin, dest, false)).toBe(dest);
  // same runner far from the objective DOES juke
  const far = { x: -200, y: 0, z: 0 };
  const c2 = ctx({ runner: true, objective: { x: 300, y: 0, z: 0 }, threats: [{ x: -200, y: 0, z: 5 }] });
  expect(dodge(c2, far, dest, false)).not.toEqual(dest);
});

it('a posted anchor hops half-length and never leaves the leash', () => {
  const objective = { x: 0, y: 0, z: 0 };
  const c = ctx({ posted: 2, objective, threats: [{ x: 0, y: 0, z: 4 }] });
  const w = dodge(c, origin, dest, false);
  const od = Math.hypot(w.x - objective.x, w.z - objective.z);
  expect(od).toBeLessThanOrEqual(2.0001); // leash clamp
});

it('hero senses see farther and hop longer', () => {
  const farShell = ctx({ threats: [{ x: 0, y: 0, z: 15 }] });
  expect(dodge(farShell, origin, dest, false)).toBe(dest);     // normal: 15 > 12
  const w = dodge(farShell, origin, dest, true);               // hero: 15 < 20.4
  const step = Math.hypot(w.x - origin.x, w.z - origin.z);
  expect(step).toBeCloseTo(9 * 1.4, 6);
});

// ---------- stuckBreak ----------

it('progress keeps the straight line — no streak, no detour', () => {
  const s = mkState();
  let p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 40; i++) {
    const w = stuckBreak(s, 0.05, ctx(), p, dest);
    p = { x: p.x + 2, y: 0, z: 0 }; // real movement every tick
    if (w !== dest) { /* detour would surface here */ }
  }
  expect(s.stuckStreak).toBe(0);
});

it('parked past the 1.5s window earns a streak + a walkable-route detour', () => {
  const s = mkState();
  const w = stuckBreak(s, 1.6, ctx(), origin, dest);
  expect(s.stuckStreak).toBe(1);
  expect(s.detour).not.toBeNull();
  expect(w).toBe(s.detour!);
  // flat ground every heading walks the same → the fan keeps the goal line
  const d = Math.hypot(w.x - origin.x, w.z - origin.z);
  expect(d).toBeCloseTo(14, 6);
  expect(w.x).toBeCloseTo(14, 6);
  expect(Math.abs(w.z)).toBeLessThan(0.001);
});

it('a wall dead ahead sends the detour down the walkable side — the ramp sense', () => {
  // +x is a sheer face (g jumps to 8 within 3m); every other heading is flat
  const wall = (x: number, _z: number) => (x > 2 ? 8 : 0);
  const s = mkState();
  const w = stuckBreak(s, 1.6, ctx({ groundY: wall }), origin, dest);
  expect(s.detour).not.toBeNull();
  expect(w).toBe(s.detour!);
  const d = Math.hypot(w.x - origin.x, w.z - origin.z);
  expect(d).toBeCloseTo(14, 6);
  // the route with no face wins — lateral detour, not into the wall
  expect(Math.abs(w.z)).toBeGreaterThan(7);
});

it('pinned through a detour escalates to the jet burst', () => {
  botRng(() => 0.2);
  const s = mkState();
  stuckBreak(s, 1.6, ctx(), origin, dest);          // streak 1
  const w = stuckBreak(s, 1.6, ctx(), origin, dest); // streak 2 → jet
  expect(s.stuckStreak).toBe(2);
  expect(s.escapeJetT).toBeGreaterThanOrEqual(1.1);
  expect(w).not.toBe(dest);
});

it('a posted anchor parked on its step is a hold, not a trap', () => {
  // parked-by-choice = standing on the step the brain asked for — the
  // same "arrived" test the watchdog applies to lastDest.
  const s = mkState();
  const post = { x: 1, y: 0, z: 0 };
  const c = ctx({ posted: 4, objective: { x: 0, y: 0, z: 0 } });
  for (let i = 0; i < 10; i++) {
    const w = stuckBreak(s, 1.6, c, origin, post);
    expect(w).toBe(post);
  }
  expect(s.stuckStreak).toBe(0);
  expect(s.escapeJetT).toBe(0);
});

it('the 4s goal-distance window catches an orbit the pinned check cannot', () => {
  botRng(() => 0.2);
  const s = mkState();
  s.progressGoalD = 100; // anchor: 100m out ~4s ago
  // bot moved real distance but goal distance only improved 1m
  const p = { x: 60, y: 0, z: 60 }; // gd to (100,0) ≈ 72 vs anchor 100? give no-gain: place at gd≈98
  const gd = Math.hypot(dest.x - p.x, dest.z - p.z);
  s.progressGoalD = gd + 2; // only 2m gained in 4s < 4m threshold
  const w = stuckBreak(s, 4.01, ctx(), p, dest);
  // the ORBIT streak arms — the pinned streak correctly resets (the bot
  // displaced real distance in the same call's fast window)
  expect(s.orbitStreak).toBe(1);
  expect(s.escapeJetT).toBeCloseTo(1.8, 6); // 1.1 + orbitStreak*0.7
  expect(w).not.toBe(dest);
});

it('consecutive ORBIT failures escalate the burst toward the 3s cap — the split streak survives displacement', () => {
  botRng(() => 0.2);
  const s = mkState();
  // real orbit: pos circles the goal at ~72m — big displacement, zero
  // goal-distance gain. The pinned streak must keep resetting while the
  // orbit streak accumulates (pre-fix the same field died each window).
  const jets: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 0.6;
    const p = { x: dest.x + Math.cos(a) * 72, y: 0, z: dest.z + Math.sin(a) * 72 };
    s.progressGoalD = 73; // anchor: ~1m "gain" per window, under the 4m floor
    stuckBreak(s, 4.01, ctx(), p, dest);
    jets.push(s.escapeJetT);
    s.escapeJetT = 0; // let each window's own escalation show
  }
  expect(s.orbitStreak).toBe(6);
  expect(s.stuckStreak).toBe(0); // real displacement zeroes the pinned counter
  expect(jets[0]!).toBeCloseTo(1.8, 6);
  expect(jets[2]!).toBeCloseTo(3.0, 6); // 1.1 + 3*0.7 = 3.2 → capped
  expect(jets[jets.length - 1]!).toBeLessThanOrEqual(3.0);
});

it('gaining real goal distance resets the streak', () => {
  botRng(() => 0.2);
  const s = mkState();
  const p = { x: 60, y: 0, z: 0 };
  s.progressGoalD = 80;
  stuckBreak(s, 1.6, ctx(), p, dest); // parked → streak 1 via fast window
  // now a 4s window that closed 40m → streak resets on the gain branch
  s.goalWinT = 3.9;
  s.progressGoalD = Math.hypot(dest.x - p.x, dest.z - p.z) + 40;
  stuckBreak(s, 0.2, ctx(), p, dest);
  expect(s.goalWinT).toBeCloseTo(0, 6);
});
