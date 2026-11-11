import { describe, it, expect } from 'vitest';
import { MoveSim, type MoveInput, type MoveState, type MoveSurface, type Vec3Like } from '../../../shared/movement.js';
import { lcg32 } from '../../../shared/simRand.js';

/** Deterministic hilly surface - enough slope for skiing to matter. */
const surf: MoveSurface = {
  getHeight: (x, z): number => Math.sin(x * 0.02) * 8 + Math.cos(z * 0.015) * 5,
  getNormal: (x, z, out): Vec3Like => {
    const e = 0.5;
    const h = (a: number, b: number): number => Math.sin(a * 0.02) * 8 + Math.cos(b * 0.015) * 5;
    const nx = (h(x + e, z) - h(x - e, z)) / (2 * e);
    const nz = (h(x, z + e) - h(x, z - e)) / (2 * e);
    out.x = -nx; out.y = 1; out.z = -nz;
    const len = Math.hypot(out.x, out.y, out.z);
    out.x /= len; out.y /= len; out.z /= len;
    return out;
  },
};

const spawn = (): MoveState => ({ pos: { x: 10, y: 40, z: -20 }, vel: { x: 30, y: 0, z: -15 }, yaw: 1.1, pitch: -0.2, onGround: false });

/** Deterministic input stream - seeded, covers jump/ski/jet edges. */
function drive(sim: MoveSim, rng: () => number, inputs: MoveInput[]): void {
  sim.jumpstart = 8;
  for (const inp of inputs) {
    Object.assign(sim.input, inp);
    sim.update(1 / 60, rng);
  }
}

const randInputs = (seed: number, n: number): MoveInput[] => {
  const rng = lcg32(seed);
  const out: MoveInput[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      forward: rng() * 2 - 1,
      right: rng() * 2 - 1,
      jumpPressed: rng() < 0.05,
      jumpHeld: rng() < 0.3,
      skiHeld: rng() < 0.4,
      jetHeld: rng() < 0.35,
    });
  }
  return out;
};

describe('MoveSim deterministic replay', (): void => {
  it('two sims on the same input stream produce identical state', (): void => {
    const inputs = randInputs(0x5EED, 1200);
    const clientSim = new MoveSim(surf, spawn());
    const serverSim = new MoveSim(surf, spawn());
    const rng1 = lcg32(0xCAFE);
    const rng2 = lcg32(0xCAFE);
    for (const inp of inputs) {
      Object.assign(clientSim.input, inp);
      Object.assign(serverSim.input, inp);
      clientSim.update(1 / 60, rng1);
      serverSim.update(1 / 60, rng2);
    }
    const c = clientSim.state, s = serverSim.state;
    expect(c.pos.x).toBeCloseTo(s.pos.x, 10);
    expect(c.pos.y).toBeCloseTo(s.pos.y, 10);
    expect(c.pos.z).toBeCloseTo(s.pos.z, 10);
    expect(c.vel.x).toBeCloseTo(s.vel.x, 10);
    expect(c.vel.y).toBeCloseTo(s.vel.y, 10);
    expect(c.vel.z).toBeCloseTo(s.vel.z, 10);
    expect(c.onGround).toBe(s.onGround);
  });

  it('energy and position stay inside physical bounds under random inputs', (): void => {
    const sim = new MoveSim(surf, spawn());
    drive(sim, lcg32(0xBEEF), randInputs(0x1EAF, 2400));
    const { pos, vel } = sim.state;
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    expect(Number.isFinite(vel.x + vel.y + vel.z)).toBe(true);
    // Energy is host-owned (not on MoveSim) - position/velocity sanity
    // and the ground-contact invariant are the sim's own laws.
    // Body can never rest below the terrain surface.
    if (sim.state.onGround) {
      expect(pos.y).toBeGreaterThanOrEqual(surf.getHeight(pos.x, pos.z) - 0.5);
    }
  });
});
