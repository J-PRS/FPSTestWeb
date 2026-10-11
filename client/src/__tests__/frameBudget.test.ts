import { describe, expect, it, vi, afterEach } from 'vitest';

import { createFrameBudget } from '../core/frameBudget.js';
import { codeLabel, codeFor, matchCode, rebind, resetAll, type BindAction } from '../core/keybinds.js';

let now = 0;
const spy = () => vi.spyOn(performance, 'now').mockImplementation((): number => now);

afterEach(() => vi.restoreAllMocks());

describe('frameBudget.each', (): void => {
  it('processes the whole list under a generous cap and splices the prefix', (): void => {
    spy();
    const b = createFrameBudget();
    const items = [1, 2, 3];
    const seen: number[] = [];
    const left = b.each('job', items, 100,( i): void => { now += 1; seen.push(i); });
    expect(seen).toEqual([1, 2, 3]);
    expect(left).toBe(0);
    expect(items).toHaveLength(0); // consumed prefix spliced out
    expect(b.stats().job.backlog).toBe(0);
  });

  it('stops at the ms cap and resumes the remainder next call', (): void => {
    spy();
    const b = createFrameBudget();
    const items = [1, 2, 3, 4, 5];
    const seen: number[] = [];
    // Each item takes 6ms; cap 10 → two items per call.
    const left1 = b.each('job', items, 10,( i): void => { now += 6; seen.push(i); });
    expect(left1).toBe(3);
    expect(seen).toEqual([1, 2]);
    const left2 = b.each('job', items, 10,( i): void => { now += 6; seen.push(i); });
    expect(left2).toBe(1);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(items).toEqual([5]); // backlog stays for the next call
    expect(b.stats().job.backlog).toBe(1);
    expect(b.stats().job.perFrame).toBe(2);
  });
});

describe('frameBudget.sweep', (): void => {
  it('fires at most once per interval', (): void => {
    spy();
    const b = createFrameBudget();
    const fn = vi.fn();
    // First call may or may not fire (name-hash phase); drive past the
    // max possible phase then assert interval gating.
    now += 200;
    b.sweep('s', 50, fn);
    now += 60;
    b.sweep('s', 50, fn); // may have fired once here
    const calls = fn.mock.calls.length;
    now += 10;
    b.sweep('s', 50, fn);
    expect(fn.mock.calls.length).toBe(calls); // too soon — gated
    now += 50;
    b.sweep('s', 50, fn);
    expect(fn.mock.calls.length).toBe(calls + 1);
  });
});

describe('keybinds', (): void => {
  it('rebind swaps the stolen key back to the action that lost it', (): void => {
    resetAll();
    const a: BindAction = 'forward', b: BindAction = 'back';
    const aKey = codeFor(a), bKey = codeFor(b);
    rebind(a, bKey);
    expect(codeFor(a)).toBe(bKey);
    expect(codeFor(b)).toBe(aKey); // swap, not steal
    resetAll();
  });

  it('Shift binds match either physical Shift key', (): void => {
    resetAll();
    // Find an action bound to a Shift if any; otherwise rebind one.
    rebind('jump', 'ShiftLeft');
    expect(matchCode('jump', 'ShiftRight')).toBe(true);
    expect(matchCode('jump', 'KeyX')).toBe(false);
    resetAll();
  });

  it('codeLabel prints friendly names', (): void => {
    expect(codeLabel('KeyW')).toBe('W');
    expect(codeLabel('Mouse0')).toBe('LMB');
    expect(codeLabel('ArrowUp')).toBe('↑');
  });
});
