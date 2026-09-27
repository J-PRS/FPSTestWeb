import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SnapshotBuffer } from '../entities/remoteSnapshots.js';

// The render position must ride BETWEEN real server snapshots — never the
// newest one (that's jitter-chasing) and never stale past the buffer.

const _pos = new THREE.Vector3();
const _rot = { yaw: 0, pitch: 0 };

function sample(buf: SnapshotBuffer, fallback = _pos): { pos: THREE.Vector3; rot: { yaw: number; pitch: number } } {
  const p = new THREE.Vector3();
  const r = { yaw: 0, pitch: 0 };
  buf.sample(p, r, fallback, 0, 0);
  return { pos: p, rot: r };
}

describe('SnapshotBuffer', () => {
  it('interpolates between the two snapshots bracketing renderTime', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    // Two snaps straddling now-100ms (the default interp delay)
    buf.push(now - 150, 0, 0, 0, 0, 0, 10, 0, 0);
    buf.push(now - 50, 1, 0, 0, 0, 0, 10, 0, 0);
    const { pos } = sample(buf);
    // RenderTime sits midway between the snaps -> ~0.5, never at the ends
    expect(pos.x).toBeGreaterThan(0.3);
    expect(pos.x).toBeLessThan(0.7);
  });

  it('extrapolates bounded past the newest snapshot instead of freezing', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    buf.push(now - 400, 0, 0, 0, 0, 0, 10, 0, 0);
    buf.push(now - 200, 1, 0, 0, 0, 0, 10, 0, 0);
    // renderTime is ~100ms past the newest snap -> extrapolates vx*~0.1 = +1m
    // (the jitter-adaptive delay absorbs a few ms — assert the band, not a point)
    const { pos } = sample(buf);
    expect(pos.x).toBeGreaterThan(1.5);
    expect(pos.x).toBeLessThan(2.2);
  });

  it('caps extrapolation at MAX_EXTRAPOLATE no matter how stale', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    buf.push(now - 5000, 0, 0, 0, 0, 0, 10, 0, 0);
    const { pos } = sample(buf);
    // 0.25s cap × vx=10 → exactly 2.5, not 50
    expect(pos.x).toBeCloseTo(2.5, 1);
  });

  it('falls back to the target position with an empty buffer', () => {
    const buf = new SnapshotBuffer();
    const fb = new THREE.Vector3(7, 8, 9);
    const { pos } = sample(buf, fb);
    expect(pos.x).toBe(7);
    expect(pos.y).toBe(8);
  });

  it('recycles snapshots on clear without losing state', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    buf.push(now - 150, 1, 2, 3, 0, 0, 0, 0, 0);
    buf.clear();
    expect(buf.size).toBe(0);
    // Push again — pool reuse must not corrupt new data
    buf.push(now - 150, 4, 5, 6, 0, 0, 0, 0, 0);
    buf.push(now - 50, 7, 5, 6, 0, 0, 0, 0, 0);
    const { pos } = sample(buf);
    expect(pos.x).toBeGreaterThan(4);
    expect(pos.x).toBeLessThan(7);
  });

  it('keeps the yaw lerp on the shortest arc across ±PI', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    // Snap pair wrapping through PI: -3.0 → +3.0 should pass through ±PI,
    // not swing backward through 0
    buf.push(now - 150, 0, 0, 0, -3.0, 0, 0, 0, 0);
    buf.push(now - 50, 0, 0, 0, 3.0, 0, 0, 0, 0);
    const { rot } = sample(buf);
    expect(Math.abs(rot.yaw)).toBeGreaterThan(2.9);
  });
});
