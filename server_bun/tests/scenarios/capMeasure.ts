import { mkRoom, step, watch } from './harness.ts';
import { hmHeight, type Heightfield } from '../../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';

// Cap-run telemetry, parameterized: a real-terrain CTF match where the
// capper's speed IS the scoreboard — grab time, transit speed, cap time.
// The scenario test asserts on it; _tools/sweeps scores genomes with it.
export interface RunStat {
  grabT: number;        // sim-s of first grab
  carryT: number;       // sim-s the carrier held the flag
  pathM: number;        // meters the carrier covered while holding
  avgSpeed: number;     // pathM / carryT — the capper's honest route pace
  avgE: number;         // mean mechanical energy ½v²+g·hAGL while carrying
  caps: number;
  passV: number;        // fastest pass through the stand cylinder (d<40m,
                        // |dy|<15) before the grab — separates "never
                        // arrived fast" from "arrived fast, missed touch"
  passDy: number;       // signed height-over-flag at that fastest pass:
                        // + = sailed over the pole, - = hit below it
  grabV: number;        // speed through the stand at the grab instant —
                        // THE capper stat: llama walk-in vs speed grab
  peakE: number;        // max mechanical E banked during the approach —
                        // the potential-to-kinetic reserve the route built
  approachE: number;    // mean E through the approach — a runner who only
                        // hops low bleeds ~0; skiing banks altitude into E
}

export interface MeasureOpts {
  simBudgetS?: number;  // max sim-seconds to wait for a cap (default 240)
  verbose?: boolean;    // per-beat console telemetry (scenario test = on)
  tag?: string;
  seed?: number;        // room seed — grabT is one deterministic path per
                        // seed, so sweeps sample several rather than
                        // trusting a single trajectory
  bareFlags?: boolean;  // strip the dais colliders — flag on bare terrain,
                        // for isolating ring-orbit behavior from the
                        // ~3m platform hop
}

/** Run one cap attempt cycle on a given field: spawn a light pull-disc
 *  capper, freeze every other body, and time the grab→cap transit. */
