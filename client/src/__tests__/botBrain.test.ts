import { describe, it, expect, vi } from 'vitest';
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

  it('sidesteps perpendicular to an inbound shell', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    // Shell closing in from +x — the dodge must move off the x-axis.
    const out = b.think(0.4, ctx(pos, flat, {
      threats: [{ x: 8, y: 1.6, z: 0 }],
      vel: { x: 5, y: 0, z: 0 },
    }));
    expect(Math.abs(out.dest.z)).toBeGreaterThan(2);
  });

  it('walks toward a heard fight', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    // Noise at +x, 30m out — most personalities take the bait; retry a
    // few thinks so the curiosity roll can't flake the assertion.
    let moved = false;
    for (let i = 0; i < 12 && !moved; i++) {
      const out = b.think(0.35, ctx(pos, flat, { sounds: [{ x: 30, y: 0, z: 0 }] }));
      moved = moved || out.dest.x - pos.x > 2;
    }
    expect(moved).toBe(true);
  });

  it('avoids wandering back to a death spot', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    b.markDeath({ x: 0, y: 0, z: 20 }); // died just north
    // Wander goals that land inside the repel radius get re-rolled — run
    // several think cadences; none should settle ~north of the body.
    for (let i = 0; i < 12; i++) b.think(4, ctx(pos, flat, {}));
    const goal = (b as unknown as { goal: { x: number; z: number } }).goal;
    expect(Math.hypot(goal.x, goal.z - 20) > 12 || Math.hypot(goal.x - pos.x, goal.z - pos.z) < 15).toBe(true);
  });

  it('pushes toward an unseen attacker after a hit', () => {
    const b = new BotBrain({ x: 0, y: 0, z: 0 });
    const pos = { x: 0, y: 1.6, z: 0 };
    b.think(0.4, ctx(pos, flat, {})); // settle a wander goal
    b.takeHit({ x: 50, y: 0, z: 0 });
    // Skip the flinch window, then the goal should swing toward +x.
    b.think(0.5, ctx(pos, flat, {}));
    const out = b.think(0.4, ctx(pos, flat, {}));
    expect(out.dest.x - pos.x).toBeGreaterThan(0);
  });

  it('a hurt non-hero bot retreats from the shooter but keeps firing', () => {
    // Force the hero roll off so the fear path is deterministic.
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    try {
      const b = new BotBrain({ x: 0, y: 0, z: 0 });
      const pos = { x: 0, y: 1.6, z: 0 };
      b.think(0.4, ctx(pos, flat, { enemies: enemy(20, 0), healthFrac: 0.2, now: 0 }));
      const out = b.think(0.35, ctx(pos, flat, { enemies: enemy(20, 0), healthFrac: 0.2, now: 350 }));
      expect(out.dest.x - pos.x).toBeLessThan(0); // backing away from +x
      // Suppression continues — fire lands on a cadence tick somewhere
      // in the next couple seconds.
      let fired = false;
      for (let i = 1; i <= 8 && !fired; i++) {
        fired = !!b.think(0.35, ctx(pos, flat, { enemies: enemy(20, 0), healthFrac: 0.2, now: 350 + i * 350 })).fire;
      }
      expect(fired).toBe(true);
    } finally {
      roll.mockRestore();
    }
  });

  it('a hero bot pushes into the fight even while hurt', () => {
    // Force the hero roll on — the rising edge of hurt arms hero mode.
    const roll = vi.spyOn(Math, 'random').mockReturnValue(0.0);
    try {
      const b = new BotBrain({ x: 0, y: 0, z: 0 });
      const pos = { x: 0, y: 1.6, z: 0 };
      b.think(0.4, ctx(pos, flat, { healthFrac: 0.2, now: 0 })); // arm hero
      const out = b.think(0.35, ctx(pos, flat, { enemies: enemy(30, 0), healthFrac: 0.2, now: 350 }));
      expect(out.dest.x - pos.x).toBeGreaterThan(0); // closes instead of retreating
    } finally {
      roll.mockRestore();
    }
  });
});
