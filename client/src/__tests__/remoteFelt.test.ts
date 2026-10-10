import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { RemoteInterp, type InterpHost } from '../entities/remoteInterp.js';

/**
 * Felt-state canary — the render-side half of "correct & validated":
 * wire tests pin what the server sent; this pins what the CLIENT RENDERS
 * against where the remote actually was. A scripted analytic mover emits
 * snapshots through a simulated transport (transit + jitter + loss + a
 * silence gap); every rendered frame is scored vs ground truth, and any
 * frame-to-frame jump beyond the speed-scaled snap budget counts as a
 * visible warp. The budgets mirror the snap thresholds the server uses.
 */

class Host implements InterpHost {
  position = new THREE.Vector3();
  previousPosition = new THREE.Vector3();
  rotation = { yaw: 0, pitch: 0, roll: 0 };
  velocity = new THREE.Vector3();
  serverVelocity = new THREE.Vector3();
  terrain = null;
  playerId = 'felt-mover';
  armorClass = 'medium';
  wireSki = true; // cruise-speed mover rides the frictionless lane like the real sim
  wireJet = false;
}

// Analytic mover — a big ski carve: position AND velocity known at every t.
const R = 80, W = 0.55, Y = 4;
function truth(tMs: number) {
  const t = tMs / 1000;
  return {
    x: R * Math.cos(W * t),
    y: Y + 6 * Math.max(0, Math.sin(2.2 * t)) ** 3, // periodic hops
    z: R * Math.sin(W * t),
    vx: -R * W * Math.sin(W * t),
    vy: 6 * 3 * Math.max(0, Math.sin(2.2 * t)) ** 2 * Math.cos(2.2 * t) * 2.2 * (Math.sin(2.2 * t) > 0 ? 1 : 0),
    vz: R * W * Math.cos(W * t),
  };
}
const CRUISE = R * W; // ~44 m/s

interface Packet { emitT: number; arriveT: number; s: ReturnType<typeof truth>; }
const q0 = (errs: number[], p: number) => errs[Math.min(errs.length - 1, Math.floor(errs.length * p))]!.toFixed(2);

function runLink(opts: { transit: number; jitter: number; loss: number; secs: number; silentFrom?: number; silentTo?: number; seed?: number; tickMs?: number }) {
  let rng = opts.seed ?? 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const h = new Host();
  const interp = new RemoteInterp(h);
  const queue: Packet[] = [];

  const FRAME_MS = 1000 / 60;
  const TICK_MS = 50;
  const start = truth(0);
  interp.onUpdate(start, { yaw: 0, pitch: 0 }, opts.transit * 2, { x: start.vx, y: start.vy, z: start.vz }, 0);
  // Remote spawns seated at the first snapshot (remoteAdd does the same)
  h.position.set(start.x, start.y, start.z);

  const errs: number[] = [];
  const snaps: number[] = [];
  let prev = new THREE.Vector3().copy(h.position);

  const totalFrames = Math.floor(opts.secs * 1000 / FRAME_MS);
  for (let f = 0; f < totalFrames; f++) {
    const now = f * FRAME_MS;
    vi.setSystemTime(now);

    // Server emits on its own 50ms cadence; transport delivers late/jittered.
    // (frame-index gated — float `now % 50` almost never lands exactly)
    if (f % Math.round((opts.tickMs ?? TICK_MS) / FRAME_MS) === 0) {
      const silent = opts.silentFrom !== undefined && now >= opts.silentFrom && now < (opts.silentTo ?? 0);
      if (!silent && rand() > opts.loss) {
        const s = truth(now);
        queue.push({ emitT: now, arriveT: now + opts.transit + (rand() * 2 - 1) * opts.jitter, s });
      }
    }
    while (queue.length && queue[0]!.arriveT <= now) {
      const p = queue.shift()!;
      interp.onUpdate(p.s, { yaw: 0, pitch: 0 }, opts.transit * 2, { x: p.s.vx, y: p.s.vy, z: p.s.vz }, p.emitT);
    }

    h.previousPosition.copy(h.position);
    interp.step(FRAME_MS / 1000, false);

    // Felt error: rendered ghost vs where the mover truly is right now.
    const t = truth(now);
    errs.push(h.position.distanceTo(new THREE.Vector3(t.x, t.y, t.z)));

    // Snap: a frame displacement no real velocity explains — rendered
    // speed may exceed cruise (interp curves, DR physics) but a jump
    // past speed×frame + slack is a teleport the eye sees.
    const jump = h.position.distanceTo(prev);
    const budget = Math.max(1.5, CRUISE * (FRAME_MS / 1000)) + 0.75;
    if (jump > budget) snaps.push(jump);
    prev.copy(h.position);
  }
  errs.sort((a, b) => a - b);
  console.log(`[felt] p50=${q0(errs, 0.5)} p95=${q0(errs, 0.95)} p99=${q0(errs, 0.99)} max=${errs[errs.length - 1]!.toFixed(2)} snaps=${snaps.length}`);
  const q = (p: number) => errs[Math.min(errs.length - 1, Math.floor(errs.length * p))]!;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: errs[errs.length - 1]!, snaps: snaps.length, snapMax: snaps.length ? Math.max(...snaps) : 0 };
}

