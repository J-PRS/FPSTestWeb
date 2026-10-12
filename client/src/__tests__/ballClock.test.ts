import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeBallClock, pruneNetBalls } from '../game/netBalls.js';

const mkX = (): { netKill: () => never; } => ({ netKill: (): never => { throw new Error('must not kill'); } });


// The server-sim clock: estSimNow rides an EMA of the sim→wall rate so a
// lagging server tick can't push prediction ahead of authority, and
// ballEventAge measures true staleness (stamp → arrival), not ping/2.
afterEach(() => vi.restoreAllMocks());

function wall(sec: number): void { vi.spyOn(performance, 'now').mockReturnValue(sec * 1000); }

describe('makeBallClock — sim-clock estimate', (): void => {
  it('reports Infinity before any stamp — no clock, no gate', (): void => {
    const c = makeBallClock((): number => 0);
    expect(c.estSimNow()).toBe(Infinity);
  });

  it('extrapolates from the newest stamp at rate 1', (): void => {
    const c = makeBallClock((): number => 0);
    wall(100); c.noteStamp(10);
    wall(100.5);
    expect(c.estSimNow()).toBeCloseTo(10.5, 9);
  });

  it('EMAs the sim→wall rate down when stamps arrive slower than wall time', (): void => {
    const c = makeBallClock((): number => 0);
    wall(100); c.noteStamp(10);
    wall(101); c.noteStamp(10.4); // ds=0.4 in dw=1.0 → r=0.4 clamped 0.5
    wall(101.5);
    // rate = 1 + (0.5-1)*0.2 = 0.9 → est = 10.4 + 0.5*0.9
    expect(c.estSimNow()).toBeCloseTo(10.85, 9);
  });

  it('ignores out-of-order stamps — the clock never rewinds', (): void => {
    const c = makeBallClock((): number => 0);
    wall(100); c.noteStamp(10);
    wall(101); c.noteStamp(9); // older — dropped
    wall(101.5);
    expect(c.estSimNow()).toBeCloseTo(10 + 1.5, 9);
  });

  it('ballEventAge clamps to [0, 0.6] and measures stamp-to-arrival age', (): void => {
    const c = makeBallClock((): number => 0);
    wall(100); c.noteStamp(10);
    wall(100.3);
    expect(c.ballEventAge(9.8)).toBeCloseTo(0.5, 9); // est 10.3 - 9.8
    wall(105);
    expect(c.ballEventAge(10)).toBe(0.6); // capped, not 5
    expect(c.ballEventAge(20)).toBe(0); // future stamp → 0, never negative
  });

  it('unstamped events fall back to ping/2 capped at 0.2', (): void => {
    const c = makeBallClock((): number => 300); // 300ms ping → 0.15
    expect(c.ballEventAge(undefined)).toBeCloseTo(0.15, 9);
    const c2 = makeBallClock((): number => 1000);
    expect(c2.ballEventAge(undefined)).toBe(0.2);
  });
});

describe('pruneNetBalls — roster reconciliation', (): void => {
  it('netKills tracked balls missing from the roster', (): void => {
    const killed: number[] = [];
    const mkLog = (): { netKill: () => number; } => ({ netKill: (): number => killed.push(0) });
    const map = new Map<number, { netKill(): void }>([[1, mkLog()], [2, mkLog()], [3, mkLog()]]);
    pruneNetBalls(map, new Set([2]));
    expect([...map.keys()]).toEqual([2]);
    expect(killed).toHaveLength(2);
  });


  it('leaves a fully-matching roster untouched', (): void => {
    const map = new Map<number, { netKill(): void }>([[1, mkX()]]);
    pruneNetBalls(map, new Set([1, 9]));
    expect(map.size).toBe(1);
  });
});
