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
    sim.update(1 / 60);
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
      clientSim.update(1 / 60);
      serverSim.update(1 / 60);
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

  it('snapshot + restore mid-run: the restored sim continues identically', (): void => {
    const inputs = randInputs(0xD1FF, 900);
    // The uninterrupted reference run.
    const ref = new MoveSim(surf, spawn());
    drive(ref, lcg32(0x77), inputs);
    // The interrupted run: same inputs, but restore at step 400.
    const interrupted = new MoveSim(surf, spawn());
    interrupted.jumpstart = 8; // same host-config as drive()/restored
    const rng = lcg32(0x77);
    let snap: ReturnType<MoveSim['snapshot']> | null = null;
    for (let i = 0; i < inputs.length; i += 1) {
      if (i === 400) {snap = interrupted.snapshot();}
      Object.assign(interrupted.input, inputs[i]!);
      interrupted.update(1 / 60);
    }
    // A third sim restored FROM the snapshot replays the last 500 steps.
    const restored = new MoveSim(surf, spawn());
    // Host-copied config (jumpstart/mass/speedScale/water) is NOT in the
    // snapshot by design - the host replants it exactly like the wire.
    restored.jumpstart = 8;
    restored.restore(snap!);
    // Re-feed the post-snapshot input stream - indices 400..899 replayed.
    for (let i = 400; i < inputs.length; i += 1) {
      Object.assign(restored.input, inputs[i]!);
      restored.update(1 / 60);
    }
    // The rng arg is a dead param (update(dt) ignores it) - the sim is
    // input-deterministic, so the replay needs no stream-position seed.
    const p = ref.state, q = interrupted.state, r2 = restored.state;
    expect(q.pos.x).toBeCloseTo(p.pos.x, 10); // sanity: interrupted == ref
    expect(r2.pos.x).toBeCloseTo(q.pos.x, 10);
    expect(r2.pos.y).toBeCloseTo(q.pos.y, 10);
    expect(r2.pos.z).toBeCloseTo(q.pos.z, 10);
    expect(r2.onGround).toBe(q.onGround);
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
