import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { RibbonTrail } from '../effects/RibbonTrail.js';

// Trails need no GL — BufferGeometry is pure data; the batch mesh just
// sits in the scene graph.
const scene = new THREE.Scene();
const pos = (x = 0) => new THREE.Vector3(x, 0, 0);
const vel = () => new THREE.Vector3(0, 0, 10);

const slot = (r: RibbonTrail): number => (r as unknown as { slot: number }).slot;
const batch = (r: RibbonTrail) =>
  (r as unknown as { batch: { used: Set<number>; free: number[] } }).batch;

describe('RibbonTrail pooling + slots', () => {
  it('acquired trails claim distinct packed slots', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xff0000 });
    const b = RibbonTrail.acquire(scene, { color: 0x00ff00 });
    expect(slot(a)).not.toBe(slot(b));
    expect(batch(a).used.has(slot(a))).toBe(true);
    expect(batch(a)).toBe(batch(b)); // one batch mesh per scene
    b.dispose();
    a.dispose();
  });

  it('released slots return to the free list and get re-handed out', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xff0000 });
    const s = slot(a);
    a.dispose();
    expect(batch(a).used.has(s)).toBe(false);
    const b = RibbonTrail.acquire(scene, { color: 0x00ff00 });
    expect(slot(b)).toBe(s); // lowest-first keeps the draw range dense
    b.dispose();
  });

  it('pooled instances are reused after dispose', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xff0000 });
    a.dispose();
    const b = RibbonTrail.acquire(scene, { color: 0x00ff00 });
    expect(b).toBe(a); // free-list reuse — samples are fixed-size, reuse is free
    b.dispose();
  });

  it('done flips true only after the last sample outlives its life', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xff0000, width: 0.5, life: 0.1 }); // life 0.1s
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    expect(r.done).toBe(false);
    for (let i = 0; i < 20 && !r.done; i++) r.update(0.05);
    expect(r.done).toBe(true);
    r.dispose();
  });

  it('clear() drops samples and zeroes slot colors (teleport streak)', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xff0000 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.update(0.1);
    r.clear();
    expect(r.done).toBe(true); // no samples = nothing to draw
    r.dispose();
  });
});
