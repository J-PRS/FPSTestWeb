/**
 * Multi-client prediction convergence — the bridge scaled to a real
 * room's contention: 4 predicted players on heterogeneous links against
 * ONE authority + ONE ConnectionManager. What breaks at N>1 that a
 * single-client bridge cannot see:
 *   - shared global ev seq vs per-socket cursors (a client's durable
 *     frames interleave with other players' targeted ones)
 *   - correction/gap-heal traffic multiplexed over the same journal
 *   - one client's reconnect replay while others keep streaming
 *
 * Wall-paced like bridge.ts (reconcile throttle is wall-windowed).
 */

import { test, expect } from 'bun:test';
import type { Heightfield } from '../../../shared/heightfield.ts';
import { runBridgeN } from './bridgeN.ts';
import type { WireInput } from './bridge.ts';

const field: Heightfield = (() => {
  const N = 32;
  const data = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    data[z * N + x] = Math.round(128 + 40 * Math.sin(x / 3) * Math.cos(z / 4));
  }
  return { size: 4, data, stride: N };
})();

const sporty = (phase: number) => (tMs: number) => {
  const t = tMs / 1000;
  const input: WireInput = {
    forward: 1,
    right: Math.sin(t * 0.7 + phase) * 0.6,
    jump: Math.floor((t + phase) % 4) === 0 ? 1 : 0,
    ski: Math.floor((t + phase * 2) % 6) < 3 ? 1 : 0,
    jet: Math.floor((t + phase) % 8) < 1.2 ? 1 : 0,
  };
  return { input, yaw: t * 1.5 + phase };
};

const p95 = (xs: number[]) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]! : 0;

const strictlyIncreasing = (xs: number[]) => xs.every((v, i) => i === 0 || v > xs[i - 1]!);

test('4 clients on mixed links: every player converges, fanout is exactly-once', () => {
  const r = runBridgeN(field, [
    { id: 'clean', script: sporty(0), seed: 1 },
    { id: 'lossy', script: sporty(1), seed: 2, profile: { up: { latencyMs: 50, lossP: 0.1 }, down: { latencyMs: 50, lossP: 0.1 } } },
    { id: 'adverse', script: sporty(2), seed: 3, profile: { up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 }, down: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 } } },
    { id: 'dropper', script: sporty(3), seed: 4, profile: { down: { latencyMs: 40 }, dropMs: 3000, outageMs: 2000 } },
  ], 8);

  expect(r.broadcasts).toBeGreaterThan(8);
  let totalSnaps = 0;
  for (const [id, c] of r.clients) {
    // Convergence: post-replay residual bounded even on the adverse link.
    expect(p95(c.postErr), `${id} postErr p95`).toBeLessThan(2.5);
    totalSnaps += c.snaps;
    // Fanout: strictly increasing, no duplicates. Full coverage holds on
    // a lossless downlink (WS semantics); on a lossy link frames the
    // transport dropped are simply absent — no dup, order intact.
    expect(strictlyIncreasing(c.durableEvs), `${id} ev order`).toBe(true);
    const lossP = c === r.clients.get('lossy') || c === r.clients.get('adverse') ? 0.1 : 0;
    if (lossP === 0) expect(c.durableEvs.length, `${id} ev coverage`).toBe(r.broadcasts);
    else expect(c.durableEvs.length, `${id} ev coverage`).toBeGreaterThan(r.broadcasts * (1 - lossP * 3));
  }
  // Somewhere in the roster corrections actually fired.
  expect(totalSnaps).toBeGreaterThan(0);
  // The dropper must have healed via replay after its 2s outage.
  const dropper = r.clients.get('dropper')!;
  const tailErr = dropper.errSeries.slice(-50);
  expect(Math.max(...tailErr)).toBeLessThan(15);
}, 30000);

test('adverse all-links room still converges for the whole roster', () => {
  const r = runBridgeN(field, [0, 1, 2, 3].map((i) => ({
    id: `p${i}`, script: sporty(i), seed: i + 10,
    profile: {
      up: { latencyMs: 60, jitterMs: 25, lossP: 0.08, dupP: 0.05 },
      down: { latencyMs: 60, jitterMs: 25, lossP: 0.08, reorderP: 0.15 },
    },
  })), 8);
  for (const [id, c] of r.clients) {
    expect(p95(c.postErr), `${id} postErr p95`).toBeLessThan(3.0);
    expect(strictlyIncreasing(c.durableEvs), `${id} ev order`).toBe(true);
    // ~8% down-link loss modelled as UDP-style drops — delivery is
    // lossy by construction; what must hold is order + no duplicates.
    expect(c.durableEvs.length, `${id} ev coverage`).toBeGreaterThan(r.broadcasts * 0.7);
  }
}, 30000);
