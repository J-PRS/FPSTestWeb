/**
 * Sustained-RTT soak — the playability question chaos tests can't answer:
 * not "does it survive packet loss" but "does steady high ping degrade
 * prediction into a rubberband loop". A clean 150ms link is the global-play
 * floor (EU↔US-East is ~90-150ms); 300ms is the probe for where the model
 * actually breaks.
 *
 * What the link imposes by construction: the shadow sim consumes inputs
 * ~RTT/2 late, so at ski speed the server's belief trails the client by
 * speed×latency — an honest ~3m offset at 75ms uplink / 40m/s, ~6m at
 * 150ms uplink. The gates assert the error BAND is that systematic
 * offset (bounded, flat) — not free drift — and that corrections stay
 * rare rather than re-firing every throttle window (a rubberband loop
 * reads as corrections ≈ uptime/correctMs).
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

// Same ski+jitter script as the chaos soak — keeps the loop loaded.
const ski: BridgeScript = (t) => ({
  input: { forward: 1, right: Math.sin(t / 1300) > 0 ? 1 : -1, jump: (t | 0) % 2400 < 200 ? 1 : 0, ski: 1, jet: (t | 0) % 6000 > 4800 ? 1 : 0 },
  yaw: (t / 4200) * Math.PI * 2,
});

const p95 = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[(a.length * 0.95) | 0]! : 0;

describe('netcode soak: sustained RTT', () => {
  it('150ms RTT: bounded steady offset, corrections rare, no rubberband loop', () => {
    const r = runBridge(field, {
      up: { latencyMs: 75 }, down: { latencyMs: 75 },
    }, ski, 20);

    const err = p95(r.errSeries);
    const post = p95(r.postErr);
    // Uplink offset is speed×75ms — with ski+jets the band can crest a few
    // meters; >10m p95 would mean drift compounding past the systematic lag.
    expect(err).toBeLessThan(10);
    // Post-snap residual vs LIVE authority — replay covers the gap the echo
    // crossed, so the client shouldn't sit visibly off truth after a snap.
    expect(post).toBeLessThan(8);
    // Rubberband tell: corrections re-firing at the throttle cadence. A
    // healthy link snaps a handful of times over 20s, not every ~200ms.
    expect(r.corrections).toBeLessThan(60);
    console.log(`  150ms: p95 err=${err.toFixed(2)}m, post-snap p95=${post.toFixed(2)}m, corrections=${r.corrections}, snaps=${r.snaps}`);
  }, 30000);

  it('300ms RTT: degrades gracefully — offset grows, loop still bounded', () => {
    const r = runBridge(field, {
      up: { latencyMs: 150 }, down: { latencyMs: 150 },
    }, ski, 20);

    const err = p95(r.errSeries);
    const post = p95(r.postErr);
    // 150ms uplink lag ≈ ~6m systematic at ski speed; >15m p95 means the
    // model broke, not just lagged.
    expect(err).toBeLessThan(15);
    expect(post).toBeLessThan(15);
    // Same rubberband gate, looser — the longer feedback loop fires a few
    // more corrections, but must not pin at the throttle cadence.
    expect(r.corrections).toBeLessThan(100);
    console.log(`  300ms: p95 err=${err.toFixed(2)}m, post-snap p95=${post.toFixed(2)}m, corrections=${r.corrections}, snaps=${r.snaps}`);
  }, 30000);
});
