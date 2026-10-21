import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';

// Regression: WAN-jittered arrivals used to flip the remote into the
// converge/sim machine on every extrapolation seam — remotes lived in
// steering churn instead of settled interpolation (the visible wobble).
const mkHost = () => {
  const h: InterpHost = {
    position: new THREE.Vector3(),
    previousPosition: new THREE.Vector3(),
    rotation: { yaw: 0, pitch: 0, roll: 0 },
    velocity: new THREE.Vector3(),
    serverVelocity: new THREE.Vector3(),
    terrain: null, playerId: 'dbg', armorClass: 'scout',
  };
  return h;
};

afterEach(() => { vi.useRealTimers(); });

describe('remoteInterp seam absorb', () => {
  it('jittered WAN pushes must not leave the remote in perpetual sim', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const h = mkHost();
    const ri = new RemoteInterp(h);
    const SPD = 40;
    let wall = 1_000_000;
    let srvT = 0;
    const pos = { x: 0, y: 20, z: 0 };
    const push = () => {
      srvT += 50;
      pos.x += SPD * 0.05;
      ri.onUpdate({ ...pos }, { yaw: 0, pitch: 0 }, 50, { x: SPD, y: 0, z: 0 }, srvT);
    };
    let simFrames = 0, frames = 0, maxStep = 0;
    const prev = h.position.clone();
    const seen: number[] = [];
    for (let i = 0; i < 1200; i++) {
      wall += 16;
      vi.setSystemTime(wall);
      if (seen.length === 0 || srvT < (wall - 1_000_000) * 1 + 100) {
        push(); seen.push(srvT);
      }
      ri.step(0.016, false);
      frames++;
      if (ri.simulating) {simFrames++;}
      const st = h.position.distanceTo(prev);
      if (st > maxStep) {maxStep = st;}
      prev.copy(h.position);
    }
    // Bursty arrivals on a 40m/s remote legitimately produce steering
    // episodes — the regression guard is that each one FINISHES (sized
    // budget) instead of the old flat-0.35s churn that re-armed forever,
    // and that the rendered path never steps beyond physical travel.
    expect(simFrames / frames).toBeLessThan(0.5);
    expect(maxStep).toBeLessThan(4);
    // And the render stays close to wire truth (chase lag is bounded —
    // a lost replica would drift hundreds of meters behind).
    expect(Math.abs(h.position.x - pos.x)).toBeLessThan(12);
  });
});
