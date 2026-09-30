import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { AudioEngine } from '../core/audio.js';

// Doppler factor math: relative radial velocity along the listener→emitter
// line bends pitch (approaching >1, receding <1) — one-shots sample it once,
// loops re-evaluate per frame. Effective c=550 keeps it musical at game speeds.
function engine(listenerVel = new THREE.Vector3()): AudioEngine {
  const e = new AudioEngine();
  e.updateListener(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), listenerVel);
  return e;
}

describe('dopplerRate', () => {
  it('approaching emitters pitch up, receding pitch down', () => {
    const e = engine();
    const at = new THREE.Vector3(50, 0, 0);
    expect(e.dopplerRate(at, new THREE.Vector3(-40, 0, 0))).toBeGreaterThan(1);
    expect(e.dopplerRate(at, new THREE.Vector3(40, 0, 0))).toBeLessThan(1);
  });

  it('perpendicular motion does not bend', () => {
    const e = engine();
    const r = e.dopplerRate(new THREE.Vector3(50, 0, 0), new THREE.Vector3(0, 0, 40));
    expect(r).toBeCloseTo(1, 5);
  });

  it('a moving listener counts too — skiing toward a source bends it up', () => {
    const e = engine(new THREE.Vector3(40, 0, 0));
    expect(e.dopplerRate(new THREE.Vector3(50, 0, 0))).toBeGreaterThan(1);
    // Listener retreating reads the same as the emitter retreating.
    const e2 = engine(new THREE.Vector3(-40, 0, 0));
    expect(e2.dopplerRate(new THREE.Vector3(50, 0, 0))).toBeLessThan(1);
  });

  it('relative velocity cancels — matching velocities stay flat', () => {
    const e = engine(new THREE.Vector3(40, 0, 0));
    expect(e.dopplerRate(new THREE.Vector3(50, 0, 0), new THREE.Vector3(40, 0, 0))).toBeCloseTo(1, 5);
  });

  it('no bend inside 2m or past max distance', () => {
    const e = engine();
    expect(e.dopplerRate(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-40, 0, 0))).toBe(1);
    expect(e.dopplerRate(new THREE.Vector3(300, 0, 0), new THREE.Vector3(-40, 0, 0))).toBe(1);
  });

  it('clamps to the musical range even at extreme closing speeds', () => {
    const e = engine();
    const r = e.dopplerRate(new THREE.Vector3(50, 0, 0), new THREE.Vector3(-500, 0, 0));
    expect(r).toBeLessThanOrEqual(1.45);
    const r2 = e.dopplerRate(new THREE.Vector3(50, 0, 0), new THREE.Vector3(500, 0, 0));
    expect(r2).toBeGreaterThanOrEqual(0.55);
  });
});
