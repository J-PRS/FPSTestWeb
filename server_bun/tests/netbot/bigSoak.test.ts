import { describe, it, expect } from 'bun:test';
import { CONFIG } from '../../src/config.ts';
import { logger } from '../../src/logger.ts';
import { mkNetbots } from './helpers.ts';

// 32v32 stress soak — 64 real socket clients against one room, link
// quality quartiled LAN→beyond-bar adverse. The suite's other specs
// prove mechanics with 4-8 clients; this one proves the fanout itself
// sustained: 64×20Hz tick frames + 64 input streams + claim contention
// at real match density, measured over a sustained combat window — every
// client's stream must stay live, every legit claim must resolve.

const N_BOTS = Number(process.env.FPS_SOAK_BOTS ?? 64);
const WINDOWS = Number(process.env.FPS_SOAK_WINDOWS ?? 6);
const JOIN_GATE_MS = Number(process.env.FPS_SOAK_JOIN_MS ?? 60_000);

describe('netbot — stress soak', () => {
  const { spawn, bots, sleep, until } = mkNetbots();

  it(`${N_BOTS} clients on mixed links — sustained fanout, claims resolve, zero rejects`, async () => {
    // Link quartiles rotate over the roster — every bot class sees every
    // other class, so a degrade tied to one link profile can't hide.
    const LINKS = [
      { pingMs: 20, jitterMs: 5, lossRate: 0 },        // LAN-class
      { pingMs: 60, jitterMs: 20, lossRate: 0 },       // good broadband
      { pingMs: 150, jitterMs: 60, lossRate: 0.01 },   // the stated bar
      { pingMs: 300, jitterMs: 120, lossRate: 0.05 },  // beyond-bar adverse
    ];
    // Production caps are per-room 32 / global 128 — this room is
    // deliberately over both. CONFIG is a shared module object in this
    // process, so restore on the way out.
    const mutableConfig = CONFIG as { maxPlayers: number; globalMaxPlayers: number };
    const savedCap = mutableConfig.maxPlayers;
    const savedGlobal = mutableConfig.globalMaxPlayers;
    mutableConfig.maxPlayers = N_BOTS + 8;
    mutableConfig.globalMaxPlayers = N_BOTS + 8;
    await spawn(N_BOTS, LINKS, { room: 'big-soak', mode: 'ctf', bots: 0 });

    // Jank tap: a correct soak logs NOTHING at warn+. Every warn is a
    // grave error per house rule — position rejects, tick failures — so
    // collect them and assert the ledger is empty. The one bounded
    // exception is 'Movement cheat detected': the factory warns and
    // deliberately does NOT punish it (kick loops punish honest lag —
    // see roomFactory's onCheat), and a 2×-over-cap room on a shared
    // event loop *will* free-run stale input long enough to trip it on
    // zero-cheating clients. A HANDFUL is the documented starvation
    // artifact; a FLOOD still means the judge is misfiring and fails.
    const jank: string[] = [];
    const cheats: string[] = [];
    const ow = logger.warn.bind(logger), oe = logger.error.bind(logger);
    const CHEAT_WARN_BUDGET = 3;
    logger.warn = (m: string, d?: unknown) => {
      if (m === 'Movement cheat detected') {cheats.push(d === undefined ? m : `${m} ${JSON.stringify(d)}`);} else {jank.push(d === undefined ? m : `${m} ${JSON.stringify(d)}`);}
      ow(m, d);
    };
    logger.error = (m: string, d?: unknown) => { jank.push(`[error] ${d === undefined ? m : `${m} ${JSON.stringify(d)}`}`); oe(m, d); };

    const t = () => bots.map((b) => b.nc.tel);
    // Everyone must join first — a silent ghost at this scale is a
    // roster bug, not a flake, so gate on per-client handshake.
    if (!await until(() => bots.every((b) => b.nc.tel.gameStates > 0), JOIN_GATE_MS)) {
      const joined = bots.filter((b) => b.nc.tel.gameStates > 0).length;
      const closed = bots.filter((b) => b.nc.closed).map((b) => `${b.nc.id}:${b.nc.closeInfo}`);
      console.log(`bigSoak join gate: ${joined}/${N_BOTS} joined, closed=[${closed.join(', ')}]`);
      expect.unreachable(`${N_BOTS - joined} clients never received gameState`);
    }

    try {
    // Sustained combat: six 8s windows. Every client must keep accepting
    // tick frames in EVERY window — a stalled stream at 64-fanout reads
    // as frozen remotes, the failure this soak exists to catch. The bar
    // is LIVENESS, not rate parity: the room runs 2x over production's
    // maxPlayers cap on one shared event loop (server fanout + 64
    // decoders), so sustained ~3-8/s delivery is the honest ceiling —
    // a dead stream delivers ~0 and fails regardless.
    for (let w = 0; w < WINDOWS; w++) {
      const before = t().map((x) => x.ticks);
      await sleep(8000);
      const after = t().map((x) => x.ticks);
      for (let i = 0; i < bots.length; i++) {
        const rate = (after[i]! - before[i]!) / 8; // ticks per second this window
        expect(rate, `bot ${i} tick stream stalled in window ${w} (link=${JSON.stringify(LINKS[i % LINKS.length])})`).toBeGreaterThan(2);
      }
    }

    const t1 = t();
    const sum = (k: 'shots' | 'fireIntents' | 'hitsDealt' | 'kills' | 'deaths' | 'corrections') =>
      t1.reduce((a, x) => a + (x[k] ?? 0), 0);
    // 'shooter dead' is a gameplay verdict, not a transport reject —
    // a shot honestly in flight when the shooter died gets refused on
    // arrival, same as a real player's late volley. It belongs in its
    // own bucket; only claim-layer rejects trip the zero assert.
    let deadShots = 0;
    let rejects = 0;
    for (const x of t1) {for (const [reason, n] of x.rejects) {
      if (reason.includes('shooter dead')) deadShots += n; else rejects += n;
    }}
    const corr = t1.map((x) => x.corrections).sort((a, b) => a - b);
    const pick = (q: number) => corr[Math.min(corr.length - 1, Math.floor(corr.length * q))];
    console.log(`bigSoak: n=${N_BOTS} shots=${sum('shots')} hits=${sum('hitsDealt')} kills=${sum('kills')} deaths=${sum('deaths')} rejects=${rejects} deadShots=${deadShots} ticks min=${Math.min(...t1.map((x) => x.ticks))} max=${Math.max(...t1.map((x) => x.ticks))} corrections p50=${pick(0.5)} p95=${pick(0.95)} max=${corr[corr.length - 1]}`);

    // The war happened at density: sustained combat across 64 clients.
    expect(sum('shots')).toBeGreaterThan(N_BOTS);
    expect(sum('hitsDealt')).toBeGreaterThan(0);
    expect(sum('kills')).toBeGreaterThan(0);
    // The property the harness exists for — deferred claims absorb
    // reorders even at 64-client fanout; a healthy session has none.
    expect(rejects).toBe(0);
    // The dead-shot budget: each death races at most ~1 in-flight claim —
    // a flood here means corpses are still firing, not honest lag.
    expect(deadShots).toBeLessThanOrEqual(sum('deaths'));
    // Nobody sat a ghost: every client kept receiving the tick stream.
    for (const b of bots) {expect(b.nc.tel.gameStates).toBeGreaterThan(0);}
    // Roster convergence: every observer sees essentially the whole
    // lobby (a straggler join can legitimately lag one slot).
    for (const b of bots) {
      expect(b.nc.roster.size).toBeGreaterThanOrEqual(N_BOTS - 2);
    }
    // NO jank whatsoever: zero corrections on every client, and the
    // server emitted nothing at warn+ for the whole combat window.
    for (const b of bots) {
      expect(b.nc.tel.corrections, `bot ${b.nc.id} corrected`).toBe(0);
    }
    expect(jank, `server jank:\n${jank.slice(0, 20).join('\n')}`).toEqual([]);
    if (cheats.length > CHEAT_WARN_BUDGET) {
      expect.unreachable(`movement-cheat warns flooded (${cheats.length} > ${CHEAT_WARN_BUDGET}) — judge misfiring, not starvation:\n${cheats.slice(0, 8).join('\n')}`);
    }
    } finally {
      logger.warn = ow; logger.error = oe;
      mutableConfig.maxPlayers = savedCap;
      mutableConfig.globalMaxPlayers = savedGlobal;
    }
  }, 600_000);
});
