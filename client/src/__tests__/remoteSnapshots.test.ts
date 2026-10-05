import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SnapshotBuffer } from '../entities/remoteSnapshots.js';

// The render position must ride BETWEEN real server snapshots — never the
// newest one (that's jitter-chasing) and never stale past the buffer.

const _pos = new THREE.Vector3();
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
    // 100ms-cadence stream — delay covers one interval, so renderTime
    // (~-166ms) straddles the middle/older pair.
    buf.push(now - 250, {x:0,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0});
    buf.push(now - 150, {x:1,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0});
    buf.push(now - 50, {x:2,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0});
    const { pos } = sample(buf);
    // RenderTime sits between s0 and s1 -> ~0.8-1.0, never at an end
    expect(pos.x).toBeGreaterThan(0.6);
    expect(pos.x).toBeLessThan(1.2);
  });

  it('extrapolates bounded past the newest snapshot instead of freezing', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    buf.push(now - 400, {x:0,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0});
    buf.push(now - 200, {x:1,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0});
    // The 200ms gap triggers the cadence-change fast-EMA → delay ~250ms,
    // renderTime lands between the two snaps (~0.65) — inside the buffer,
    // not frozen on an extrapolation clamp.
    const { pos } = sample(buf);
    expect(pos.x).toBeGreaterThan(0.4);
    expect(pos.x).toBeLessThan(1);
  });

  it('covers a tier-suppressed stream instead of freezing on the clamp', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    // Interest-tier suppression: snapshots at ~500ms spacing (tier 10).
    // The pre-fix 300ms delay cap left renderTime permanently past the
    // newest snap — far remotes froze on MAX_EXTRAPOLATE and stepped.
    for (let i = 6; i >= 0; i--) {
      buf.push(now - i * 500, {x:(6-i)*10,y:0,z:0}, {yaw:0,pitch:0}, {x:20,y:0,z:0});
    }
    const { pos } = sample(buf);
    // renderTime lands INSIDE the buffer (~600ms back) → smooth lerp
    // between real snaps around x≈40-55, not the newest+clamp (≈72).
    expect(pos.x).toBeGreaterThan(38);
    expect(pos.x).toBeLessThan(60);
  });

  it('caps extrapolation at MAX_EXTRAPOLATE no matter how stale', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    // Stale feed: last packet arrived 5s ago (arriveMs), same server time.
    buf.push(now - 5000, {x:0,y:0,z:0}, {yaw:0,pitch:0}, {x:10,y:0,z:0}, now - 5000);
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
    buf.push(now - 150, {x:1,y:2,z:3}, {yaw:0,pitch:0}, {x:0,y:0,z:0});
    buf.clear();
    expect(buf.size).toBe(0);
    // Push again — pool reuse must not corrupt new data. Three snaps so
    // the interval-scaled delay straddles a pair rather than clamping.
    buf.push(now - 250, {x:4,y:5,z:6}, {yaw:0,pitch:0}, {x:0,y:0,z:0});
    buf.push(now - 150, {x:5,y:5,z:6}, {yaw:0,pitch:0}, {x:0,y:0,z:0});
    buf.push(now - 50, {x:7,y:5,z:6}, {yaw:0,pitch:0}, {x:0,y:0,z:0});
    const { pos } = sample(buf);
    expect(pos.x).toBeGreaterThan(4);
    expect(pos.x).toBeLessThan(7);
  });

  it('keeps the yaw lerp on the shortest arc across ±PI', () => {
    const buf = new SnapshotBuffer();
    const now = Date.now();
    // Snap pair wrapping through PI: -3.0 → +3.0 should pass through ±PI,
    // not swing backward through 0
    buf.push(now - 150, {x:0,y:0,z:0}, {yaw:-3,pitch:0}, {x:0,y:0,z:0});
    buf.push(now - 50, {x:0,y:0,z:0}, {yaw:3,pitch:0}, {x:0,y:0,z:0});
    const { rot } = sample(buf);
    expect(Math.abs(rot.yaw)).toBeGreaterThan(2.9);
  });
});
