import { describe, it, expect, afterEach } from 'vitest';
import { lcg32, simRngSeed, simRng, simRand } from '../../../shared/simRand.js';

// The demo-verification contract: a recorded seed must reproduce the
// identical dice stream on replay — that's what makes a fabricated
// spawn event detectable instead of indistinguishable from luck.

describe('simRand', () => {
  afterEach(() => { simRng(() => 0.5); }); // park the stream — no ambient leaks between tests

  it('same seed produces the identical stream', () => {
    const a = lcg32(12_345);
    const b = lcg32(12_345);
    for (let i = 0; i < 1000; i += 1) {expect(a()).toBe(b());}
  });

  it('different seeds diverge immediately', () => {
    const a = lcg32(1);
    const b = lcg32(2);
    expect(a()).not.toBe(b());
  });

  it('outputs stay in [0,1)', () => {
    const r = lcg32(0xDE_AD_BE_EF);
    for (let i = 0; i < 10_000; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('simRngSeed rebinds the global stream deterministically', () => {
    simRngSeed(42);
    const first = [simRand(), simRand(), simRand()];
    simRngSeed(42);
    const second = [simRand(), simRand(), simRand()];
    expect(first).toEqual(second);
  });

  it('simRng injection overrides the stream (test seam)', () => {
    simRng(lcg32(7));
    const a = simRand();
    simRng(lcg32(7));
    expect(simRand()).toBe(a);
  });

  it('simRngSeed is idempotent across re-seed — a replay can re-arm mid-run', () => {
    simRngSeed(9);
    simRand(); simRand();
    simRngSeed(9);
    const replayed = lcg32(9);
    expect(simRand()).toBe(replayed());
  });

  it('save/restore resumes mid-stream and draw count tracks consumption', () => {
    // The sync-report pair — {state, draws} fingerprints "a consumer
    // drew a random the other run didn't" (the classic desync signature).
    const r = lcg32(77);
    const lead = [r(), r(), r()];
    expect(r.draws).toBe(3);
    const mark = r.save();
    const rest = [r(), r()];
    r.restore(mark);
    expect(r.draws).toBe(3); // restore rewinds the count too
    expect([r(), r()]).toEqual(rest);
    expect(lead[0]).not.toBe(rest[0]);
  });
});
