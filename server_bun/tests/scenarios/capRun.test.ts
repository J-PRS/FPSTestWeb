import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkRoom, step, watch } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import type { PlayerState } from '../../src/types.ts';

// Cap-run telemetry: a real-terrain CTF match where the capper's speed
// IS the scoreboard — grab time, transit speed, cap time. This is the
// training signal for "real Tribes capper, not sheep llama boi": run it,
// watch the numbers, make the route faster.
const field = hmParseBin(new Uint8Array(readFileSync(`${import.meta.dir}/../../../maps/peaks.bin`)));

/** Two stands ~300m apart on real ground — the flag pos rides the
 *  terrain height at its xz, so bases sit wherever the field says. */
const baseAt = (x: number, z: number) => ({ x, y: hmHeight(field, x, z), z });
const BASES = { alpha: baseAt(-150, 0), bravo: baseAt(150, 0) };

interface RunStat {
  grabT: number;        // sim-s of first grab
  carryT: number;       // sim-s the carrier held the flag
  pathM: number;        // meters the carrier covered while holding
  avgSpeed: number;     // pathM / carryT — the capper's honest route pace
  avgE: number;         // mean mechanical energy ½v²+g·hAGL while carrying
  caps: number;
}

describe('scenario: capper run on real terrain (300m stands)', () => {
  it('a light capper grabs and brings it home — timing logged', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 6,
      bases: BASES,
    }, 'ctf', 9001, false, field);
    const w = watch(room);
    expect(room.flags).not.toBeNull();

    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const alpha = bots.find((p) => p.team === 'alpha');
    const bravo = bots.find((p) => p.team === 'bravo');
    expect(alpha && bravo).toBeTruthy();
    // One side's designated runner: featherjets chaser kit re-fits light,
    // and the roster role makes the stand the job, not the fight.
    const capper = alpha!;
    const ctl = room.bots as unknown as {
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
      roster: { roles: Map<string, string>; refitClass(id: string): void };
      brains: Map<string, { jetDebug: { why: string; escapeT: number; out: boolean; hold: number } }>;
    };
    ctl.loadouts.set(capper.id, BOT_LOADOUTS[0]!); // chaser — featherjets
    ctl.roster.refitClass(capper.id);
    ctl.roster.roles.set(capper.id, 'capper');
    // Pure route metric: every other body freezes — respawn timers run on
    // wall-clock in scenario steps, so a mid-route death would sideline
    // the runner permanently and pollute the timing with a corpse watch.
    for (const p of bots) {
      if (p !== capper) {
        room.bots.quiet.add(p.id);
        if (p.team === 'alpha') ctl.roster.roles.set(p.id, 'offense');
      }
    }

    const stat: RunStat = { grabT: 0, carryT: 0, pathM: 0, avgSpeed: 0, avgE: 0, caps: 0 };
    const dt = 0.05;
    let simT = 0;
    let carrying = false;
    let lastPos: PlayerState['position'] | null = null;
    // The capper's real budget is total mechanical energy — speed read
    // alone hides that a route dumped altitude for nothing. E is
    // measured against local ground so banked potential counts.
    let eSum = 0, eSamples = 0;
    const mechE = () => {
      const v2 = capper.velocity.x ** 2 + capper.velocity.y ** 2 + capper.velocity.z ** 2;
      return 0.5 * v2 + 28 * Math.max(0, capper.position.y - hmHeight(field, capper.position.x, capper.position.z));
    };
    // Long budget — deaths reset the run and a second attempt is honest
    // capper behavior (nobody caps first try on a defended stand).
    for (let i = 0; i < 60 * 240 && stat.caps === 0; i++) {
      step(room, 1, dt);
      simT += dt;
      const bravoFlag = room.flags!.flags.get('bravo')!;
      if (!carrying && bravoFlag.carrier === capper.id) {
        carrying = true;
        stat.grabT = simT;
        lastPos = { ...capper.position };
      }
      if (carrying) {
        if (lastPos) stat.pathM += Math.hypot(
          capper.position.x - lastPos.x,
          capper.position.y - lastPos.y,
          capper.position.z - lastPos.z);
        lastPos = { ...capper.position };
        eSum += mechE(); eSamples++;
        if (bravoFlag.state === 'dropped') {
          // Fumbled mid-route — reset the run clock for the next attempt.
          carrying = false;
          stat.pathM = 0;
          eSum = 0; eSamples = 0;
          lastPos = null;
        }
        if (bravoFlag.state === 'home') {
          stat.caps = w.count('teamScore');
          stat.carryT = simT - stat.grabT;
          stat.avgSpeed = stat.carryT > 0 ? stat.pathM / stat.carryT : 0;
          stat.avgE = eSamples > 0 ? eSum / eSamples : 0;
          break;
        }
      }
      if (i % 40 === 0 && simT < 45) {
        const jd = ctl.brains.get(capper.id)?.jetDebug;
        console.log(
          `    t=${simT.toFixed(0)}s y=${capper.position.y.toFixed(0)} ` +
          `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} vy=${capper.velocity.y.toFixed(0)} ` +
          `E=${mechE().toFixed(0)} ` +
          `jet=${jd?.why ?? '?'}/${jd?.out ? '1' : '0'} hold=${jd?.hold.toFixed(1) ?? '?'} esc=${jd?.escapeT.toFixed(1) ?? '?'}`,
        );
      }
      if (i % 400 === 0) {
        console.log(
          `  t=${simT.toFixed(0)}s capper@(${capper.position.x.toFixed(0)},${capper.position.y.toFixed(0)},${capper.position.z.toFixed(0)}) ` +
          `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} dead=${capper.isDead} ` +
          `bravo=${bravoFlag.state}@(${bravoFlag.pos.x.toFixed(0)},${bravoFlag.pos.y.toFixed(0)},${bravoFlag.pos.z.toFixed(0)})`,
        );
      }
    }

    console.log(
      `capper run: grab@${stat.grabT.toFixed(1)}s carry=${stat.carryT.toFixed(1)}s ` +
      `path=${stat.pathM.toFixed(0)}m avgSpeed=${stat.avgSpeed.toFixed(1)}m/s ` +
      `avgE=${stat.avgE.toFixed(0)} caps=${stat.caps}`,
    );
    expect(stat.caps).toBeGreaterThan(0);
    // A stand-to-stand transit that walks most of the 300m on foot
    // (~15m/s ski pace is the floor; a real cap route beats it).
    expect(stat.avgSpeed).toBeGreaterThan(10);
  }, 120000);
});
