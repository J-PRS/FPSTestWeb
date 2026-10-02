import { describe, it, expect, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';

// Throughput probe: how much honest sim-time does a real CTF room burn
// through per wall-second when stepped flat-out? "Honest" means the
// whole room runs on the warp clock — respawns, spawn shields, flag and
// match timers all lapse in sim-time, not wall-time, so minutes of
// combat in seconds is actually minutes of combat.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/katabatic.bin`)));

// FPS_SOAK_MS=<ms> runs a longer warp from the CLI for profiling.
const WALL_BUDGET_MS = Number(process.env.FPS_SOAK_MS ?? 10_000);

describe('scenario: fast-forward soak throughput', () => {
  afterAll(() => simNowReset());

  it('steps a full 12-bot katabatic CTF room flat-out for 10 wall-s', () => {
    // Real T2 stand positions — a ctf room without bases spawns no
    // flags at all, and a flagless soak just measures wandering.
    const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
    const room = mkRoom({
      mode: 'ctf', bots: 12, botFill: 12,
      bases: { alpha: baseAt(236.85, -127.11), bravo: baseAt(-423.57, 281.67) },
    }, 'ctf', 4242, false, field);
    // Sim-clock stamped watch — _s lets post-run stats time flag
    // transitions (grab→cap deltas) instead of counting blind.
    let simTicks = 0;
    const dt = 0.05;                      // 20Hz — matches the live tick
    const w = watch(room, () => simTicks * dt);
    expect(room.flags).not.toBeNull();

    const wallBudgetMs = WALL_BUDGET_MS;
    const runStart = simNow();
    const t0 = performance.now();
    const BATCH = 20; // sim-s granularity of stamped msgs — 100-tick
    // batches made 5s caps read as 0.0s in the match report.
    while (performance.now() - t0 < wallBudgetMs) {
      // Advance the room's clock first, then step every sim — the
      // order mirrors a live tick (timers lapse, then sims move).
      simNowAdvance(dt * 1000 * BATCH);
      step(room, BATCH, dt);
      room.messages.respawnTick(simNow());
      simTicks += BATCH;
    }
    const wallMs = performance.now() - t0;
    const simSecs = simTicks * dt;
    const ratio = simSecs / (wallMs / 1000);

    const alive = [...room.players.getAllPlayers().values()].filter((p) => !p.isDead).length;
    const respawned = room.players.getAllPlayers().size;
    // ── Match report ──────────────────────────────────────────────
    // Caps come from flags.capLog — ground truth written at the capture
    // instant (broadcast-diffing can't tell a cap from an end-of-match
    // flag reset). Grabs still diff flagUpdate transitions: carried is
    // unambiguous state.
    type FlagSnap = { team: string; state: string; carrier: string | null };
    const runBy = new Map<string, number>();
    let grabs = 0;
    for (const m of w.msgs) {
      if (m.type !== 'flagUpdate') continue;
      for (const f of (m as unknown as { flags: FlagSnap[] }).flags ?? []) {
        if (f.state === 'carried' && !runBy.has(f.team)) { runBy.set(f.team, 1); grabs++; }
        else if (f.state !== 'carried') runBy.delete(f.team);
      }
    }
    const caps = room.flags!.capLog.filter((c) => c.capAt >= runStart);
    const fastest = caps.reduce((a, b) => (b.holdMs < a.holdMs ? b : a), { by: '-', holdMs: Infinity, team: '' });
    const avgHold = caps.length ? caps.reduce((n, c) => n + c.holdMs, 0) / caps.length / 1000 : 0;
    const players = room.scoring.matchPlayers();
    const fragger = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
    const kd = [...players].sort((a, b) => (b.kills / Math.max(1, b.deaths)) - (a.kills / Math.max(1, a.deaths)))[0];
    const kills = players.reduce((n, p) => n + p.kills, 0);
    const score = Object.entries(room.scores).map(([t, s]) => `${t} ${s}`).join(' / ');
    const fmtId = (id: string) => id.replace(/^BOT-/, '');
    console.log(
      `fastSoak: ${simTicks} ticks, ${simSecs.toFixed(0)} sim-s ` +
      `(${(simSecs / 60).toFixed(1)} sim-min) in ${(wallMs / 1000).toFixed(1)} wall-s ` +
      `— ${ratio.toFixed(0)}x real-time; ${alive}/${respawned} alive`,
    );
    console.log(
      `  match: score ${score}; kills ${kills}; ` +
      `grabs ${grabs} caps ${caps.length}` +
      (caps.length ? `, fastest cap ${(fastest.holdMs / 1000).toFixed(1)}s by ${fmtId(fastest.by)} (${fastest.team}), avg hold ${avgHold.toFixed(1)}s` : '') +
      (fragger ? `; top fragger ${fmtId(fragger.id)} ${fragger.kills}K/${fragger.deaths}D` : '') +
      (kd && kd.id !== fragger?.id ? `; best K/D ${fmtId(kd.id)} ${(kd.kills / Math.max(1, kd.deaths)).toFixed(1)}` : ''),
    );
    // The probe only works if the room genuinely simmed: a bot CTF room
    // at 20Hz should comfortably beat real-time, not crawl at 1x.
    expect(ratio).toBeGreaterThan(10);
    // Honesty check: after ~3h of sim a wall-clock-cheap room would be a
    // graveyard — respawns must have kept cycling (some alive now).
    expect(alive).toBeGreaterThan(0);
  }, WALL_BUDGET_MS + 30_000);
});
