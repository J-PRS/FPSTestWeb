import { afterEach, describe, expect, it } from 'bun:test';

import { BotMoves } from '../../shared/botMoves.ts';
import { dodge, stuckBreak, type EscapeState } from '../../shared/botEscape.ts';
import { botRng } from '../../shared/botRand.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

const moves = () => new BotMoves({ escapeJetT: () => 0, huntPos: () => null });

afterEach(() => botRng(Math.random));

describe('BotMoves.hints', () => {
  it('arrived → all intents off', () => {
    const m = moves();
    expect(m.hints(0.1, flat(), { x: 0, y: 0, z: 0 }, { x: 0.3, y: 0, z: 0.3 })).toEqual({ ski: false, jet: false, jump: false });
  });

  it('Tribes default — ski is held whenever there is somewhere to be', () => {
    const m = moves();
    botRng(() => 0.99); // no jet re-arm
    const h = m.hints(0.1, flat({ energy: 10 }), { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    expect(h!.ski).toBe(true);
    expect(h!.jet).toBe(false); // flat ground, thin tank, no hunt target
  });

  it('steep climb ahead → jet burn', () => {
    const m = moves();
    botRng(() => 0);
    const c = flat({ groundY: (x) => x > 5 ? 10 : 0, energy: 50 });
    expect(m.hints(0.1, c, { x: 0, y: 0, z: 0 }, { x: 20, y: 10, z: 0 })!.jet).toBe(true);
  });

  it('climbing airborne target above → jet pursuit', () => {
    const m = new BotMoves({ escapeJetT: () => 0, huntPos: () => ({ x: 0, y: 20, z: 5 }) });
    botRng(() => 0);
    const c = flat({ energy: 50 });
    expect(m.hints(0.1, c, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 })!.jet).toBe(true);
  });

  it('empty tank suppresses the burn even uphill', () => {
    const m = moves();
    botRng(() => 0);
    const c = flat({ groundY: (x) => x > 5 ? 10 : 0, energy: 5 });
    expect(m.hints(0.1, c, { x: 0, y: 0, z: 0 }, { x: 20, y: 10, z: 0 })!.jet).toBe(false);
  });

  it('jet window latches — a flickering gate does not chop the burn', () => {
    const m = moves();
    botRng(() => 0);
    const uphill = flat({ groundY: (x) => x > 5 ? 10 : 0, energy: 50 });
    const p = { x: 0, y: 0, z: 0 };
    m.hints(0.1, uphill, p, { x: 20, y: 10, z: 0 }); // arms jetHold ~0.45-0.85s
    // Second tick on now-flat ground still reads as burning — the latch,
    // not the terrain probe, owns the decision.
    expect(m.hints(0.1, flat({ energy: 50 }), p, { x: 20, y: 0, z: 0 })!.jet).toBe(true);
  });
});

describe('dodge', () => {
  it('no threats → destination untouched', () => {
    expect(dodge(flat(), { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, false)).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('closing shell → perpendicular sidestep', () => {
    const c = flat({ threats: [{ x: 3, y: 0, z: 0 }] });
    const d = dodge(c, { x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }, false);
    expect(Math.abs(d.z)).toBeGreaterThan(0); // sidestep is lateral
    expect(d.x).toBeCloseTo(0, 5); // not through the threat
  });
});

describe('stuckBreak', () => {
  const state = (): EscapeState => ({
    stuckStreak: 0, escapeJetT: 0, detour: null, detourT: 0,
    progressPos: { x: 0, y: 0, z: 0 }, progressT: 0,
    goal: { x: 20, y: 0, z: 0 },
  });

  it('progressing → destination passes through', () => {
    const s = state();
    s.progressPos = { x: -10, y: 0, z: 0 }; // last progress sample far away
    const d = stuckBreak(s, 2, flat(), { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    expect(d).toEqual({ x: 5, y: 0, z: 0 });
    expect(s.stuckStreak).toBe(0);
  });

  it('pinned → lateral detour; twice pinned → escape jets', () => {
    const s = state();
    botRng(() => 0.6);
    const pos = { x: 0, y: 0, z: 0 };
    const d1 = stuckBreak(s, 2, flat(), pos, { x: 5, y: 0, z: 0 });
    expect(s.stuckStreak).toBe(1);
    expect(Math.abs(d1.z)).toBeGreaterThan(0); // sidestep off the goal line
    // Second pinned eval with the detour still committed → jet burst.
    s.detourT = 0.5;
    stuckBreak(s, 2, flat(), pos, { x: 5, y: 0, z: 0 });
    expect(s.stuckStreak).toBe(2);
    expect(s.escapeJetT).toBeGreaterThan(1);
  });
});
