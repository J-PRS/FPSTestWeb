import { describe, it, expect, afterEach } from 'bun:test';
import { botRand, botRng, botRngRelease, tauntRand, tauntRng } from '../../shared/botRand.ts';
import { sharedEnv } from '../../shared/env.ts';

// The strictRng gate: an ambient draw during a seeded scenario is a
// silent desync — the gate exists to throw instead. Pin the throw, the
// seeded path, the blessed release, and the non-strict fallback.
afterEach(() => {
  sharedEnv.strictRng = false;
  botRngRelease();
});

describe('strictRng gate', () => {
  it('throws on an unmarked ambient draw', () => {
    sharedEnv.strictRng = true;
    // Identity-bound Math.random is exactly the unmarked-ambient case —
    // the gate can't tell "forgot to seed" from "seeded ambient" without it.
    botRng(Math.random);
    expect(() => botRand()).toThrow(/ambient Math\.random under strictRng/);
  });

  it('an injected stream draws without throwing', () => {
    sharedEnv.strictRng = true;
    const seq = [0.1, 0.2, 0.3]; let i = 0;
    botRng(() => seq[i++ % seq.length]!);
    expect(botRand()).toBe(0.1);
    expect(botRand()).toBe(0.2);
  });

  it('botRngRelease marks ambient blessed — no throw', () => {
    sharedEnv.strictRng = true;
    botRngRelease();
    expect(() => botRand()).not.toThrow();
  });

  it('non-strict mode falls back to ambient silently', () => {
    sharedEnv.strictRng = false;
    botRngRelease();
    expect(() => botRand()).not.toThrow();
  });

  it('taunt stream is a separate channel — chat flavor never re-sequences behavior rolls', () => {
    const seq = [0.9]; let i = 0;
    tauntRng(() => seq[i++ % seq.length]!);
    expect(tauntRand()).toBe(0.9);
  });
});
