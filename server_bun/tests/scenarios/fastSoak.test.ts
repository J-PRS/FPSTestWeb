import { describe, it, expect, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkRoom, step } from './harness.ts';
import { hmParseBin } from '../../../shared/heightfield.ts';
import { simNow, simNowAdvance, simNowReset } from '../../src/simClock.ts';

// Throughput probe: how much honest sim-time does a real CTF room burn
// through per wall-second when stepped flat-out? "Honest" means the
// whole room runs on the warp clock — respawns, spawn shields, flag and
// match timers all lapse in sim-time, not wall-time, so minutes of
// combat in seconds is actually minutes of combat.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/katabatic.bin`)));

describe('scenario: fast-forward soak throughput', () => {
  afterAll(() => simNowReset());

  it('steps a full 12-bot katabatic CTF room flat-out for 10 wall-s', () => {
    const room = mkRoom({ mode: 'ctf', bots: 12, botFill: 12 }, 'ctf', 4242, false, field);

    const wallBudgetMs = 10_000;
    const dt = 0.05;                      // 20Hz — matches the live tick
    let simTicks = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < wallBudgetMs) {
      // Advance the room's clock first, then step every sim — the
      // order mirrors a live tick (timers lapse, then sims move).
      simNowAdvance(dt * 1000 * 100);
      step(room, 100, dt);
      room.messages.respawnTick(simNow());
      simTicks += 100;
    }
    const wallMs = performance.now() - t0;
    const simSecs = simTicks * dt;
    const ratio = simSecs / (wallMs / 1000);

    const alive = [...room.players.getAllPlayers().values()].filter((p) => !p.isDead).length;
    const respawned = room.players.getAllPlayers().size;
    console.log(
      `fastSoak: ${simTicks} ticks, ${simSecs.toFixed(0)} sim-s ` +
      `(${(simSecs / 60).toFixed(1)} sim-min) in ${(wallMs / 1000).toFixed(1)} wall-s ` +
      `— ${ratio.toFixed(0)}x real-time; ${alive}/${respawned} alive, ` +
      `matchClock left ${(room.matchClock.timeLeftMs() / 60000).toFixed(1)}min`,
    );
    // The probe only works if the room genuinely simmed: a bot CTF room
    // at 20Hz should comfortably beat real-time, not crawl at 1x.
    expect(ratio).toBeGreaterThan(10);
    // Honesty check: after ~3h of sim a wall-clock-cheap room would be a
    // graveyard — respawns must have kept cycling (some alive now).
    expect(alive).toBeGreaterThan(0);
  }, 30000);
});
