/* oxlint-disable vitest/no-conditional-in-test -- table/fuzz harness: branchy drives and ?? fallbacks ARE the test logic */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { RibbonTrail } from '../effects/RibbonTrail.js';

// Trails need no GL - BufferGeometry is pure data; the batch mesh just
// sits in the scene graph.
const scene = new THREE.Scene();
const pos = (x = 0): THREE.Vector3 => new THREE.Vector3(x, 0, 0);
const vel = (): THREE.Vector3 => new THREE.Vector3(0, 0, 10);

const slot = (r: RibbonTrail): number => (r as unknown as { slot: number }).slot;
const batch = (r: RibbonTrail): { used: Set<number>; free: number[]; } =>
  (r as unknown as { batch: { used: Set<number>; free: number[] } }).batch;

describe('RibbonTrail pooling + slots', (): void => {
  it('acquired trails claim distinct packed slots', (): void => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(a)).not.toBe(slot(b));
    expect(batch(a).used.has(slot(a))).toBe(true);
    expect(batch(a)).toBe(batch(b)); // one batch mesh per scene
    b.dispose();
    a.dispose();
  });

  it('released slots return to the free list and get re-handed out', (): void => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    a.dispose();
    expect(batch(a).used.has(s)).toBe(false);
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(b)).toBe(s); // lowest-first keeps the draw range dense
    b.dispose();
  });

  it('pooled instances are reused after dispose', (): void => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    a.dispose();
    const b = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(b).toBe(a); // free-list reuse - samples are fixed-size, reuse is free
    b.dispose();
  });

  it('done flips true only after the last sample outlives its life', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, width: 0.5, life: 0.1 }); // life 0.1s
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    expect(r.done).toBe(false);
    for (let i = 0; i < 20 && !r.done; i += 1) {r.update(0.05);}
    expect(r.done).toBe(true);
    r.dispose();
  });

  it('clear() drops samples and zeroes slot colors (teleport streak)', (): void => {
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

  it('a full ring rewrite keeps vert 0 at the CURRENT oldest sample', (): void => {
    // Push past MAX_SAMPLES so every push evicts - each vert's sample
    // assignment shifts. Buffer vert 0 must track the live oldest, not
    // the position it was first written with (the stale-vert streak).
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 10 });
    // Per-frame cadence like production: one push, one update - pushed=1
    // at rewrite time, so vert 0 only stays fresh if eviction forces a
    // full rewrite (the stale-vert bug hid behind freshFrom=count-1).
    for (let i = 0; i < 60; i += 1) {r.push(pos(i), vel()); r.update(0.016);}
    const b = (r as unknown as { batch: { pos: Float32Array } }).batch;
    const s = slot(r);
    const o = s * 48 * 2 * 3; // slot * VERTS * 3
    // Current oldest = sample x=12 (60 pushes, ring holds last 48).
    // Vert 0's x sits at oldest ± half-width; a stale vert reads ~x=0.
    expect(b.pos[o]!).toBeGreaterThan(10);
    expect(b.pos[o]!).toBeLessThan(14);
    r.dispose();
  });

  it('a position discontinuity cuts the strip instead of drawing a chord', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    // ~200m jump in one push - far past the per-push travel guard.
    r.push(new THREE.Vector3(200, 0, 0), vel());
    const internal = r as unknown as { count: number };
    expect(internal.count).toBeLessThanOrEqual(1); // strip restarted, no chord
    r.dispose();
  });

  it('a corrective-vel resnap still cuts - the 60m ceiling ignores glitched speed', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    // Resnap sweep: vel spikes to ~1400 m/s corrective - speed-scaled
    // budget (~115m) used to permit the 75m chord. Hard 60m ceiling cuts.
    r.push(pos(75), new THREE.Vector3(1400, 0, 0));
    const internal = r as unknown as { count: number };
    expect(internal.count).toBeLessThanOrEqual(1);
    r.dispose();
  });

  it('push after dispose counts a zombie and writes nothing', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.dispose();
    const before = RibbonTrail.zombiePushes;
    r.push(pos(5), vel());
    expect(RibbonTrail.zombiePushes).toBe(before + 1);
  });

  it('double dispose is safe - the pool never hands one ribbon to two owners', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    r.dispose();
    r.dispose(); // inPool guard - a second push would double-list it
    const a = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    const b = RibbonTrail.acquire(scene, { color: 0x00_00_FF });
    expect(a).not.toBe(b);
    expect(slot(a)).not.toBe(slot(b));
    a.dispose();
    b.dispose();
  });

  // P2 generational slots: a handle whose slot was re-issued to a new
  // owner must refuse writes - the batch's gen word proves staleness
  // where slot index alone can't.
  it('a stale gen handle refuses to paint the new owner\u2019s slot', (): void => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    const b = (a as unknown as { batch: { release(n: number): void; claim(): number } }).batch;
    // Free a's slot out from under it, then re-issue it to a fresh trail -
    // 'a' still thinks it owns s.
    b.release(s);
    const c = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(c)).toBe(s);
    const before = RibbonTrail.zombiePushes;
    a.push(pos(9), vel()); // stale gen - refused, handle dropped
    expect(RibbonTrail.zombiePushes).toBe(before + 1);
    expect(slot(a)).toBe(-1);
    // And the legitimate owner kept its slot + generation.
    c.push(pos(3), vel());
    expect(slot(c)).toBe(s);
    a.dispose(); // still pooled cleanly - slot is already -1
    c.dispose();
  });

  it('a stale releaseSlot can\u2019t steal the slot back from its new owner', (): void => {
    const a = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const s = slot(a);
    const ba = (a as unknown as { batch: { release(n: number): void } }).batch;
    ba.release(s);
    const c = RibbonTrail.acquire(scene, { color: 0x00_FF_00 });
    expect(slot(c)).toBe(s);
    (a as unknown as { releaseSlot(): void }).releaseSlot(); // stale - must not re-free s
    expect(batch(c).used.has(s)).toBe(true);
    a.dispose();
    c.dispose();
  });

  it('done ribbons the owner stopped ticking get swept as stale', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.05 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    for (let i = 0; i < 20 && !r.done; i += 1) {r.update(0.05);}
    expect(r.done).toBe(true);
    // Owner walked away without dispose() - sweepStale is the reaper.
    (r as unknown as { lastUpdateAt: number }).lastUpdateAt = 0;
    const before = RibbonTrail.reapedStale;
    RibbonTrail.sweepStale(1);
    expect(RibbonTrail.reapedStale).toBe(before + 1);
  });

  it('sweepStale drains a stopped orphan mid-fade instead of waiting on done forever', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.05 });
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    r.stop();
    // Owner died between stop() and drain - nobody ever calls update()
    // again, so its internal clock is frozen and done can never trip.
    (r as unknown as { lastUpdateAt: number }).lastUpdateAt = 0;
    expect(r.done).toBe(false);
    const before = RibbonTrail.reapedStale;
    // The sweep ages it on wall-clock; done → dispose on a later pass.
    for (let i = 0; i < 10 && RibbonTrail.reapedStale === before; i += 1) {
      RibbonTrail.sweepStale(1);
    }
    expect(r.done).toBe(true);
    expect(RibbonTrail.reapedStale).toBe(before + 1);
  });
});

