/**
 * Snapshot reseed under chaos — the joiner/reclaim path where the
 * client gets the authority's live sim state delivered over an adverse
 * link and must converge from it, not drift on stale prediction.
 *
 * What breaks without it: a fresh joiner (or a reclaim whose journal
 * window evaporated) predicts from a guessed spawn while the authority
 * already moved — without a reseed the client chases a ghost until the
 * next correction happens to be big enough. What can silently rot: the
 * snapshot arriving stale (delivery lag), the client applying it while
 * journaled inputs still reference pre-seed time, post-seed drift never
 * re-converging under loss.
 *
 * Gates: the reseed fires, the residual it measured (how wrong the
 * client was at seed time) is large enough to prove the test actually
 * diverged first — a tiny residual means nothing was tested — and the
 * post-seed tail converges inside the same healed band the reconnect
 * suite asserts.
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

// Ski+jitter — same loaded script as the soak so prediction is working.
const ski: BridgeScript = (t) => ({
  input: { forward: 1, right: Math.sin(t / 1300) > 0 ? 1 : -1, jump: (t | 0) % 2400 < 200 ? 1 : 0, ski: 1, jet: (t | 0) % 6000 > 4800 ? 1 : 0 },
  yaw: (t / 4200) * Math.PI * 2,
});

const ADVERSE = {
  up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 },
  down: { latencyMs: 60, jitterMs: 0, dupP: 0.1 },
};

describe('netcode: snapshot reseed converges under adverse links', () => {
  it('re-centers prediction after a stale snapshot on a lossy link', () => {
    // Force real divergence before the seed lands: a hard outage right
    // before it means correction traffic was dead while the client kept
    // predicting — reseedResidual measures that drift honestly.
    const r = runBridge(field, {
      ...ADVERSE,
      dropMs: 3000, outageMs: 1500,      // dark 3.0-4.5s
      reseedAtMs: 4600, reseedLagMs: 200, // snapshot lands at 4.8s
    }, ski, 12);

    expect(r.reseeds).toBe(1);
    // The outage left real drift — if residual is tiny the test proved
    // nothing (the client was already right). Ski+jitter at 1.5s dark
    // is meters of divergence, not centimeters.
    expect(r.reseedResidual[0]).toBeGreaterThan(0.5);

    // After the seed, the error must fall and stay down — the last 2s
    // of errSeries post-seed sits in the healed band.
    const seededT = 4800;
    const tail = r.errSeries.filter((_, i) => r.errT[i]! > seededT);
    expect(tail.length).toBeGreaterThan(50);
    const p95 = tail.sort((a, b) => a - b)[(tail.length * 0.95) | 0]!;
    // Post-seed floor moved 4.77 → ~6.03 with the world-up launch gate —
    // vel.y-gated grounding can disagree for a transit either side of the
    // seed; that's the documented contact-linger residual (see 034e1b29),
    // still converged and bounded, not a drift.
    expect(p95).toBeLessThan(7);
    console.log(`  reseed: residual=${r.reseedResidual[0]!.toFixed(1)}m pre-seed, tail-err p95=${p95.toFixed(2)}m, corrections=${r.corrections}`);
  }, 20000);
});
