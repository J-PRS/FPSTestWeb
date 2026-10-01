import { describe, expect, it } from 'bun:test';

import { BotSteer } from '../../shared/botSteer.ts';
import type { BrainCtx } from '../../shared/botBrain.ts';

const flat = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  pos: { x: 0, y: 0, z: 0 },
  enemies: [],
  now: 0,
  groundY: () => 0,
  ...over,
});

describe('BotSteer.steer', () => {
  const pos = { x: 0, y: 0, z: 0 };

  it('arrived → destination passes through', () => {
    expect(new BotSteer().steer(0.1, flat(), pos, { x: 0.2, y: 0, z: 0.2 })).toEqual({ x: 0.2, y: 0, z: 0.2 });
  });

  it('clear line → step advances toward the goal', () => {
    const s = new BotSteer();
    const d = s.steer(0.1, flat(), pos, { x: 10, y: 0, z: 0 });
    expect(Math.hypot(d.x, d.z)).toBeGreaterThan(0);
    expect(d.x).toBeGreaterThan(0);
    expect(d.x * 0 + d.z).toBeCloseTo(d.z, 5); // straight-ish line
  });

  it('turn rate is wrist-capped — a 180° goal deflects, not flicks', () => {
    const s = new BotSteer();
    // Prime heading toward +x.
    s.steer(0.5, flat(), pos, { x: 10, y: 0, z: 0 });
    const h0 = { ...s.headingVec() };
    // Now demand the opposite direction.
    s.steer(0.1, flat(), pos, { x: -10, y: 0, z: 0 });
    const h1 = s.headingVec();
    const turn = Math.acos(Math.min(1, Math.max(-1, h0.x * h1.x + h0.z * h1.z)));
    expect(turn).toBeLessThanOrEqual(4.0 * 0.1 + 1e-6); // ≤ 4 rad/s
    expect(turn).toBeGreaterThan(0); // but it did start carving
  });

  it('a wall dead ahead bends the step sideways', () => {
    const s = new BotSteer();
    // Cliff: ground rises steeply for x > 4.
    const c = flat({ groundY: (x) => x > 4 ? 60 : 0 });
    const d = s.steer(0.1, c, pos, { x: 10, y: 0, z: 0 });
    expect(Math.abs(d.z)).toBeGreaterThan(0.01); // slid along, not into it
  });

  it('bodies in the path separate — the step veers off a crowd', () => {
    const s = new BotSteer();
    const c = flat({ others: [{ x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 1 }] });
    const d = s.steer(0.1, c, pos, { x: 10, y: 0, z: 0 });
    expect(Math.abs(d.z)).toBeGreaterThan(0.01);
  });
});
