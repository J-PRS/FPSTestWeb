import { describe, it, expect } from 'bun:test';
import { mkNetbots } from './helpers.ts';

describe('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, untilProgress } = mkNetbots();

  it('bots fight over real WS with jittered claims — every legit claim resolves', async () => {
    await spawn(4, { pingMs: 20, jitterMs: 150, lossRate: 0 }); // heavy jitter: claims race spawns constantly
    const t = () => bots.map((b) => b.nc.tel);
    // Humanized bots close slower — wait on engagement, not a fixed
    // window, then drain the in-flight claims before asserting.
    //
    // The measured noise floor is the reason the budget is generous: on
    // an UNLOADED box this run yields shots=2-4 and hits=1 (fireIntents
    // queue ~20, but the server's fire throttle leaks ~1 landed hit).
    // So the whole test hangs on ONE landed hit — under suite load
    // (4 min of bun test plus a busy desktop) the first engagement can
    // outlive the old 20s/38s budget and the assert failed on
    // `shots > 0`, i.e. the bots never got to trade, not on any claim
    // property. Base 30s / hard cap 60s, and the starvation proxy now
    // counts kills+deaths too (a fight that trades kills is livelier
    // still and must keep its runway).
    await untilProgress(
      () => t().reduce((a, x) => a + x.hitsDealt, 0) > 0,
      () => t().reduce((a, x) => a + x.shots + x.hitsDealt + x.kills + x.deaths + x.gameStates, 0),
      30_000,
      // hardCap 90s: the full-suite run saw the first engagement outlive
      // 60s on a loaded box (parallel files + a busy desktop starve the
      // netbot threads). Still bounded — a wedged link dies on the outer
      // timeout, not here.
      { extendMs: 5000, hardCapMs: 90_000 },
    );
    await sleep(400); // let in-flight claims land

    const t1 = t();
    const sSum = t1.reduce((a, x) => a + x.shots, 0);
    const cSum = t1.reduce((a, x) => a + x.fireIntents, 0);
    const dSum = t1.reduce((a, x) => a + x.hitsDealt, 0);
    const kSum = t1.reduce((a, x) => a + x.kills + x.deaths, 0);
    const gSum = t1.reduce((a, x) => a + x.gameStates, 0);
    // One-line telemetry: on a loaded box this is the triage for
    // "no engagement" (hits landing slower than the fire throttle
    // leaks them), the same shape bigSoak prints.
    console.log(`WSFIGHT-TEL shots=${sSum} fire=${cSum} hits=${dSum} kd=${kSum} states=${gSum}`);
    for (const b of bots) {expect(b.nc.tel.gameStates).toBeGreaterThan(0);}
    const shots = t1.reduce((a, x) => a + x.shots, 0);
    const claims = t1.reduce((a, x) => a + x.fireIntents, 0);
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
        if (!b) {continue;}
        expect(b.health).toBe(a.health);
        // Tick frames drain per-socket, so two observers can sit one
        // frame apart — ~8m covers a jet-speed gap at tick cadence.
        expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)).toBeLessThan(8);
      }
    }
  }, 120_000);
});