describe('RibbonTrail follow (no weld)', (): void => {
  it('a bound follow never re-pins the head - the tip lags at most SAMPLE_SPACING', (): void => {
    // push() commits one sample per 0.5m of travel against its own anchor,
    // and the head is a committed worldpoint, never a live host mirror. A
    // re-pinned head follows _rpos through renderOffset decays and paints
    // blend-direction chords (the "trail pointing the wrong way"), so the
    // weld is gone on purpose: the tip lags at most half a meter of fresh
    // history, invisible next to a moving body.
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, width: 0.5, life: 10 });
    const host = new THREE.Vector3(0, 0, 0);
    r.follow = host;
    r.followManaged = true;
    r.push(pos(0), vel());
    host.set(1, 0, 0);
    r.push(pos(1), vel()); // 1m of travel -> one commit, head at 1.0
    r.update(0.016);
    // Host walks 0.16m with no push: under SAMPLE_SPACING the tip must stay
    // on the last committed sample instead of chasing the host.
    host.set(1.16, 0, 0);
    r.update(0.016);
    const internals = r as unknown as { head: number; px: Float32Array; count: number };
    expect(internals.px[internals.head]).toBeCloseTo(1, 5);
    // The drawn head verts sit on that sample: width 0.5 -> +-0.25, so the
    // outer vert lands at 1.25 (a welded head would read 1.41).
    const b = (r as unknown as { batch: { pos: Float32Array } }).batch;
    const o = slot(r) * 48 * 2 * 3 + (internals.count - 1) * 6;
    const hi = Math.max(b.pos[o]!, b.pos[o + 3]!);
    expect(hi).toBeGreaterThan(1.2);
    expect(hi).toBeLessThan(1.3);
    // Travel past SAMPLE_SPACING commits again, so the lag stays bounded.
    r.push(pos(1.6), vel());
    expect(internals.px[internals.head]).toBeCloseTo(1.6, 5);
    r.dispose();
  });

  it('follow re-pin still cuts on a real discontinuity', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00 });
    const host = new THREE.Vector3(0, 0, 0);
    r.follow = host;
    r.followManaged = true;
    r.push(pos(0), vel());
    r.push(pos(1), vel());
    host.set(200, 0, 0); // teleport, not travel
    r.update(0.016);
    // Break + reseed: history wiped (no chord), a fresh seed point sits
    // at the new location - count=1, head at 200, not 0.
    const internals = r as unknown as { count: number; head: number; px: Float32Array };
    expect(internals.count).toBe(1);
    expect(internals.px[internals.head]).toBeCloseTo(200, 5);
    r.dispose();
  });
});

