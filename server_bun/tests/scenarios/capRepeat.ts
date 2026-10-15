import { mkRoom, step, watch } from './harness.ts';
import { hmHeight, type Heightfield } from '../../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { PlayerState } from '../../src/types.ts';
import type { RunStat } from './capMeasure.ts';

// Back-to-back cap telemetry: one capper, one live match, every cap he
// completes timed on its own leg. measureCap stops at the first cap and
// answers "can he do it"; this answers "can he keep doing it" — the
// scoreboard for a capper that is supposed to look effortless.

export interface CapLeg {
  index: number;      // 1-based cap number
  grabT: number;      // sim-s from the previous cap to the grab
  grabV: number;      // planar speed at the grab instant
  carryT: number;     // sim-s holding the flag
  pathM: number;      // meters carried
  pace: number;       // pathM / carryT
  approachE: number;  // mean mechanical E on the approach leg
  peakE: number;      // max E banked on the approach leg
  fumbles: number;    // drops on this leg
}

export interface RepeatStat {
  stat: RunStat;      // roll-up in RunStat shape (means)
  caps: number;
  spanS: number;      // sim-s from first spawn to the last cap
  legs: CapLeg[];
}

export interface RepeatOpts {
  simBudgetS?: number;  // default 600
  seed?: number;
  want?: number;        // stop after this many caps (default: budget)
  verbose?: boolean;
  tag?: string;
}

/** Run one live CTF match with a single capper against frozen bodies and
 *  time every cap back to back. */
export function measureRepeat(
  fld: Heightfield,
  spec: Record<string, unknown>,
  bases: { alpha: { x: number; y: number; z: number }; bravo: { x: number; y: number; z: number } },
  opts: RepeatOpts = {},
): RepeatStat {
  const { simBudgetS = 600, verbose = false, tag = '' } = opts;
  const want = opts.want ?? Infinity;
  const room = mkRoom({ ...spec, mode: 'ctf', bots: 6, botFill: 6, bases }, 'ctf', opts.seed ?? 9001, false, fld);
  const w = watch(room);
  if (!room.flags) {throw new Error('ctf room has no flags');}
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const capper = bots.find((p) => p.team === 'alpha');
  if (!capper) {throw new Error('no alpha bot');}
  const ctl = room.bots as unknown as {
    loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    roster: { roles: Map<string, string>; refitClass(id: string): void };
  };
  ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.DiscPull });
  ctl.roster.refitClass(capper.id);
  ctl.roster.roles.set(capper.id, 'capper');
  capper.perk = 'featherjets';
  room.moveSim.setPerk(capper.id, 'featherjets');
  for (const p of bots) {
    if (p !== capper) {
      room.bots.quiet.add(p.id);
      if (p.team === 'alpha') {ctl.roster.roles.set(p.id, 'offense');}
    }
  }

  const flag = room.flags.flags.get('bravo')!;
  const dt = 0.05;
  const mechE = (p: PlayerState) => 0.5 * (p.velocity.x ** 2 + p.velocity.y ** 2 + p.velocity.z ** 2)
    + 28 * Math.max(0, p.position.y - hmHeight(fld, p.position.x, p.position.z));
  const t0 = Date.now();
  const legs: CapLeg[] = [];
  let simT = 0;
  let legStart = 0;               // when the current cap leg's clock started
  let grabbedAt = -1;
  let grabV = 0;
  let pathM = 0;
  let fumbles = 0;
  let eSum = 0, eSamples = 0, peakE = 0;
  let lastPos: PlayerState['position'] | null = null;
  let score = 0;

  for (let i = 0; i < simBudgetS * 20; i++) {
    if (Date.now() - t0 > simBudgetS * 800) {break;}
    step(room, 1, dt);
    simT += dt;
    const carrying = flag.state === 'carried' && flag.carrier === capper.id;
    if (grabbedAt < 0) {
      // Approach leg: mechanical energy is the capper's real currency —
      // a route that arrives fast but dry is a different animal from one
      // that banked altitude and spent it at the stand.
      const e = mechE(capper);
      eSum += e; eSamples++;
      if (e > peakE) {peakE = e;}
    } else if (lastPos) {
      pathM += Math.hypot(capper.position.x - lastPos.x, capper.position.y - lastPos.y, capper.position.z - lastPos.z);
    }
    lastPos = { ...capper.position };

    if (grabbedAt < 0 && carrying) {
      grabbedAt = simT;
      grabV = Math.hypot(capper.velocity.x, capper.velocity.z);
      pathM = 0;
    }
    if (grabbedAt >= 0 && flag.state === 'dropped') {
      // Fumbled — the leg is spoiled but the run continues; reset the
      // leg clock so the next grab is timed from the fumble.
      fumbles++;
      grabbedAt = -1;
      legStart = simT;
      eSum = 0; eSamples = 0; peakE = 0;
    }
    const sc = w.count('teamScore');
    if (sc > score) {
      // A cap closed the leg (teamScore broadcast) — or the match ended.
      const carryT = simT - grabbedAt;
      legs.push({
        index: legs.length + 1,
        grabT: grabbedAt - legStart,
        grabV,
        carryT,
        pathM,
        pace: carryT > 0 ? pathM / carryT : 0,
        approachE: eSamples > 0 ? eSum / eSamples : 0,
        peakE,
        fumbles,
      });
      score = sc;
      if (verbose) {
        const L = legs[legs.length - 1]!;
        console.log(`  cap#${L.index} [${tag}] grab@${L.grabT.toFixed(1)}s v=${L.grabV.toFixed(1)} ` +
          `carry=${L.carryT.toFixed(1)}s pace=${L.pace.toFixed(1)} approachE=${L.approachE.toFixed(0)} peakE=${L.peakE.toFixed(0)} fumbles=${L.fumbles}`);
      }
      grabbedAt = -1;
      legStart = simT;
      pathM = 0; fumbles = 0; eSum = 0; eSamples = 0; peakE = 0;
      if (legs.length >= want) {break;}
    } else if (grabbedAt >= 0 && w.count('matchEnd') > 0) {
      const carryT = simT - grabbedAt;
      legs.push({ index: legs.length + 1, grabT: grabbedAt - legStart, grabV, carryT, pathM,
        pace: carryT > 0 ? pathM / carryT : 0, approachE: eSamples > 0 ? eSum / eSamples : 0, peakE, fumbles });
      break;
    }
  }

  const n = legs.length;
  const mean = (f: (l: CapLeg) => number) => (n ? legs.reduce((a, l) => a + f(l), 0) / n : 0);
  const stat: RunStat = {
    grabT: mean(l => l.grabT),
    carryT: mean(l => l.carryT),
    pathM: mean(l => l.pathM),
    avgSpeed: mean(l => l.pace),
    avgE: 0,
    caps: n,
    grabV: mean(l => l.grabV),
    peakE: mean(l => l.peakE),
    approachE: mean(l => l.approachE),
  };
  return { stat, caps: n, spanS: legs.length > 0 ? legs[legs.length - 1]!.grabT + legs[legs.length - 1]!.carryT : 0, legs };
}
