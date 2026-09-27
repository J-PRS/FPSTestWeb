import { describe, it, expect } from 'vitest';
import {
  encodePosition, decodePosition,
  encodeTickPlayer, encodeTickFrame, decodeTickFrame,
  isWireFrame, WIRE_POSITION,
} from '../../../shared/wire';

describe('position frame round-trip', () => {
  it('preserves position exactly (float32)', () => {
    const pos = { x: 123.456, y: -78.9, z: 0.5 };
    const rot = { yaw: 1.234, pitch: -0.9 };
    const vel = { x: 12.34, y: -5.6, z: 100.1 };
    const decoded = decodePosition(encodePosition(pos, rot, vel, 42, 37));
    expect(decoded).not.toBeNull();
    expect(decoded!.position.x).toBeCloseTo(pos.x, 5);
    expect(decoded!.position.y).toBeCloseTo(pos.y, 5);
    expect(decoded!.position.z).toBeCloseTo(pos.z, 5);
    expect(decoded!.seq).toBe(42);
    expect(decoded!.ping).toBe(37);
  });

  it('quantizes velocity to 0.1 m/s', () => {
    const vel = { x: 1.04, y: 1.05, z: 1.06 };
    const d = decodePosition(encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, vel, 1, 0))!;
    expect(d.velocity.x).toBeCloseTo(1.0, 5);
    expect(d.velocity.z).toBeCloseTo(1.1, 5);
  });

  it('wraps yaw into [0, 2π) and clamps pitch', () => {
    const neg = decodePosition(encodePosition({ x: 0, y: 0, z: 0 }, { yaw: -0.5, pitch: 99 }, { x: 0, y: 0, z: 0 }, 1, 0))!;
    expect(neg.rotation.yaw).toBeGreaterThanOrEqual(0);
    expect(neg.rotation.yaw).toBeCloseTo(Math.PI * 2 - 0.5, 2);
    expect(neg.rotation.pitch).toBeCloseTo(Math.PI, 4);
  });

  it('rejects non-wire and truncated frames', () => {
    expect(decodePosition(new Uint8Array([0x00, 0x01, 2, 3]))).toBeNull();
    expect(decodePosition(new Uint8Array(10))).toBeNull();
    const good = encodePosition({ x: 0, y: 0, z: 0 }, { yaw: 0, pitch: 0 }, { x: 0, y: 0, z: 0 }, 1, 0);
    expect(decodePosition(good.slice(0, 10))).toBeNull();
  });
});

describe('tick frame round-trip', () => {
  it('decodes all player records with fields intact', () => {
    const p1 = encodeTickPlayer({
      playerId: 'player_abc', position: { x: 1, y: 2, z: 3 },
      rotation: { yaw: 0.5, pitch: -0.5 }, velocity: { x: 4, y: 5, z: 6 },
      health: 80, isDead: false, ping: 55, ski: 1,
    });
    const p2 = encodeTickPlayer({
      playerId: 'player_xyz', position: { x: -1, y: -2, z: -3 },
      rotation: { yaw: 3.0, pitch: 0.2 }, velocity: { x: 0, y: 0, z: 0 },
      health: 0, isDead: true, ping: undefined, ski: 0,
    });
    const frame = encodeTickFrame(77, [p1, p2]);
    expect(isWireFrame(frame)).toBe(true);
    const decoded = decodeTickFrame(frame)!;
    expect(decoded.ackSeq).toBe(77);
    expect(decoded.updates).toHaveLength(2);
    const [a, b] = decoded.updates;
    expect(a!.playerId).toBe('player_abc');
    expect(a!.health).toBe(80);
    expect(a!.ping).toBe(55);
    expect(a!.ski).toBe(1);
    expect(a!.isDead).toBe(false);
    expect(b!.isDead).toBe(true);
    expect(b!.ping).toBeUndefined(); // unproven ping stays undefined
    expect(b!.rotation.pitch).toBeCloseTo(0.2, 2);
  });

  it('rejects truncated frames', () => {
    const p = encodeTickPlayer({
      playerId: 'a', position: { x: 0, y: 0, z: 0 },
      rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      health: 100, isDead: false, ski: 0,
    });
    const frame = encodeTickFrame(0, [p]);
    expect(decodeTickFrame(frame.slice(0, frame.length - 5))).toBeNull();
  });

  it('isWireFrame gates the magic byte only', () => {
    expect(isWireFrame(new Uint8Array([0x54, WIRE_POSITION]))).toBe(true);
    expect(isWireFrame(new Uint8Array([0x53, WIRE_POSITION]))).toBe(false);
    expect(isWireFrame(new Uint8Array([0x54]))).toBe(false);
  });
});

import { encodeBallSegment, decodeBallSegment } from '../../../shared/wire';

describe('ballSegment binary codec', () => {
  const full = {
    id: 42, kind: 'enrage',
    position: { x: 12.5, y: -3.25, z: 999.5 },
    velocity: { x: 40.1, y: -12.75, z: 0.5 },
    enraged: true, targetId: 'player_abc', tp: { x: 1, y: 2, z: 3 },
    et: 12.34, slowT: 1.9, damp: true, t: 1234.5,
  };

  it('round-trips all fields', () => {
    const s = decodeBallSegment(encodeBallSegment(full))!;
    expect(s).not.toBeNull();
    expect(s.id).toBe(42);
    expect(s.kind).toBe('enrage');
    expect(s.position.x).toBeCloseTo(12.5);
    expect(s.velocity.y).toBeCloseTo(-12.75);
    expect(s.enraged).toBe(true);
    expect(s.damp).toBe(true);
    expect(s.targetId).toBe('player_abc');
    expect(s.tp!.z).toBeCloseTo(3);
    expect(s.et).toBeCloseTo(12.34, 1);
    expect(s.slowT).toBeCloseTo(1.9, 1);
    expect(s.t).toBeCloseTo(1234.5);
  });

  it('omits optional fields cleanly', () => {
    const s = decodeBallSegment(encodeBallSegment({ ...full, targetId: null, tp: null, damp: false }))!;
    expect(s.targetId).toBeNull();
    expect(s.tp).toBeNull();
    expect(s.damp).toBe(false);
  });

  it('is ~3x smaller than JSON', () => {
    const bin = encodeBallSegment(full);
    const json = JSON.stringify({ type: 'ballSegment', ...full });
    expect(bin.length).toBeLessThan(json.length / 3);
  });

  it('rejects garbage', () => {
    expect(decodeBallSegment(new Uint8Array(10))).toBeNull();
  });
});