describe('stamp-driven motion (net ball churn)', (): void => {
  // Buffer-level chord detector: longest lit consecutive-vert span in
  // the slot's shared buffer - what sweepSmear scans, asserted here.
  const maxSpan = (r: RibbonTrail): number => {
    const i = r as unknown as { slot: number; batch: { pos: Float32Array; col: Float32Array } };
    const base = i.slot * 48 * 2 * 3;
    let best = 0, px = 0, py = 0, pz = 0, hasPrev = false;
    for (let v = 0; v < 96; v += 2) {
      const c = base + v * 3;
      if (i.batch.col[c] === 0 && i.batch.col[c + 1] === 0 && i.batch.col[c + 2] === 0) {continue;}
      const x = i.batch.pos[c]!, y = i.batch.pos[c + 1]!, z = i.batch.pos[c + 2]!;
      if (hasPrev) {best = Math.max(best, Math.hypot(x - px, y - py, z - pz));}
      px = x; py = y; pz = z; hasPrev = true;
    }
    return best;
  };

  it('10m net stamps at 10Hz never leave a chord > 30m', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.5 });
    const host = new THREE.Vector3();
    r.follow = host; r.followManaged = true;
    const p = new THREE.Vector3();
    for (let tick = 0; tick < 40; tick += 1) {
      // Ball sim: render pos slides smoothly, sim pos stamps +10m.
      for (let f = 0; f < 6; f += 1) {
        p.x += 10 / 6; host.copy(p);
        r.update(0.016);
      }
      r.push(p, new THREE.Vector3(60, 0, 0));
    }
    expect(maxSpan(r)).toBeLessThanOrEqual(30);
    r.dispose();
  });

  it('a real teleport breaks the strip - no segment crosses it', (): void => {
    const r = RibbonTrail.acquire(scene, { color: 0xFF_00_00, life: 0.5 });
    const p = new THREE.Vector3();
    for (let i = 0; i < 5; i += 1) {p.x += 1; r.push(p.clone(), vel()); r.update(0.016);}
    p.x += 400; // teleport
    r.push(p.clone(), vel());
    r.update(0.016);
    expect(maxSpan(r)).toBeLessThanOrEqual(30);
    r.dispose();
  });
});
