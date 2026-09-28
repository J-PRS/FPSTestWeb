import { describe, it, expect } from 'vitest';
import { BotBrain, type BrainCtx } from '../../../shared/botBrain.js';

const flat = () => 0;
function ctx(pos: { x: number; y: number; z: number }, groundY: (x: number, z: number) => number = flat, extra: Partial<BrainCtx> = {}): BrainCtx {
  return { pos, enemies: [], groundY, now: 0, ...extra };
}

describe('BotBrain pathing', () => {
  it('walks toward the goal on open ground', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 0, z: 0 };
    const out = b.think(0.4, ctx(pos, flat, { objective: { x: 100, y: 0, z: 0 } }));
    const dx = out.dest.x - pos.x, dz = out.dest.z - pos.z;
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.5);
    expect(dx).toBeGreaterThan(0); // +x is the goal direction
  });

  it('slides along the contour when the step climbs a wall', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    // Wall at x>3 — ground jumps 20m; the 4m-ahead probe lands on it
    const wall = (x: number) => (x > 3 ? 20 : 0);
    const pos = { x: 0, y: 0, z: 0 };
    const out = b.think(0.4, ctx(pos, wall, { objective: { x: 100, y: 20, z: 0 } }));
    // Deflected perpendicular (|z| grows) rather than straight into the wall
    expect(Math.abs(out.dest.z)).toBeGreaterThan(Math.abs(out.dest.x));
  });

  it('detours sideways when it has made no progress', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 0, z: 0 };
    const objective = { x: 0, y: 0, z: 100 };
    // First think adopts the goal; then simulate a stalled bot — pos never moves
    b.think(0.4, ctx(pos, flat, { objective }));
    let out = b.think(1.5, ctx(pos, flat, { objective }));
    out = b.think(0.1, ctx(pos, flat, { objective }));
    // Stuck → perpendicular sidestep: x must dominate over the goal's +z line
    expect(Math.abs(out.dest.x)).toBeGreaterThan(5);
  });
});

describe('BotBrain senses', () => {
  const enemy = (x: number, z: number): BrainCtx['enemies'] => [
    { id: 'e1', pos: { x, y: 1.6, z }, vel: { x: 0, y: 0, z: 0 }, alive: true },
  ];

  it('acquires and fires on a visible enemy', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    const out = b.think(0.4, ctx(pos, flat, { enemies: enemy(20, 0) }));
    expect(out.fire).toBeDefined();
    expect(out.fire!.targetId).toBe('e1');
  });

  it('ignores an enemy behind a hill — no wallhack', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    // Ridge 30m tall spanning x∈(10,30) — the eye line eats it
    const ridge = (x: number) => (x > 10 && x < 30 ? 30 : 0);
    const out = b.think(0.4, ctx(pos, ridge, { enemies: enemy(50, 0) }));
    expect(out.fire).toBeUndefined();
    // No hunt → no approach toward the target either
    expect(out.dest.x).toBeLessThan(10);
  });

  it('holds a good spot instead of orbiting when position-picking', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    // Enemy at mid-range on flat ground — "here" should score well enough
    // that the inertia bonus keeps it (or picks a valid nearby spot).
    const out = b.think(0.4, ctx(pos, flat, { enemies: enemy(15, 0) }));
    expect(Math.hypot(out.dest.x - pos.x, out.dest.z - pos.z)).toBeLessThanOrEqual(14);
  });
});
