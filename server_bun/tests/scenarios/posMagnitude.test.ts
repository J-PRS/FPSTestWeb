import { describe, it, expect } from 'bun:test';
import { validateMessage } from '../../src/wire.ts';
import { encodePosition, decodePosition } from '../../../shared/wire.ts';

// Both position lanes must reject absurd-but-finite claims: in judge mode
// the report IS broadcast truth, so an unbounded coordinate lands remotes
// at coordinate infinity and poisons lag-comp rewind history.
describe('scenario: position magnitude bound', () => {
  it('JSON lane rejects a position past 8192m', () => {
    const far = { x: 1e9, y: 0, z: 0 };
    expect(validateMessage({ type: 'position', position: far, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 } }).success).toBe(false);
    // Teleports share the body validator — warp beacons legitimately land
    // hundreds of metres out, so the bound must stay generous, not tight.
    expect(validateMessage({ type: 'teleport', position: far, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 } }).success).toBe(false);
  });

  it('JSON lane still accepts in-bounds claims', () => {
    expect(validateMessage({ type: 'position', position: { x: 4000, y: 500, z: -4000 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 } }).success).toBe(true);
  });

  it('binary lane rejects what the JSON lane rejects', () => {
    const frame = encodePosition({ x: 1e9, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);
    expect(decodePosition(frame)).toBeNull();
    const ok = encodePosition({ x: 4000, y: 500, z: -4000 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);
    expect(decodePosition(ok)).not.toBeNull();
  });

  it('binary lane rejects velocity past the JSON lane\'s 1000 m/s bound', () => {
    // i16 @0.1 m/s quantization reaches ±3276 — without the bound the
    // binary lane admits what validateBody refuses, and the claimed
    // velocity anchors moveJudge's divergence math.
    const fast = encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 1100, y: 0, z: 0 }, 1, 0);
    expect(decodePosition(fast)).toBeNull();
    const legal = encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 500, y: 300, z: -500 }, 1, 0);
    expect(decodePosition(legal)).not.toBeNull();
  });
});
