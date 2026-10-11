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
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(a)).not.toBe(slot(b));
    expect(batch(a).used.has(slot(a))).toBe(true);
    expect(batch(a)).toBe(batch(b)); // one batch mesh per scene
    b.dispose();
    a.dispose();
  });

  it('released slots return to the free list and get re-handed out', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    a.dispose();
    expect(batch(a).used.has(s)).toBe(false);
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(b)).toBe(s); // lowest-first keeps the draw range dense
    b.dispose();
  });

  it('pooled instances are reused after dispose', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    a.dispose();
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(b).toBe(a); // free-list reuse — samples are fixed-size, reuse is free
    b.dispose();
  });

  it('done flips true only after the last sample outlives its life', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, width: 0.5, life: 0.1 }); // life 0.1s
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    expect(r.done).toBe(false);
    for (let i = 0; i < 20 && !r.done; i++) {r.update(0.05);}
    expect(r.done).toBe(true);
    r.dispose();
  });

  it('clear() drops samples and zeroes slot colors (teleport streak)', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.update(0.1);
    r.clear();
    expect(r.done).toBe(true); // no samples = nothing to draw
    r.dispose();
  });

  // ---- lifecycle invariants pinned before the P1/P2 restructure ----
  // These describe the contract the overhaul keeps, not the bugs it kills.

  it('a full ring rewrite keeps vert 0 at the CURRENT oldest sample', () => {
    // Push past MAX_SAMPLES so every push evicts — each vert's sample
    // assignment shifts. Buffer vert 0 must track the live oldest, not
    // the position it was first written with (the stale-vert streak).
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 10 });
    // Per-frame cadence like production: one push, one update — pushed=1
    // at rewrite time, so vert 0 only stays fresh if eviction forces a
    // full rewrite (the stale-vert bug hid behind freshFrom=count-1).
    for (let i = 0; i < 60; i++) {r.push(pos(i), vel()); r.update(0.016);}
    const b = (r as unknown as { batch: { pos: Float32Array } }).batch;
    const s = slot(r);
    const o = s * 48 * 2 * 3; // slot * VERTS * 3
    // Current oldest = sample x=12 (60 pushes, ring holds last 48).
    // Vert 0's x sits at oldest ± half-width; a stale vert reads ~x=0.
    expect(b.pos[o]!).toBeGreaterThan(10);
    expect(b.pos[o]!).toBeLessThan(14);
    r.dispose();
  });

  it('a position discontinuity cuts the strip instead of drawing a chord', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    // ~200m jump in one push — far past the per-push travel guard.
    r.push(new THREE.Vector3(200, 0, 0), vel());
    const internal = r as unknown as { count: number };
    expect(internal.count).toBeLessThanOrEqual(1); // strip restarted, no chord
    r.dispose();
  });

  it('push after dispose counts a zombie and writes nothing', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.dispose();
    const before = RibbonTrail.zombiePushes;
    r.push(pos(5), vel());
    expect(RibbonTrail.zombiePushes).toBe(before + 1);
  });

  it('double dispose is safe — the pool never hands one ribbon to two owners', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.dispose();
    r.dispose(); // inPool guard — a second push would double-list it
    const a = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    const b = RibbonTrail.acquire(scene, { color: 0x00_00_FF });
    expect(a).not.toBe(b);
    expect(slot(a)).not.toBe(slot(b));
    a.dispose();
    b.dispose();
  });

  // P2 generational slots: a handle whose slot was re-issued to a new
  // owner must refuse writes — the batch's gen word proves staleness
  // where slot index alone can't.
  it('a stale gen handle refuses to paint the new owner\u2019s slot', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    const b = (a as unknown as { batch: { release(n: number): void; claim(): number } }).batch;
    // Free a's slot out from under it, then re-issue it to a fresh trail —
    // 'a' still thinks it owns s.
    b.release(s);
    const c = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(c)).toBe(s);
    const before = RibbonTrail.zombiePushes;
    a.push(pos(9), vel()); // stale gen — refused, handle dropped
    expect(RibbonTrail.zombiePushes).toBe(before + 1);
    expect(slot(a)).toBe(-1);
    // And the legitimate owner kept its slot + generation.
    c.push(pos(3), vel());
    expect(slot(c)).toBe(s);
    a.dispose(); // still pooled cleanly — slot is already -1
    c.dispose();
  });

  it('a stale releaseSlot can\u2019t steal the slot back from its new owner', () => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    const ba = (a as unknown as { batch: { release(n: number): void } }).batch;
    ba.release(s);
    const c = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(c)).toBe(s);
    (a as unknown as { releaseSlot(): void }).releaseSlot(); // stale — must not re-free s
    expect(batch(c).used.has(s)).toBe(true);
    a.dispose();
    c.dispose();
  });

  it('done ribbons the owner stopped ticking get swept as stale', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.05 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    for (let i = 0; i < 20 && !r.done; i++) {r.update(0.05);}
    expect(r.done).toBe(true);
    // Owner walked away without dispose() — sweepStale is the reaper.
    (r as unknown as { lastUpdateAt: number }).lastUpdateAt = 0;
    const before = RibbonTrail.reapedStale;
    RibbonTrail.sweepStale(1);
    expect(RibbonTrail.reapedStale).toBe(before + 1);
  });

  it('sweepStale drains a stopped orphan mid-fade instead of waiting on done forever', () => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.05 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    // Owner died between stop() and drain — nobody ever calls update()
    // again, so its internal clock is frozen and done can never trip.
    (r as unknown as { lastUpdateAt: number }).lastUpdateAt = 0;
    expect(r.done).toBe(false);
    const before = RibbonTrail.reapedStale;
    // The sweep ages it on wall-clock; done → dispose on a later pass.
    for (let i = 0; i < 10 && RibbonTrail.reapedStale === before; i++) {
      RibbonTrail.sweepStale(1);
    }
    expect(r.done).toBe(true);
    expect(RibbonTrail.reapedStale).toBe(before + 1);
  });
});
