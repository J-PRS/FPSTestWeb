import { describe, it, expect } from 'bun:test';
import { RoomMoveSim } from '../src/RoomMoveSim.ts';
import { MoveSim } from '../../shared/movement.ts';
import { FieldSurface } from '../../shared/fieldSurface.ts';
import { lcg32 } from '../../shared/simRand.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { MoveInput } from '../../shared/movement.ts';

/** Wrapper-vs-bare-sim differential: for inputs the wrapper's gating
 *  never touches (no jet drain, never resting), a tracked shadow must
 *  produce the identical trajectory the shared sim computes directly.
 *  This is the parity law the netcode's whole claim path rests on. */

const flat: Heightfield = { size: 2, data: new Uint8Array(4).fill(60), stride: 1 };
const DT = 1 / 30;

const stream = (seed: number, n: number): MoveInput[] => {
  const rng = lcg32(seed);
  return Array.from({ length: n }, (): MoveInput => ({
    forward: rng() * 2 - 1, right: rng() * 2 - 1,
    jumpPressed: rng() < 0.05, jumpHeld: rng() < 0.3,
    skiHeld: rng() < 0.4, jetHeld: false,
  }));
};

const spawnState = (): { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number; pitch: number; onGround: boolean } =>
  ({ pos: { x: 0, y: 5, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0.4, pitch: 0, onGround: true });

describe('RoomMoveSim vs bare MoveSim - wrapper neutrality', () => {
  it('non-jetting inputs: shadow trajectory equals the bare sim exactly', () => {
    const inputs = stream(0xCAFE, 150); // 5s of ski+move chaos, no jet
    const room = new RoomMoveSim(flat);
    room.track('p', { x: 0, y: 5, z: 0 }, 0.4);
    const bare = new MoveSim(FieldSurface.fromField(flat), spawnState());
    for (const inp of inputs) {
      room.setInput('p', inp);
      room.tick(DT);
      bare.setInput(inp);
      bare.update(DT);
      const sh = room.simState('p')!;
      expect(sh.pos.x).toBeCloseTo(bare.state.pos.x, 10);
      expect(sh.pos.y).toBeCloseTo(bare.state.pos.y, 10);
      expect(sh.pos.z).toBeCloseTo(bare.state.pos.z, 10);
      expect(sh.onGround).toBe(bare.state.onGround);
    }
  });

  it('jetting while the pool holds: still identical (gate engages only at zero)', () => {
    const inputs = stream(0xCAFE, 60).map((i): MoveInput => ({ ...i, jetHeld: true }));
    const room = new RoomMoveSim(flat);
    room.track('p', { x: 0, y: 5, z: 0 }, 0.4);
    const bare = new MoveSim(FieldSurface.fromField(flat), spawnState());
    for (const inp of inputs) {
      room.setInput('p', inp);
      room.tick(DT);
      bare.setInput(inp);
      bare.update(DT);
    }
    const sh = room.simState('p')!;
    expect(sh.pos.x).toBeCloseTo(bare.state.pos.x, 10);
    expect(sh.pos.y).toBeCloseTo(bare.state.pos.y, 10);
  });
});
