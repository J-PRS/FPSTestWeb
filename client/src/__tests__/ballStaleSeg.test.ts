import { describe, it, expect } from 'vitest';
import { isStaleSeg, newNetBag, applySeg, type NetHost } from '../entities/ballNet.js';
import { makeSimBall } from '../../../shared/ballSim.js';
import * as THREE from 'three';

// The wire-ordering contract: strictly-older stamps are stale (rewind),
// equal-stamp second segments MUST apply — two edges in one server tick
// share the 50ms stamp and the second is fresher truth in wire order.
// Dropping it replayed a dead leg for a whole interval (the 5-15m warns).
describe('isStaleSeg — wire-order boundary', () => {
  it('drops strictly-older stamps', () => {
    const bag = newNetBag();
    bag.legT0 = 10;
    expect(isStaleSeg(bag, 9.9)).toBe(true);
  });

  it('applies equal stamps — same-tick second segments are fresher truth', () => {
    const bag = newNetBag();
    bag.legT0 = 10;
    expect(isStaleSeg(bag, 10)).toBe(false);
  });

  it('applies newer stamps', () => {
    const bag = newNetBag();
    bag.legT0 = 10;
    expect(isStaleSeg(bag, 10.1)).toBe(false);
  });

  it('never drops unstamped segments', () => {
    const bag = newNetBag();
    bag.legT0 = 10;
    expect(isStaleSeg(bag, undefined)).toBe(false);
  });

  it('accepts everything before the first stamp (legT0 = -1)', () => {
    const bag = newNetBag();
    expect(isStaleSeg(bag, 0.01)).toBe(false);
  });
});

describe('applySeg — same-tick re-anchor', () => {
  function host(): NetHost {
    return {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      renderOffset: new THREE.Vector3(), emissive: new THREE.Color(),
      enraged: false, enrageTimer: 0, dampNextBounce: false, dead: false,
    };
  }
  const seg = (x: number, t: number) => ({
    px: x, py: 5, pz: 0, vx: 10, vy: 0, vz: 0,
    enraged: false, targetId: null, lead: 0.1, timers: undefined,
    tp: null, simT: t, hard: false,
  });

  it('a second segment on the same stamp re-anchors instead of being dropped', () => {
    const bag = newNetBag();
    bag.sim = makeSimBall(1, 0, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const h = host();
    applySeg(bag, h, seg(10, 5));
    applySeg(bag, h, seg(30, 5)); // same stamp, newer wire truth
    expect(bag.sim!.x).toBe(30); // second segment won
    expect(bag.legT0).toBe(5);
  });

  it('the sim cursor rewinds to the fresh stamp so the whole gap replays', () => {
    const bag = newNetBag();
    bag.sim = makeSimBall(1, 0, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    bag.simT = 12; // stepped ahead
    const h = host();
    applySeg(bag, h, seg(10, 10));
    expect(bag.simT).toBe(10); // cursor re-anchored to the stamp
  });
});
