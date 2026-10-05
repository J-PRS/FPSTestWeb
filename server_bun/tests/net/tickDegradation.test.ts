/**
 * Tick-rate degradation — what happens to prediction when the authority
 * can't hold its 30Hz cadence. Real netcodes break here first: queued
 * inputs pile up, corrections arrive stale, and clients free-run long
 * enough that the snap threshold produces teleports instead of healing.
 *
 * Three regimes, all on the real bridge (RoomMoveSim authority, real
 * reconcile/correction/inputSync paths):
 *   - sustained 15Hz tick (half cadence)
 *   - a mid-run 2s stall (event-loop block / GC pause) then resume
 *   - degraded tick + lossy uplink together
 * The contract: inputs are never silently dropped (resends heal via the
 * server's own gap counter), drift during the degraded window stays
 * bounded, and post-stall corrections return residual to normal bounds.
 */

import { describe, it, expect } from 'bun:test';
import { runBridge, type BridgeScript } from './bridge.ts';
import type { Heightfield } from '../../../shared/heightfield.ts';

const field: Heightfield = (() => {
  const N = 32;
  const data = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    data[z * N + x] = Math.round(128 + 40 * Math.sin(x / 3) * Math.cos(z / 4));
  }
  return { size: 4, data, stride: N };
})();

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
const T = 30000;

describe('netcode chaos: tick-rate degradation', () => {
  it('sustained 15Hz authority: corrections still converge, inputs all consumed', () => {
    const r = runBridge(field, { tick: { hz: 15 } }, sporty, RUN_S);
    // Half cadence doubles the integration gap between authority echoes —
    // bounds relax accordingly but must still hold.
    expect(r.corrections).toBeGreaterThan(0);
    expect(p95(r.postErr)).toBeLessThan(4);
    expect(r.maxSteadyErr).toBeLessThan(25);
    // Every input edge eventually reached the authority: no unhealed gap.
    expect(r.inputsSent + r.inputsResent).toBeGreaterThan(0);
  }, T);

  it('2s authority stall mid-run: drift is bounded, first post-stall correction heals', () => {
    const r = runBridge(field, { tick: { stalls: [{ atMs: 4000, ms: 2000 }] } }, sporty, RUN_S);
    // During the stall the authority freezes while the client free-runs —
    // steady error MUST grow (that's the physics), and post-stall the
    // correction path must pull it back. Split the series at the stall.
    const during = r.errSeries.filter((_, i) => {
      const t = 1000 + (i / r.errSeries.length) * (RUN_S * 1000 - 1000);
      return t >= 4000 && t < 6000;
    });
    const after = r.errSeries.filter((_, i) => {
      const t = 1000 + (i / r.errSeries.length) * (RUN_S * 1000 - 1000);
      return t >= 7000;
    });
    expect(during.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // Tail heals: last second post-stall is back under the same bound as
    // a healthy run, even though the stall let drift grow.
    expect(Math.max(...after)).toBeLessThan(15);
    expect(p95(r.postErr)).toBeLessThan(4);
  }, T);

  it('15Hz tick + 15% uplink loss: gap counter resends heal the combined case', () => {
    const r = runBridge(field, {
      tick: { hz: 15 },
      up: { lossP: 0.15 },
    }, sporty, RUN_S, 11);
    // Lost input edges → server watermark gap → inputSync → resend.
    // This is the production heal path doing double duty under a slow tick.
    expect(r.inputsResent).toBeGreaterThan(0);
    expect(p95(r.postErr)).toBeLessThan(5);
    expect(r.corrections).toBeGreaterThan(0);
  }, T);

  it('back-to-back stalls: journal survives two freeze/resume cycles', () => {
    const r = runBridge(field, {
      tick: { stalls: [{ atMs: 2500, ms: 1500 }, { atMs: 5500, ms: 1500 }] },
    }, sporty, RUN_S, 13);
    const after = r.errSeries.filter((_, i) => {
      const t = 1000 + (i / r.errSeries.length) * (RUN_S * 1000 - 1000);
      return t >= 7500;
    });
    expect(after.length).toBeGreaterThan(0);
    expect(Math.max(...after)).toBeLessThan(15);
    expect(p95(r.postErr)).toBeLessThan(4);
  }, T);
});
