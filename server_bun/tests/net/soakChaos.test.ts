/**
 * Long-session soak — the netcode lane that profile tests can't reach:
 * reconnects cycling for tens of seconds of wall time while the link
 * stays adverse and the journal keeps wrapping. What can silently rot
 * over minutes: reclaim cursors drifting, durable frames lost between
 * eviction and replay, prediction never quite re-converging after the
 * Nth reconnect, resend storms compounding.
 *
 * Gate: every durable ev processed exactly once across the whole soak
 * (contiguous coverage — a gap means a lost frame, a dupe means the
 * ev-cursor dedupe leaked), and post-reconnect prediction heals back
 * under the same residual bound the single-drop suite asserts.
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

// Ski+jitter script — keeps the prediction loop loaded, not idle.
const ski: BridgeScript = (t) => ({
  input: { forward: 1, right: Math.sin(t / 1300) > 0 ? 1 : -1, jump: (t | 0) % 2400 < 200 ? 1 : 0, ski: 1, jet: (t | 0) % 6000 > 4800 ? 1 : 0 },
  yaw: (t / 4200) * Math.PI * 2,
});

// WS-shaped links: TCP can't lose or reorder mid-stream — durable frames
// are either delivered in order or the socket is dead. Loss/reorder on
// the downlink would be a datagram-transport model (WT/RTC), where the
// client's lack of ev-gap healing IS a real hole — tracked separately.
// The uplink keeps loss+reorder because client inputs tolerate it (the
// inputSync gap-resend path exists precisely for that). Down jitter is
// 0: ChaosLink jitters each frame independently, which REORDERS — a
// thing TCP provably cannot do. Replayed backlog arriving 46,48,47
// gets ev47 deduped as stale and the contiguity gate fails on an
// artifact, not a loss. dupP stays: dedupe must still eat it.
const ADVERSE = {
  up: { latencyMs: 80, jitterMs: 30, lossP: 0.1, reorderP: 0.2 },
  down: { latencyMs: 60, jitterMs: 0, dupP: 0.1 },
};

describe('netcode soak: sustained reconnects under adverse links', () => {
  it('reclaims every durable frame exactly once across repeated drops', () => {
    const r = runBridge(field, {
      ...ADVERSE,
      dropEveryMs: 4000, outageMs: 1200,
    }, ski, 30);

    expect(r.drops).toBeGreaterThanOrEqual(5);
    // Exact coverage: sorted evs form a contiguous run — nothing lost
    // to a mid-outage eviction, nothing delivered twice past dedupe.
    const evs = [...r.durableEvs].sort((a, b) => a - b);
    expect(evs.length).toBeGreaterThan(10);
    for (let i = 1; i < evs.length; i++) expect(evs[i]).toBe(evs[i - 1]! + 1);

    // Prediction still converges late in the soak — the last quarter of
    // the run must show the same healed band, not degraded drift.
    const lastQ = r.errSeries.length / 4 | 0;
    const tail = r.errSeries.slice(-lastQ);
    const p95 = tail.sort((a, b) => a - b)[(tail.length * 0.95) | 0]!;
    expect(p95).toBeLessThan(5);
    console.log(`  soak: ${r.drops} reconnects, ${r.corrections} corrections, ${evs.length} evs contiguous, tail-err p95=${p95.toFixed(2)}m, resends=${r.inputsResent}`);
  }, 45000);
});
