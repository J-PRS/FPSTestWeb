/**
 * Convergence metrics as a regressible report — the same bridge runs as
 * predictionChaos, but emitting MEASURED numbers (correction rate,
 * time-to-converge, residual percentiles) instead of only bound asserts.
 * A silent netcode regression shows up here as a drifting number, which
 * is the point: unbreakable means observable.
 */

import { describe, expect, it } from 'bun:test';
import { runBridge, type BridgeProfile, type BridgeResult } from './bridge.ts';
import { flat } from '../scenarios/harness.ts';

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

type Metrics = {
  corrPerMin: number;
  tConvergeMs: number;   // first t after which steady err stays under 2m
  errP50: number; errP95: number; errP99: number;
  preErrP95: number; postErrP95: number;
  resendRatio: number;
};

/** Time the client spends converged: first sample after which every
 *  later steady-error sample stays under 5m. Between 20Hz reports a
 *  correct client legitimately leads authority ~1.5m (step-lag), so
 *  5m marks "corrections are keeping it honest", not zero error. */
const CONVERGED_M = 5;
const convergeMs = (r: BridgeResult) => {
  for (let i = r.errSeries.length - 1; i >= 0; i--) {
    if (r.errSeries[i]! > CONVERGED_M) return r.errT[i + 1] ?? Infinity;
  }
  return r.errT[0] ?? Infinity;
};

const metrics = (r: BridgeResult, seconds: number): Metrics => ({
  corrPerMin: (r.corrections / seconds) * 60,
  tConvergeMs: convergeMs(r),
  errP50: pct(r.errSeries, 0.5), errP95: pct(r.errSeries, 0.95), errP99: pct(r.errSeries, 0.99),
  preErrP95: pct(r.preErr, 0.95), postErrP95: pct(r.postErr, 0.95),
  resendRatio: r.inputsSent ? r.inputsResent / r.inputsSent : 0,
});

const script = (tMs: number) => ({
  input: {
    forward: Math.sin(tMs / 1700) > 0 ? 1 : -1,
    right: Math.cos(tMs / 2300) * 0.6,
    jump: Math.sin(tMs / 900) > 0.7 ? 1 : 0,
    ski: 1, jet: Math.sin(tMs / 3000) > 0.4 ? 1 : 0,
  },
  yaw: tMs / 4000,
});

const PROFILES: [string, BridgeProfile, number][] = [
  ['clean', {}, 8],
  ['lossy-up', { up: { lossP: 0.15 } }, 8],
  ['adverse', { up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 }, down: { latencyMs: 60, jitterMs: 25, lossP: 0.05, dupP: 0.1 } }, 10],
];

describe('netcode convergence metrics', () => {
  const report: string[] = [];
  for (const [name, profile, seconds] of PROFILES) {
    it(name, () => {
      const r = runBridge(flat, profile, script, seconds);
      const m = metrics(r, seconds);
      report.push(`${name}: corr/min=${m.corrPerMin.toFixed(0)} converge=${(m.tConvergeMs / 1000).toFixed(1)}s ` +
        `err p50=${m.errP50.toFixed(2)} p95=${m.errP95.toFixed(2)} p99=${m.errP99.toFixed(2)} ` +
        `pre95=${m.preErrP95.toFixed(1)} post95=${m.postErrP95.toFixed(1)} resend%=${(m.resendRatio * 100).toFixed(0)}`);
      console.log(`[netmetrics] ${report[report.length - 1]}`);
      // The bounds that make a regression fail loud; the numbers above
      // are the observability.
      expect(m.errP99).toBeLessThan(15);
      expect(m.postErrP95).toBeLessThan(6);
      expect(m.tConvergeMs).toBeLessThan(seconds * 1000);
      if (name === 'lossy-up') expect(m.resendRatio).toBeGreaterThan(0);
    }, 30000);
  }
});