export function measureCap(
  fld: Heightfield,
  bases: { alpha: { x: number; y: number; z: number }; bravo: { x: number; y: number; z: number } },
  opts: MeasureOpts = {},
): RunStat {
  const { simBudgetS = 240, verbose = false, tag = '' } = opts;
  const room = mkRoom({
    // botFill pinned to bots — a higher spec floor would top the room up
    // mid-measure and contaminate the baseline.
    mode: 'ctf', bots: 6, botFill: 6,
    bases,
  }, 'ctf', opts.seed ?? 9001, false, fld);
  const w = watch(room);
  if (!room.flags) {throw new Error('ctf room has no flags');}
  if (opts.bareFlags) {
    // Room merges dais hulls into the sims' structure list — override
    // with authored-only so the flag stands on bare ground.
    const authored = room.spec.structures ?? [];
    const sims = room as unknown as {
      moveSim: { attachStructures(l: unknown[]): void };
      projectiles?: { attachStructures(l: unknown[]): void };
    };
    sims.moveSim.attachStructures(authored);
    sims.projectiles?.attachStructures(authored);
  }

  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const alpha = bots.find((p) => p.team === 'alpha');
  const bravo = bots.find((p) => p.team === 'bravo');
  if (!alpha || !bravo) {throw new Error('missing a bot on each team');}
  // One side's designated runner: featherjets chaser kit re-fits light,
  // and the roster role makes the stand the job, not the fight.
  const capper = alpha;
  const ctl = room.bots as unknown as {
    loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    roster: { roles: Map<string, string>; refitClass(id: string): void };
    brains: Map<string, { jetDebug: { why: string; escapeT: number; out: boolean; hold: number } }>;
  };
  // Chaser base + the roster's capper belt swap: the pull disc is
  // what a real capper carries for the forward-implosion launch.
  ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.DiscPull });
  ctl.roster.refitClass(capper.id);
  ctl.roster.roles.set(capper.id, 'capper');
  // Same perk pin rebalanceTeam applies in a live roster — the direct
  // roles.set here skips it otherwise.
  capper.perk = 'featherjets';
  room.moveSim.setPerk(capper.id, 'featherjets');
  // Pure route metric: every other body freezes — respawn timers run on
  // wall-clock in scenario steps, so a mid-route death would sideline
  // the runner permanently and pollute the timing with a corpse watch.
  for (const p of bots) {
    if (p !== capper) {
      room.bots.quiet.add(p.id);
      if (p.team === 'alpha') {ctl.roster.roles.set(p.id, 'offense');}
    }
  }

  const stat: RunStat = { grabT: 0, carryT: 0, pathM: 0, avgSpeed: 0, avgE: 0, caps: 0, passV: 0, passDy: 0, grabV: 0, peakE: 0, approachE: 0 };
  const dt = 0.05;
  let simT = 0;
  // Wall-clock watchdog: a degenerate genome (or plain bad luck) can
  // send the capper into an orbit that never resolves — the sim loop
  // stays bounded, but a pathological think loop inside step() is not.
  // Sweeps bail at ~3x the expected wall time instead of hanging.
  const t0 = Date.now();
  const wallBudget = simBudgetS * 800;
  let carrying = false;
  let lastAliveT = 0;
  let lastPos: PlayerState['position'] | null = null;
  // The capper's real budget is total mechanical energy — speed read
  // alone hides that a route dumped altitude for nothing. E is
  // measured against local ground so banked potential counts.
  let eSum = 0, eSamples = 0;
  let aSum = 0, aSamples = 0;
  const mechE = () => {
    const v2 = capper.velocity.x ** 2 + capper.velocity.y ** 2 + capper.velocity.z ** 2;
    return 0.5 * v2 + 28 * Math.max(0, capper.position.y - hmHeight(fld, capper.position.x, capper.position.z));
  };
  // Spendable energy: ½v² + g·(altitude ABOVE the destination). The AGL
  // metric reads a grounded climb as a loss (h~0 while v falls) when
  // it's really conversion — height over the flag is the bank a route
  // can cash into speed; height below it is debt the tank must repay.
  const flagY = bases.bravo.y;
  const spendE = () => {
    const v2 = capper.velocity.x ** 2 + capper.velocity.y ** 2 + capper.velocity.z ** 2;
    return 0.5 * v2 + 28 * (capper.position.y - flagY);
  };
  // Bleed forensics: a sharp spendable-E drop is a REAL loss — landing
  // on flat/rising ground killing vy, ground friction on a ski-released
  // climb, or thrust spent fighting a face. Conversions don't count
  // here: banked altitude still reads in the total.
  let ePrev = 0, dropAcc = 0, dropT0 = 0;
  const drops: { t: number; dE: number; v: number; agl: number; dy: number; slope: number; air: boolean; jet: string }[] = [];
  const trace: string[] = [];
  // Long budget — deaths reset the run and a second attempt is honest
  // capper behavior (nobody caps first try on a defended stand).
  for (let i = 0; i < simBudgetS * 20 && stat.caps === 0; i++) {
    if (Date.now() - t0 > wallBudget) {break;}
    step(room, 1, dt);
    simT += dt;
    const bravoFlag = room.flags!.flags.get('bravo')!;
    if (capper.isDead) {
      if (simT - lastAliveT > 5) {break;}
    } else {
      lastAliveT = simT;
    }
    if (!capper.isDead && !carrying) {
      const fd = Math.hypot(capper.position.x - bravoFlag.pos.x, capper.position.z - bravoFlag.pos.z);
      const fdy = Math.abs(capper.position.y - bravoFlag.pos.y);
      if (fd < 40 && fdy < 15) {
        const pv = Math.hypot(capper.velocity.x, capper.velocity.z);
        if (pv > stat.passV) {stat.passV = pv; stat.passDy = capper.position.y - bravoFlag.pos.y;}
      }
    }
    if (!capper.isDead) {
      const e = mechE();
      if (!carrying) { aSum += e; aSamples++; if (e > stat.peakE) {stat.peakE = e;} }
      const se = spendE();
      if (!carrying && ePrev - se > 0) {
        dropAcc += ePrev - se;
        if (ePrev - se > 400) {dropT0 = dropT0 || simT;}
      } else if (dropAcc > 0) {
        if (dropAcc > 150) {
          const agl = capper.position.y - hmHeight(fld, capper.position.x, capper.position.z);
          const spd = Math.hypot(capper.velocity.x, capper.velocity.z);
          const nvx = spd > 0.5 ? capper.velocity.x / spd : 0, nvz = spd > 0.5 ? capper.velocity.z / spd : 0;
          const slope = hmHeight(fld, capper.position.x + nvx * 8, capper.position.z + nvz * 8) - hmHeight(fld, capper.position.x, capper.position.z);
          drops.push({ t: dropT0 || simT, dE: dropAcc, v: spd, agl, dy: capper.position.y - flagY, slope, air: agl > 2, jet: ctl.brains.get(capper.id)?.jetDebug.why ?? '?', en: room.moveSim.energyOf(capper.id) } as never);
          if (drops.length > 12) {drops.shift();}
        }
        dropAcc = 0; dropT0 = 0;
      }
      ePrev = se;
    }
    if (verbose && !carrying && i % 20 === 0) {
      const jd = ctl.brains.get(capper.id)?.jetDebug;
      trace.push(
        `    t=${simT.toFixed(0)}s d=${Math.hypot(capper.position.x - bravoFlag.pos.x, capper.position.z - bravoFlag.pos.z).toFixed(0)} ` +
        `y=${capper.position.y.toFixed(0)} dy=${(capper.position.y - bravoFlag.pos.y).toFixed(0)} ` +
        `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} vy=${capper.velocity.y.toFixed(0)} ` +
        `en=${(room.moveSim.energyOf(capper.id) ?? -1).toFixed(0)} jet=${jd?.why ?? '?'}/${jd?.out ? '1' : '0'}`,
      );
      if (trace.length > 24) {trace.shift();}
    }
    if (!carrying && bravoFlag.carrier === capper.id) {
      carrying = true;
      stat.grabT = simT;
      stat.grabV = Math.hypot(capper.velocity.x, capper.velocity.z);
      lastPos = { ...capper.position };
      if (verbose) { for (const r of trace) {console.log(r);} trace.length = 0; }
    }
    if (carrying) {
      if (lastPos) {stat.pathM += Math.hypot(
        capper.position.x - lastPos.x,
        capper.position.y - lastPos.y,
        capper.position.z - lastPos.z);}
      lastPos = { ...capper.position };
      eSum += mechE(); eSamples++;
      if (bravoFlag.state === 'dropped') {
        // Fumbled mid-route — reset the run clock for the next attempt.
        carrying = false;
        stat.pathM = 0;
        eSum = 0; eSamples = 0;
        lastPos = null;
      }
      if (w.count('matchEnd') > 0) {
        // A cap that wins the match never flips the flag back 'home'
        // until the intermission lapses — the matchEnd IS the cap tick.
        stat.caps = w.count('teamScore');
        stat.carryT = simT - stat.grabT;
        stat.avgSpeed = stat.carryT > 0 ? stat.pathM / stat.carryT : 0;
        stat.avgE = eSamples > 0 ? eSum / eSamples : 0;
        stat.approachE = aSamples > 0 ? aSum / aSamples : 0;
        break;
      }
      if (bravoFlag.state === 'home') {
        stat.caps = w.count('teamScore');
        stat.carryT = simT - stat.grabT;
        stat.avgSpeed = stat.carryT > 0 ? stat.pathM / stat.carryT : 0;
        stat.avgE = eSamples > 0 ? eSum / eSamples : 0;
        stat.approachE = aSamples > 0 ? aSum / aSamples : 0;
        break;
      }
    }
    if (verbose && i % 40 === 0 && (simT < 45 || carrying)) {
      const jd = ctl.brains.get(capper.id)?.jetDebug;
      console.log(
        `    t=${simT.toFixed(0)}s y=${capper.position.y.toFixed(0)} ` +
        `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} vy=${capper.velocity.y.toFixed(0)} ` +
        `E=${mechE().toFixed(0)} ` +
        `en=${(room.moveSim.energyOf(capper.id) ?? -1).toFixed(0)} ` +
        `sh=${(() => { const s = (room.moveSim as unknown as { shadows: Map<string, { jetWanted: boolean; skillDrainPerSec: number }> }).shadows.get(capper.id); return s ? `jw${s.jetWanted ? 1 : 0}/sd${s.skillDrainPerSec.toFixed(0)}` : '-'; })()} ` +
        `st=${capper.status} ` +
        `jet=${jd?.why ?? '?'}/${jd?.out ? '1' : '0'} hold=${jd?.hold.toFixed(1) ?? '?'} esc=${jd?.escapeT.toFixed(1) ?? '?'}`,
      );
    }
    if (verbose && i % 400 === 0) {
      console.log(
        `  t=${simT.toFixed(0)}s capper@(${capper.position.x.toFixed(0)},${capper.position.y.toFixed(0)},${capper.position.z.toFixed(0)}) ` +
        `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} dead=${capper.isDead} ` +
        `bravo=${bravoFlag.state}@(${bravoFlag.pos.x.toFixed(0)},${bravoFlag.pos.y.toFixed(0)},${bravoFlag.pos.z.toFixed(0)})`,
      );
    }
  }

  if (verbose) {
    console.log(
      `capper run [${tag}]: grab@${stat.grabT.toFixed(1)}s carry=${stat.carryT.toFixed(1)}s ` +
      `path=${stat.pathM.toFixed(0)}m avgSpeed=${stat.avgSpeed.toFixed(1)}m/s ` +
      `grabV=${stat.grabV.toFixed(1)}m/s passV=${stat.passV.toFixed(1)}@${stat.passDy.toFixed(0)} approachE=${stat.approachE.toFixed(0)} peakE=${stat.peakE.toFixed(0)} ` +
      `avgE=${stat.avgE.toFixed(0)} caps=${stat.caps}`,
    );
    for (const d of drops) {
      console.log(
        `    bleed t=${d.t.toFixed(0)}s -${d.dE.toFixed(0)}E v=${d.v.toFixed(0)} agl=${d.agl.toFixed(0)} en=${(d as { en?: number }).en ?? '?'} ` +
        `slope8m=${d.slope.toFixed(1)} dy=${d.dy.toFixed(0)} ${d.air ? 'AIR' : 'GND'} jet=${d.jet}`,
      );
    }
  }
  return stat;
}