describe('felt-state canary (rendered remote vs truth)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('LAN-class link (40ms, no loss): ghost rides truth within the snap floor', () => {
    const r = runLink({ transit: 20, jitter: 5, loss: 0, secs: 12 });
    // At ~44 m/s the interp delay (~150ms) alone prices ~6.5m of truth lag
    // the shooter also sees — the felt budget is what a led broadcast aims
    // for, not zero. The hard floor is no visible warp at all.
    expect(r.snaps, JSON.stringify(r)).toBe(0);
    expect(r.p95).toBeLessThan(10);
    expect(r.max).toBeLessThan(14);
  });

  it('150ms-class link (75ms transit, ±40ms jitter, 3% loss): stays inside the speed-scaled budget', () => {
    const r = runLink({ transit: 75, jitter: 40, loss: 0.03, secs: 20, seed: 777 });
    expect(r.snaps, JSON.stringify(r)).toBe(0);
    // ~44 m/s × ~250ms effective render lag — the same speed-scaled ~5m
    // budget the correction path uses, plus the true interp delay.
    expect(r.p95).toBeLessThan(18);
    expect(r.max).toBeLessThan(25);
  });

  it('tier-suppressed stream (250ms arrivals) on a fast mover: no steps, bounded lag', () => {
    // Interest-tier suppression is the production shape the canary was
    // missing: snapshots arrive 5x slower than the server emits them.
    // The speed-scaled delay cap (~90ms at 44m/s) trades cushion for
    // freshness — the ghost rides ~250ms-old truth between arrivals and
    // must not step at the send rate.
    const r = runLink({ transit: 40, jitter: 25, loss: 0, secs: 15, tickMs: 250, seed: 99 });
    expect(r.snaps, JSON.stringify(r)).toBe(0);
    // ~44 m/s × ~300ms effective lag ≈ 13m — the delay cap bounds it,
    // the alternation between buffer and DR must not double it.
    expect(r.p95).toBeLessThan(16);
    expect(r.max).toBeLessThan(22);
  });

  it('undeclared big jump snaps in one frame — never a multi-frame slide', () => {
    const h = new Host();
    const interp = new RemoteInterp(h);
    const FRAME = 1000 / 60;
    vi.setSystemTime(0);
    const t0 = truth(0);
    interp.onUpdate(t0, { yaw: 0, pitch: 0 }, 40, { x: t0.vx, y: t0.vy, z: t0.vz }, 0);
    h.position.set(t0.x, t0.y, t0.z);
    // Two normal updates so the buffer has a pair.
    for (let f = 1; f <= 6; f++) {
      vi.setSystemTime(f * FRAME);
      if (f % 3 === 0) {
        const s = truth(f * FRAME);
        interp.onUpdate(s, { yaw: 0, pitch: 0 }, 40, { x: s.vx, y: s.vy, z: s.vz }, f * FRAME);
      }
      h.previousPosition.copy(h.position);
      interp.step(FRAME / 1000, false);
    }
    // Stale post-reconnect frame lands 100m away — the plausibility gate
    // must wipe and re-seat, not steer across the map.
    vi.setSystemTime(200);
    const tp = { x: t0.x + 100, y: t0.y + 10, z: t0.z };
    interp.onUpdate(tp, { yaw: 0, pitch: 0 }, 40, { x: t0.vx, y: t0.vy, z: t0.vz }, 200);
    h.previousPosition.copy(h.position);
    interp.step(FRAME / 1000, false);
    expect(h.position.distanceTo(new THREE.Vector3(tp.x, tp.y, tp.z))).toBeLessThan(0.5);
    // And it must not drift on the next frames either.
    for (let f = 0; f < 5; f++) {
      vi.setSystemTime(216 + f * FRAME);
      h.previousPosition.copy(h.position);
      interp.step(FRAME / 1000, false);
    }
    expect(h.position.distanceTo(new THREE.Vector3(tp.x, tp.y, tp.z))).toBeLessThan(1.0);
  });

  it('respawn reset re-seats instantly on the corpse-free position', () => {
    const h = new Host();
    const interp = new RemoteInterp(h);
    vi.setSystemTime(0);
    const t0 = truth(0);
    interp.onUpdate(t0, { yaw: 0, pitch: 0 }, 40, { x: t0.vx, y: t0.vy, z: t0.vz }, 0);
    h.position.set(t0.x, t0.y, t0.z);
    const spawn = new THREE.Vector3(500, 20, 500);
    vi.setSystemTime(100);
    interp.reset(spawn);
    h.position.copy(spawn); // host re-seats the body, sim must not fight it
    h.previousPosition.copy(h.position);
    interp.step(1 / 60, false);
    // Buffer is wiped — with no new truth the interp must hold the seat,
    // not interpolate back toward the corpse's path.
    expect(h.position.distanceTo(spawn)).toBeLessThan(0.5);
  });

  it('held jet bit keeps a DR remote climbing through a silence gap — no mid-air drop tell', () => {
    const h = new Host();
    h.wireJet = true; // the wire says this remote is burning
    const interp = new RemoteInterp(h);
    const FRAME = 1000 / 60;
    vi.setSystemTime(0);
    const start = { x: 0, y: 20, z: 0 };
    interp.onUpdate(start, { yaw: 0, pitch: 0 }, 40, { x: 0, y: 8, z: 0 }, 0);
    h.position.set(0, 20, 0);
    // Wire goes silent past the DR threshold — the ghost must keep the
    // jet burn going (gravity alone would visibly drop it mid-air).
    for (let f = 1; f <= 60; f++) {
      vi.setSystemTime(f * FRAME);
      h.previousPosition.copy(h.position);
      interp.step(FRAME / 1000, false);
    }
    expect(interp.simulating).toBe(true);
    expect(h.position.y).toBeGreaterThan(15); // still aloft — never the "why did he drop" tell
  });

  it('silence gap + reconnect: DR runs, rejoin converges with zero snaps', () => {
    const r = runLink({ transit: 75, jitter: 40, loss: 0.02, secs: 20, silentFrom: 8000, silentTo: 9200, seed: 4242 });
    expect(r.snaps, JSON.stringify(r)).toBe(0);
    expect(r.max).toBeLessThan(60); // a 1.2s dead-reckon may stray ~v·gap, but never warps
  });

  it('mortar spam: re-predicts inside the window cannot keep the ghost ballistic forever', () => {
    const h = new Host();
    const interp = new RemoteInterp(h);
    const FRAME = 1000 / 60;
    vi.setSystemTime(0);
    interp.onUpdate({ x: 0, y: 20, z: 0 }, { yaw: 0, pitch: 0 }, 40, { x: 0, y: 0, z: 0 }, 0);
    h.position.set(0, 20, 0);
    // Repeated predicted blasts ~150ms apart — each used to re-arm the
    // window, so wire truth arriving mid-spam could never exit the sim.
    for (let b = 0; b < 6; b++) {
      vi.setSystemTime(b * 150);
      interp.predict(new THREE.Vector3(h.position.x + 1, h.position.y, h.position.z), 20);
      for (let f = 0; f < 9; f++) {
        vi.advanceTimersByTime(FRAME);
        interp.step(FRAME / 1000, false);
      }
    }
    // Window is short (~0.2s at ping 0): with spam ignored in-window the
    // timer expired during the barrage, so the next update must retake it.
    vi.advanceTimersByTime(500);
    interp.onUpdate({ x: 5, y: 20, z: 0 }, { yaw: 0, pitch: 0 }, 40, { x: 0, y: 0, z: 0 }, 50);
    // The update arms the converge phase inside the sim (the collapse:
    // converging IS simulating — the steer shares the sim's velocity).
    // The ballistic ghost must steer back toward truth: distance shrinks.
    const driftBefore = h.position.distanceTo(new THREE.Vector3(5, 20, 0));
    for (let f = 0; f < 15; f++) {
      vi.advanceTimersByTime(FRAME);
      h.previousPosition.copy(h.position);
      interp.step(FRAME / 1000, false);
    }
    const driftAfter = h.position.distanceTo(new THREE.Vector3(5, 20, 0));
    expect(driftAfter).toBeLessThan(driftBefore);
    // And bounded: six stacked launches would have thrown it ~100m+.
    expect(h.position.distanceTo(new THREE.Vector3(5, 20, 0))).toBeLessThan(60);
  });
});
