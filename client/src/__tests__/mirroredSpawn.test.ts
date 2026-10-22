import { describe, expect, it } from 'vitest';
import { mirroredSpawn } from '../game/combat/fire.js';
import type { WorldState } from '../game/worldState.js';

type Hist = WorldState['localPosHistory'];
const at = (backMs: number, tag: number): Hist[number] =>
  ({ t: performance.now() - backMs, x: tag, y: tag, z: tag, vx: tag * 100, vy: tag * 100, vz: tag * 100 });

describe('mirroredSpawn — server rewind-epoch mirror', () => {
  it('returns undefined with no rtt or empty history', () => {
    expect(mirroredSpawn([], 50)).toBeUndefined();
    expect(mirroredSpawn([at(10, 1)], 0)).toBeUndefined();
    expect(mirroredSpawn([at(10, 1)], -1)).toBeUndefined();
  });

  it('reads the origin sample ~0.7·(rtt/2) back', () => {
    // rtt=100 → origin epoch 35ms — latest sample ≤ now-35ms is the
    // 40ms-back entry (vel mirrors the shadow's live vel, not history).
    const hist: Hist = [at(80, 1), at(60, 2), at(40, 3), at(30, 4), at(10, 5)];
    expect(mirroredSpawn(hist, 100)!.x).toBe(3);
  });

  it('clamps to the oldest sample when epochs predate the ring', () => {
    const hist: Hist = [at(200, 1), at(100, 2), at(10, 3)];
    const m = mirroredSpawn(hist, 900)!;
    expect(m.x).toBe(1);
    expect(m.vx).toBe(100);
  });
});
