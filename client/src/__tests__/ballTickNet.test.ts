import { describe, it, expect } from 'vitest';
import { tickNet, newNetBag, type NetStatics, type NetHost } from '../entities/ballNet.js';
import { makeSimBall, BALL_GRAVITY } from '../../../shared/ballSim.js';
import type { Heightfield } from '../../../shared/heightfield.js';
import * as THREE from 'three';

// Prediction-loop invariants: the replay sim advances ONLY on the server's
// 0.05 grid, never ahead of the stamped sim clock (except the 0.5s
// stall-breaker), and render position is the ballistic sub-cell remainder.
// One-pixel heightmap: a real Heightfield so hmHeight resolves; the ball
// starts at y=1000 so terrain contact never confounds the bookkeeping.
const FLAT: Heightfield = { size: 1, data: new Uint8Array([0]), stride: 1 };

function rig(simNow: () => number | undefined = (): number => Infinity): { st: NetStatics; bag: ReturnType<typeof newNetBag>; host: NetHost } {
  const st: NetStatics = {
    field: (): Heightfield => FLAT,
    simNow,
    colliders: (): never[] => [],
    colliderIndex: (): null => null,
  };
  const bag = newNetBag();
  // y=1000 keeps the ball in free space — no terrain/structure contact
  // confounds the grid bookkeeping being tested.
  bag.sim = makeSimBall(1, 0, 0, { x: 0, y: 1000, z: 0 }, { x: 10, y: 0, z: 0 });
  const host: NetHost = {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    renderOffset: new THREE.Vector3(), emissive: new THREE.Color(),
    enraged: false, enrageTimer: 0, dampNextBounce: false, dead: false,
  };
  return { st, bag, host };
}

describe('tickNet — grid discipline', (): void => {
  it('consumes only whole 0.05 cells; simT stays on the grid', (): void => {
    const { st, bag, host } = rig();
    tickNet(st, bag, host, 0.12);
    expect(bag.simT).toBeCloseTo(0.1, 9); // two cells
    expect(bag.netAcc).toBeCloseTo(0.02, 9); // remainder banked
    // host.pos carries the unconsumed fraction ballistically
    expect(host.pos.x).toBeCloseTo(bag.sim!.x + bag.sim!.vx * 0.02, 9);
  });

  it('a sub-cell dt never steps the sim', (): void => {
    const { st, bag, host } = rig();
    tickNet(st, bag, host, 0.03);
    expect(bag.simT).toBe(0);
    expect(bag.netAcc).toBeCloseTo(0.03, 9);
    expect(host.pos.y).toBeCloseTo(1000 + 0.5 * BALL_GRAVITY * 0.03 * 0.03, 9);
  });

  it('never runs ahead of the stamped sim clock', (): void => {
    const { st, bag, host } = rig((): number => 0.07); // only one cell of headroom
    tickNet(st, bag, host, 0.2);
    // gated: simT + 0.05 <= simNow → one step at most... but netAcc
    // reaches 0.15, under the 0.5 stall-breaker, so it must hold.
    expect(bag.simT).toBeCloseTo(0.05, 9);
    expect(bag.netAcc).toBeCloseTo(0.15, 9);
  });

  it('stall-breaker: a full 0.5s bank steps anyway so clock stalls never freeze the sim', (): void => {
    const { st, bag, host } = rig((): number => 0); // clock claims nothing is replayable
    tickNet(st, bag, host, 0.5); // banks to exactly the cap
    // gated path can't step (simNow=0), but the stall-breaker drains it.
    expect(bag.simT).toBeCloseTo(0.5, 9);
    expect(bag.netAcc).toBeCloseTo(0, 9);
  });

  it('cell consumption is paced: a burst backlog pays down over frames instead of one leap', (): void => {
    const { st, bag, host } = rig((): number => 10); // simNow wide open
    tickNet(st, bag, host, 0.25); // 5 cells available
    expect(bag.simT).toBeCloseTo(0.1, 9); // only 2 cells this call
    expect(bag.netAcc).toBeCloseTo(0.15, 9); // backlog stays banked
    tickNet(st, bag, host, 0); // next frame pays down 2 more
    expect(bag.simT).toBeCloseTo(0.2, 9);
  });

  it('banks at most 0.5s of lead — long hitches cannot fast-forward', (): void => {
    const { st, bag, host } = rig();
    tickNet(st, bag, host, 2);
    expect(bag.simT).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('marks parked when the sim has fully settled', (): void => {
    const { st, bag, host } = rig();
    bag.sim!.vx = 0; bag.sim!.vy = 0; bag.sim!.vz = 0;
    tickNet(st, bag, host, 0.01);
    expect(bag.parked).toBe(true);
  });
});
