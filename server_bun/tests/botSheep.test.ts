import { expect, it } from 'bun:test';
import { SheepCore, type SheepSample } from '../../shared/botSheep.ts';

// SheepCore runs on sim time only — step(dt) is the whole clock, so every
// expectation below is exact arithmetic, no wall-clock tolerance.

const parked: SheepSample = {
  pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
  height: 0, dt: 1, foe: false, hasDest: false,
};
const tribesing: SheepSample = {
  ...parked, vel: { x: 40, y: 0, z: 0 }, jetting: true,
};

it('unproven bodies read a full meter — llama until proven', () => {
  const c = new SheepCore();
  expect(c.of('ghost')).toBe(100);
});

it('a parked body with no destination stays pinned at the cap', () => {
  const c = new SheepCore();
  c.step(1);
  const v = c.tick('a', parked);
  expect(v.meter).toBe(100);
  expect(v.newlyMaxed).toBe(false); // starts at the cap — not a rise
  expect(v.crossedHigh).toBe(false);
});

it('real play drains at the rate cap — never more than 30/s', () => {
  const c = new SheepCore();
  c.step(1);
  // 40 m/s + jetting → tribesing; base = -min(12 + 40*0.6 + 15, 30) = -30
  const v = c.tick('a', { ...tribesing, dt: 1 });
  expect(v.meter).toBe(70);
  expect(v.newlyMaxed).toBe(false);
});

it('proven play buys ~20s of trickle-charge grace', () => {
  const c = new SheepCore();
  c.step(1);
  c.tick('a', tribesing); // proves the body
  c.set('a', 50);
  c.step(1);
  // foe excuses the deadstop bleed; refusingFire override isolates the
  // excused trickle from the ignore debit.
  const v = c.tick('a', { ...parked, hasDest: false, foe: true, refusingFire: false });
  expect(v.meter).toBe(52); // excused → +2/s, not the parked +18/s
});

it('slamming to a deadstop bleeds once — the instant E drop signature', () => {
  const c = new SheepCore();
  c.step(1);
  c.tick('a', tribesing); // mech 800 recorded
  c.set('a', 50);
  c.step(1);
  const v = c.tick('a', parked); // mech 0 → bleed = min(8, 800*0.08) = 8
  expect(v.meter).toBe(50 + 8 + 2); // excused trickle + deadstop bleed
  expect(v.why.bleed).toBeCloseTo(8, 9);
});

it('claiming a destination halves the pedestrian charge', () => {
  const c = new SheepCore();
  c.set('a', 50);
  c.step(1);
  const v = c.tick('a', { ...parked, hasDest: true }); // dest undefined → not atPost
  expect(v.meter).toBe(59); // +9/s
  expect(v.crossedHigh).toBe(false); // 50 -> 59 never reaches 60
  expect(v.why.idle).toBeCloseTo(9, 9);
});

it('crossedHigh fires only on the upward 60 crossing', () => {
  const c = new SheepCore();
  c.set('a', 50);
  c.step(1);
  const v = c.tick('a', parked); // no dest → +18 → 68
  expect(v.crossedHigh).toBe(true);
  c.step(1);
  const v2 = c.tick('a', parked); // already above → stays armed off
  expect(v2.crossedHigh).toBe(false);
});

it('newlyMaxed fires once on the rise into the cap', () => {
  const c = new SheepCore();
  c.set('a', 90);
  c.step(1);
  const v = c.tick('a', parked); // +18 → clamped 100
  expect(v.meter).toBe(100);
  expect(v.newlyMaxed).toBe(true);
  c.step(1);
  expect(c.tick('a', parked).newlyMaxed).toBe(false); // rise already reported
});

it('the coverage window debits a body claiming a dest it never reaches', () => {
  const c = new SheepCore();
  // First call opens the 5s window; five stationary seconds under a
  // hasDest claim owe 20 — no dest claim, no debit.
  expect(c.coverageDebit('a', parked.pos, true, 0)).toBe(0);
  expect(c.coverageDebit('a', parked.pos, true, 5001)).toBe(20);
  // Window reset: real displacement clears the next period.
  expect(c.coverageDebit('a', { x: 40, y: 0, z: 0 }, true, 5002)).toBe(0);
  expect(c.coverageDebit('a', { x: 80, y: 0, z: 0 }, true, 10003)).toBe(0); // 80m covered
});

it('clear() is a fresh leash — every per-id cell resets', () => {
  const c = new SheepCore();
  c.step(1);
  c.tick('a', tribesing);
  c.set('a', 42);
  c.clear('a');
  expect(c.of('a')).toBe(100);
  expect(c.energyOf('a')).toBeUndefined();
  // Re-tick behaves like a brand-new unproven body.
  c.step(1);
  expect(c.tick('a', tribesing).meter).toBe(70);
});

it('rekey carries the earned meter to the new identity', () => {
  const c = new SheepCore();
  c.step(1);
  c.tick('a', tribesing);
  c.set('a', 42);
  c.rekey('a', 'b');
  expect(c.of('a')).toBe(100); // old id forgotten, not frozen
  expect(c.of('b')).toBe(42);  // new id inherits
});

it('noteFire keeps an engaged body out of the refuse-to-fire debit', () => {
  const c = new SheepCore();
  c.step(1);
  c.noteFire('a');
  expect(c.notShooting('a')).toBe(false);
  c.step(4); // 3s recency window lapses
  expect(c.notShooting('a')).toBe(true);
});
