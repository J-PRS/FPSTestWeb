import { describe, it, expect, afterEach } from 'bun:test';
import { botRand, botRng, botRngRelease, tauntRand, tauntRng } from '../../shared/botRand.ts';
import { sharedEnv } from '../../shared/env.ts';
import { dist3, distSq } from '../../shared/botVec.ts';

// botRand is the ONLY draw bot-side heuristics may take — strictRng
// exists so a deterministic harness catches a stray Math.random instead
// of replaying a different squad every run. The gate's semantics are
// subtle on purpose: a never-injected stream AND raw Math.random are
// ambient (throw), while botRngRelease() is the BLESSED ambient return
// (another room's zombie timers must not eat this room's sequence).

afterEach(() => {
  delete sharedEnv.strictRng;
  // Leave a blessed ambient so a following suite's draws stay legal.
  botRngRelease();
});

describe('botRand gate', () => {
  it('strictRng rejects unblessed ambient but honors botRngRelease', () => {
    sharedEnv.strictRng = true;
    // Injecting Math.random directly IS ambient — the gate exists to
    // catch exactly this ("forgot to seed" reads as a stray dice roll).
    botRng(Math.random);
    expect(() => botRand()).toThrow(/ambient/);
    // botRngRelease() is the BLESSED ambient path — a tagged wrapper, so
    // harnesses can restore ambient dice between seeded windows without
    // tripping the gate.
    botRngRelease();
    expect(() => botRand()).not.toThrow();
  });

  it('botRng injects the stream and strict mode draws it', () => {
    sharedEnv.strictRng = true;
    let i = 0;
    botRng(() => (i++, i * 0.1));
    expect(botRand()).toBeCloseTo(0.1, 10);
    expect(botRand()).toBeCloseTo(0.2, 10);
  });

  it('an injected stream controls the draws — same seed, same sequence', () => {
    sharedEnv.strictRng = true;
    botRng(() => 0.42);
    expect(botRand()).toBe(0.42);
    expect(botRand()).toBe(0.42);
  });

  it('without strictRng, ambient Math.random draws silently', () => {
    botRngRelease();
    const v = botRand();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('tauntRand is an independent stream — behavior rolls never mix with chatter', () => {
    tauntRng(() => 0.99);
    botRng(() => 0.01);
    expect(tauntRand()).toBe(0.99);
    expect(botRand()).toBe(0.01); // untouched by the taunt draw
    expect(tauntRand()).toBe(0.99);
  });
});

describe('botVec', () => {
  it('dist3 and distSq agree and never square a negative', () => {
    const a = { x: 1, y: 2, z: 3 }, b = { x: 4, y: 6, z: 3 };
    expect(distSq(a, b)).toBe(3 * 3 + 4 * 4);
    expect(dist3(a, b)).toBe(5);
    expect(dist3(a, a)).toBe(0);
    expect(distSq(b, a)).toBe(distSq(a, b));
  });
});
