import { describe, it, expect } from 'bun:test';
import { mkNetbots, nd } from './helpers.ts';

describe('netbot — real clients over real sockets', () => {
  const { spawn, bots, sleep, untilProgress, env } = mkNetbots();

  it('bots fight over real WS with jittered claims — every legit claim resolves', async () => {
    // Half the roster on the rtc lane when the native lib loads — a
    // jittered ws bot trading claims with an rtc bot is the real mix a
    // production room sees (browsers are ws-only today; LAN/P2P can still
    // land rtc). No nd → everyone ws, same as before.
    await spawn(4, { pingMs: 20, jitterMs: 150, lossRate: 0 }, { transports: nd ? ['ws', 'rtc'] : undefined }); // heavy jitter: claims race spawns constantly
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
    // State correctness: observers must converge on the same truth.
    // Jitter skews event ARRIVAL per conn — a kill/respawn in transit is
    // a legit temporary divergence, so first-pass mismatches re-check
    // after a drain. A pair still split after ~1s of settle is a real
    // broadcast desync (truth that never arrived), the bug this asserts.
    type Ghost = { health: number; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } };
    const pairs: { id: string; a: Ghost; other: (typeof bots)[number] }[] = [];
    for (const [id, a] of bots[0]!.nc.roster) {
      for (const other of bots.slice(1)) {
        const b = other.nc.roster.get(id);
        if (!b) {continue;}
        const speed = Math.max(Math.hypot(a.vel.x, a.vel.y, a.vel.z), Math.hypot(b.vel.x, b.vel.y, b.vel.z));
        const dist = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
        if (b.health === a.health && dist < Math.max(20, speed * 0.5)) {continue;}
        pairs.push({ id, a, other });
      }
    }
    if (pairs.length > 0) {
      await sleep(1000); // drain in-flight events before judging desync
      for (const { id, a, other } of pairs) {
        const b = other.nc.roster.get(id);
        if (!b) {continue;}
        // Forensics: the victim's own truth decides which observer is
        // lying — self.health/deaths vs each ghost's view.
        const victim = bots.find((x) => x.nc.id === id);
        const v = victim ? `victim self.health=${victim.nc.self.health} deaths=${victim.nc.tel.deaths} dead=${victim.nc.self.isDead}` : 'victim not a netbot';
        // The deciding vote is the server's record — this suite shares
        // the process, so truth is a map lookup, not a guess. If server
        // says alive=200 and an observer's ghost sits at 0, THAT observer
        // dropped the update; if server says dead, the VICTIM missed its
        // own death events — both are real loss, just aimed differently.
        const srv = [...(env()?.gs.rooms.values() ?? [])].map((r) => r.players.getPlayer(id)).find(Boolean);
        const s = srv ? `server health=${srv.health} dead=${srv.isDead}` : 'server: no record';
        const evs = `obs0ev=[${bots[0]!.nc.evLog.filter((e) => e.includes(id)).join('; ')}]`;
        expect(b.health, `${id} health desynced: observer0=${a.health} observer=${b.health} | ${v} | ${s} | ${evs}`).toBe(a.health);
      }
    }
  }, 120_000);
});
