import { describe, expect, it } from 'vitest';
import { histAt } from '../game/combat/fire.js';
import type { WorldState } from '../game/worldState.js';

type Hist = WorldState['localPosHistory'];
const at = (backMs: number, tag: number): Hist[number] =>
  ({ t: performance.now() - backMs, x: tag, y: tag, z: tag, vx: tag * 100, vy: tag * 100, vz: tag * 100 });

describe('histAt — local-position epoch reads (ghost sweeps)', () => {
  it('returns undefined on empty history only', () => {
    expect(histAt([], 50)).toBeUndefined();
    // A present sample answers even a degenerate back-off — the caller
    // decides what epoch means, not the sampler.
    expect(histAt([at(10, 1)], 0)!.x).toBe(1);
    expect(histAt([at(10, 1)], -1)!.x).toBe(1);
  });

  it('picks the latest sample at-or-before the epoch', () => {
    const hist: Hist = [at(80, 1), at(60, 2), at(40, 3), at(30, 4), at(10, 5)];
    expect(histAt(hist, 35)!.x).toBe(3); // 40-back is newest ≤ now-35
    expect(histAt(hist, 0)!.x).toBe(5);
  });

  it('clamps to the oldest sample when epochs predate the ring', () => {
    const hist: Hist = [at(200, 1), at(100, 2), at(10, 3)];
    const m = histAt(hist, 900)!;
    expect(m.x).toBe(1);
    expect(m.vx).toBe(100);
  });
});
