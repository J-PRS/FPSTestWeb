import { describe, it, expect } from 'bun:test';
import { losClear, losMemoReset, losMemoSize } from '../../../shared/botLos.ts';
import type { BrainCtx } from '../../../shared/botBrain.ts';

// The LOS memo is a module-global cache shared by every bot — it must
// bound itself or a busy roster grows it without limit. The bound is a
// 4096-entry cap: an expiry sweep first, a full clear if that isn't
// enough, then the new entry lands (worst live size = cap + 1).
const ctx = (now: number): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now,
  groundY: () => 0,
} as unknown as BrainCtx);

describe('scenario: losMemo stays bounded', () => {
  it('a flood of distinct sightlines never exceeds cap + 1', () => {
    losMemoReset();
    for (let i = 0; i < 6000; i++) {
      // All same `now` — nothing expires mid-flood, so the clear branch
      // is what holds the bound.
      losClear(ctx(0), { x: i * 10, y: 0, z: 0 }, { x: i * 10 + 500, y: 0, z: 500 });
    }
    expect(losMemoSize()).toBeLessThanOrEqual(4097);
    expect(losMemoSize()).toBeGreaterThan(0);
  });

  it('expired entries sweep before the hard clear', () => {
    losMemoReset();
    // Dead entries (until = 1000) that a later-now sweep must evict
    // without touching live ones — exercised by staying under the
    // clear threshold after the sweep.
    for (let i = 0; i < 200; i++) {
      losClear(ctx(0), { x: i * 20, y: 0, z: 0 }, { x: i * 20 + 500, y: 0, z: 500 });
    }
    // 4000 fresh entries at a later now: at size 4097 the sweep kills
    // the 200 dead ones, size drops under the cap — no full clear, so
    // all 4000 fresh entries plus the last one stay resident.
    for (let i = 0; i < 4000; i++) {
      losClear(ctx(5000), { x: i * 30, y: 0, z: 700 }, { x: i * 30 + 600, y: 0, z: 1200 });
    }
    expect(losMemoSize()).toBeLessThanOrEqual(4097);
    expect(losMemoSize()).toBeGreaterThan(3900);
  });
});
