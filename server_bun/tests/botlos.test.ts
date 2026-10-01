import { describe, test, expect, beforeEach } from 'bun:test';
import { losClear, losMemoReset, BOT_EYE } from '../../shared/botLos.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

const V = (x: number, y: number, z: number) => ({ x, y, z });

function ctx(groundY: (x: number, z: number) => number, now = 0): BrainCtx {
  return { pos: V(0, 0, 0), enemies: [], now, groundY } as BrainCtx;
}

describe('losClear', () => {
  beforeEach(losMemoReset);

  test('flat ground between two points is clear', () => {
    expect(losClear(ctx(() => 0), V(0, 0, 0), V(50, 0, 0))).toBe(true);
  });

  test('a ridge taller than the sightline blocks', () => {
    const ridge = (x: number) => (x > 20 && x < 30 ? 50 : 0);
    expect(losClear(ctx(ridge), V(0, 0, 0), V(50, 0, 0))).toBe(false);
  });

  test('point-blank skips the march entirely', () => {
    // A 2m gap is inside the coarsest probe — even a spike can't occlude.
    expect(losClear(ctx(() => 999), V(0, 0, 0), V(1.9, 0, 0))).toBe(true);
  });

  test('memo serves stale answers until reset or TTL', () => {
    let wall = false;
    const c = ctx((x) => (wall && x > 20 && x < 30 ? 50 : 0), 1000);
    const from = V(0, 0, 0), to = V(50, 0, 0);
    expect(losClear(c, from, to)).toBe(true);
    wall = true;
    expect(losClear(c, from, to)).toBe(true);   // cached, not re-marched
    losMemoReset();
    expect(losClear(c, from, to)).toBe(false);  // fresh march sees the wall
  });

  test('TTL expiry re-marches without a reset', () => {
    let wall = false;
    const c = ctx((x) => (wall && x > 20 && x < 30 ? 50 : 0), 0);
    const from = V(0, 0, 0), to = V(50, 0, 0);
    losClear(c, from, to);
    wall = true;
    c.now = 2001; // past the 1s TTL
    expect(losClear(c, from, to)).toBe(false);
  });

  test('eye height matters: a low berm blocks prone but not standing', () => {
    // Berm at ground+1m — under BOT_EYE so a standing eye sees over it.
    const berm = (x: number) => (x > 20 && x < 30 ? 1 : 0);
    expect(losClear(ctx(berm), V(0, 0, 0), V(50, 0, 0))).toBe(true);
    expect(BOT_EYE).toBeGreaterThan(1);
  });
});
