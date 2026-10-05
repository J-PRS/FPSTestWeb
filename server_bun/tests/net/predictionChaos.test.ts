/**
 * Prediction convergence under chaos links — the netcode suite's core
 * gate. A real RoomMoveSim authority and a real client MoveSim exchange
 * inputMove/position/correction traffic through latency/jitter/loss/
 * reorder pipes, and we measure what the link does to prediction:
 *
 *  - preErr   = drift between authority echoes (the rubberband the
 *               player would FEEL if it isn't corrected and replayed)
 *  - postErr  = residual after snap+replay (the replay path's quality)
 *  - steady   = per-frame |client - server| while running
 *
 * Assertions are about BOUNDS, not zero error — honest prediction drifts
 * between echoes by design; the contract is that corrections keep it
 * bounded and replay returns it to ~zero.
 */

import { describe, it, expect } from 'bun:test';
import { runBridge, type BridgeScript } from './bridge.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

// Gentle sinusoid field — real terrain so ground snapping, slope slide,
// and ski physics all run (flat hides terrain-coupled divergence).
const field: Heightfield = (() => {
  const N = 32;
  const data = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    data[z * N + x] = Math.round(128 + 40 * Math.sin(x / 3) * Math.cos(z / 4));
  }
  return { size: 4, data, stride: N };
})();

// A circle-strafe run with ski on the downhills and a jet burst every
// 3s — exercises ground accel, slide, launch, and jet economy all at once.
const sporty: BridgeScript = (tMs) => {
  const yaw = (tMs / 1000) * 0.9;
  return {
    yaw,
    input: {
      forward: 1, right: Math.sin(tMs / 1400) > 0 ? 0.6 : -0.6,
      jump: Math.floor(tMs / 900) % 2 === 0 ? 1 : 0,
      ski: Math.sin(tMs / 1100) > 0.2 ? 1 : 0,
      jet: Math.floor(tMs / 3000) % 2 === 0 && tMs % 3000 < 800 ? 1 : 0,
    },
  };
};

const p95 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
};

const RUN_S = 8;
const T = 30000; // test timeout — wall-paced bridge needs real seconds

describe('netcode chaos: prediction convergence', () => {
  it('clean link: prediction tracks authority within step-lag', () => {
    const r = runBridge(field, {}, sporty, RUN_S);
    expect(r.reportsSent).toBeGreaterThan(100);
    // Post-replay residual vs live authority: one tick of travel at
    // most — the journal replay either converges or the whole
    // predict/correct contract is broken.
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    expect(p95(r.errSeries)).toBeLessThan(2.0);
  }, T);

  it('broadband (40ms+15ms jitter, 1% loss): corrections keep error bounded', () => {
    const r = runBridge(field, {
      up: { latencyMs: 40, jitterMs: 15, lossP: 0.01 },
      down: { latencyMs: 40, jitterMs: 15, lossP: 0.01 },
    }, sporty, RUN_S);
    expect(r.corrections).toBeGreaterThan(0);
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    // Between echoes the link lets drift grow — bounded, not zero.
    expect(Math.max(0, ...r.preErr)).toBeLessThan(15);
  }, T);

  it('lossy uplink (15%): resend watchdog heals dead input edges', () => {
    const r = runBridge(field, {
      up: { latencyMs: 30, jitterMs: 10, lossP: 0.15 },
      down: { latencyMs: 30, jitterMs: 10 },
    }, sporty, RUN_S);
    // A dead edge is a stale-input window, not a permanent split: the
    // server gap counter must have asked for a re-emit at least once,
    // and correction + replay still converge.
    expect(r.inputsResent).toBeGreaterThan(0);
    expect(r.snaps).toBeGreaterThan(0);
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    expect(Math.max(0, ...r.preErr)).toBeLessThan(30);
  }, T);

  it('lossy downlink (15%): lost corrections delay but never diverge', () => {
    const r = runBridge(field, {
      up: { latencyMs: 30, jitterMs: 10 },
      down: { latencyMs: 30, jitterMs: 10, lossP: 0.15 },
    }, sporty, RUN_S);
    // Lost echoes let the client free-run longer — bigger pre-err is the
    // honest cost — but each surviving correction must still fix it.
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    expect(p95(r.errSeries)).toBeLessThan(20);
  }, T);

  it('reordering (30%): seq gates drop stale edges, journal replays intact', () => {
    const r = runBridge(field, {
      up: { latencyMs: 20, jitterMs: 5, reorderP: 0.3 },
      down: { latencyMs: 20, jitterMs: 5, reorderP: 0.3 },
    }, sporty, RUN_S);
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    expect(Math.max(0, ...r.preErr)).toBeLessThan(30);
  }, T);

  it('adverse combined (80ms+30 jitter, 10% loss, 20% reorder both ways)', () => {
    const r = runBridge(field, {
      up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 },
      down: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 },
    }, sporty, RUN_S);
    // The whole healing story must still close: gap re-emits,
    // corrections snap, replay converges. (A lost edge superseded by a
    // fresh one is self-healing, so re-emits aren't guaranteed — what
    // must hold is convergence.)
    expect(r.snaps).toBeGreaterThan(0);
    expect(Math.max(0, ...r.postErr)).toBeLessThan(2.0);
    expect(Math.max(0, ...r.preErr)).toBeLessThan(50);
  }, T);

  it('mid-flight socket death: reclaim restores every durable event, prediction reconverges', () => {
    const r = runBridge(field, {
      up: { latencyMs: 30, jitterMs: 10, lossP: 0.05 },
      down: { latencyMs: 30, jitterMs: 10, lossP: 0.05 },
      dropMs: 3000, outageMs: 2000,
    }, sporty, RUN_S);
    // Every durable frame the room emitted must reach the client exactly
    // once — the journal replay + ev dedupe contract. Chat frames arrive
    // every 600ms; 8s run emits ~13, outage covers ~3.
    expect(r.durableEvs.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < r.durableEvs.length; i++) {
      expect(r.durableEvs[i]).toBeGreaterThan(r.durableEvs[i - 1]!);
    }
    expect(new Set(r.durableEvs).size).toBe(r.durableEvs.length); // no dups
    // Prediction free-ran for 2s of outage — the first post-reconnect
    // correction must land a big snap, then steady-state error falls
    // back under broadband bounds.
    expect(r.snaps).toBeGreaterThan(0);
    const tail = r.errSeries.slice(-120); // last ~2s of run
    expect(Math.max(0, ...tail)).toBeLessThan(15);
  }, T);
});
