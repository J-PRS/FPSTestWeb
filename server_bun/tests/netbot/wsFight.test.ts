import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

describe('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, until } = mkNetbots();

  it('bots fight over real WS with jittered claims — every legit claim resolves', async () => {
    await spawn(4, { pingMs: 20, jitterMs: 150, lossRate: 0 }); // heavy jitter: claims race spawns constantly
    const t = () => bots.map((b) => b.nc.tel);
    // Humanized bots close slower — wait on engagement, not a fixed
    // window, then drain the in-flight claims before asserting.
    await until(() => t().reduce((a, x) => a + x.hitsDealt, 0) > 0, 25000);
    await sleep(400); // let in-flight claims land

    const t1 = t();
    for (const b of bots) expect(b.nc.tel.gameStates).toBeGreaterThan(0);
    const shots = t1.reduce((a, x) => a + x.shots, 0);
    const claims = t1.reduce((a, x) => a + x.claims, 0);
    const dealt = t1.reduce((a, x) => a + x.hitsDealt, 0);
    const rejects = t1.reduce((a, x) => a + [...x.rejects.values()].reduce((p, q) => p + q, 0), 0);

    // Sanity: the fight actually happened.
    expect(shots).toBeGreaterThan(0);
    expect(claims).toBeGreaterThan(0);
    // The property the whole harness exists for: deferred claims must
    // absorb reorders — a healthy session produces zero rejects.
    expect(dealt).toBeGreaterThan(0);
    expect(rejects).toBe(0);

    // State correctness, not just flow: two observers of the same player
    // should agree on what the server told them. Both read the same
    // ordered tick/event streams, so divergence means a broadcast bug —
    // not a latency artifact.
    for (const [id, a] of bots[0]!.nc.roster) {
      for (const other of bots.slice(1)) {
        const b = other.nc.roster.get(id);
        if (!b) continue;
        expect(b.health).toBe(a.health);
        // Tick frames drain per-socket, so two observers can sit one
        // frame apart — ~8m covers a jet-speed gap at tick cadence.
        expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)).toBeLessThan(8);
      }
    }
  }, 30000);
});
