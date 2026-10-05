/**
 * Clock-skew tolerance — a client whose frame clock lies about elapsed
 * time (slow/fast rAF, VM time drift, throttled timers). The wire
 * carries no client timestamps by design, so the only channel skew can
 * leak through is the client's own prediction dt: it integrates the
 * wrong amount of time and drifts from authority at a steady rate.
 *
 * What the netcode must prove: corrections bound that drift instead of
 * compounding it — every echo pulls the client back, so the error
 * becomes a sawtooth around the skew rate, not a random walk. Both
 * directions matter: a slow clock under-predicts (client lags truth),
 * a fast clock over-predicts (client runs ahead).
 *
 * Gate: p95 steady-state error stays under a bound sized by the skew —
 * at 0.8x a ~20m/s skier misintegrates ~4m/s, so between 50ms reports
 * the drift slice is small and the residual band is correction-shaped.
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

const ski: BridgeScript = (t) => ({
  input: { forward: 1, right: Math.sin(t / 1300) > 0 ? 1 : -1, jump: (t | 0) % 2400 < 200 ? 1 : 0, ski: 1, jet: (t | 0) % 6000 > 4800 ? 1 : 0 },
  yaw: (t / 4200) * Math.PI * 2,
});

const CLEAN = { up: { latencyMs: 30 }, down: { latencyMs: 30 } };

const tail95 = (r: { errSeries: number[] }) => {
  const tail = r.errSeries.slice(-(r.errSeries.length / 4 | 0)).sort((a, b) => a - b);
  return tail[(tail.length * 0.95) | 0]!;
};

describe('netcode: client clock skew', () => {
  it('slow client clock (0.8x): drift stays correction-bounded', () => {
    const r = runBridge(field, { ...CLEAN, clockSkew: 0.8 }, ski, 12);
    expect(r.corrections).toBeGreaterThan(5);
    // 20% under-integration at ~15m/s ≈ 3m/s bias + jitter — the snap
    // loop keeps it from walking; the bound sits above the clean p95
    // (~1m) and far below unbounded drift (tens of meters in 12s).
    expect(tail95(r)).toBeLessThan(15);
    console.log(`  skew0.8: corr=${r.corrections} snaps=${r.snaps} tail-p95=${tail95(r).toFixed(2)}m`);
  }, 20000);

  it('fast client clock (1.25x): over-prediction also bounded', () => {
    const r = runBridge(field, { ...CLEAN, clockSkew: 1.25 }, ski, 12);
    expect(r.corrections).toBeGreaterThan(5);
    expect(tail95(r)).toBeLessThan(20);
    console.log(`  skew1.25: corr=${r.corrections} snaps=${r.snaps} tail-p95=${tail95(r).toFixed(2)}m`);
  }, 20000);
});
