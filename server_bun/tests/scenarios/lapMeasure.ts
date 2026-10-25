import { mkRoom, step } from './harness.ts';
import { hmHeight, hmScaled, HM_WORLD_SCALE, type Heightfield } from '../../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../../shared/botLoadouts.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { simNow } from '../../src/simClock.ts';
import type { PlayerState } from '../../src/types.ts';

// Lap telemetry: the capper chases a teleporting enemy flag around a square
// circuit — approach AND departure in one loop, so route speed and the
// energy retained through each turn are both on the scoreboard.
export interface LapStat {
  laps: number;         // completed circuits inside the budget
  bestLap: number;      // sim-s of fastest lap
  avgLap: number;       // sim-s mean lap
  legTimes: number[];   // sim-s per leg, in order
  avgSpeed: number;     // m/s over the whole run
  avgE: number;         // mean mechanical energy (banked route economy)
  grabs: number;        // real flag touches — teleport usually beats them
}

export interface LapOpts {
  simBudgetS?: number;  // default 300
  seed?: number;
  tag?: string;
  verbose?: boolean;
  side?: number;        // m — square side (default 800)
  heightScale?: number; // vertical gain on the field (1.0 flat-ish / 1.5 ski world)
}

/** One capper, four checkpoints, a flag that relocates each time he gets
 *  close: the chase IS the lap. Runs on any field; callers pass hmScaled
 *  variants for the 1.0/1.5 vertical-gain comparison. */
export function measureLap(
  fld0: Heightfield,
  spec: Record<string, unknown>,
  opts: LapOpts = {},
): LapStat {
  const side = opts.side ?? 800;
  const hs = opts.heightScale ?? 1;
  const fld = hmScaled(fld0, hs);
  const simBudgetS = opts.simBudgetS ?? 300;

  const room = mkRoom({ ...spec, mode: 'ctf', bots: 6, botFill: 6 }, 'ctf', opts.seed ?? 9001, false, fld);
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  const capper = bots.find((p) => p.team === 'alpha');
  if (!capper) {throw new Error('no alpha bot');}
  const ctl = room.bots as unknown as {
    loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
    roster: { roles: Map<string, string>; refitClass(id: string): void };
  };
  ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
  ctl.roster.refitClass(capper.id);
  ctl.roster.roles.set(capper.id, 'capper');
  for (const p of bots) {if (p !== capper) room.bots.quiet.add(p.id);}

  // Square circuit centered on the map, legs `side` apart.
  const c = HM_WORLD_SCALE / 2;
  const half = side / 2;
  const ring = [
    { x: c - half, z: c - half }, { x: c + half, z: c - half },
    { x: c + half, z: c + half }, { x: c - half, z: c + half },
  ].map((p) => ({ x: p.x, y: hmHeight(fld, p.x, p.z), z: p.z }));

  const flag = room.flags!.flags.get('bravo')!;
  const stat: LapStat = { laps: 0, bestLap: 0, avgLap: 0, legTimes: [], avgSpeed: 0, avgE: 0, grabs: 0 };
  const dt = 0.05;
  let simT = 0;
  const t0 = Date.now();
  let leg = 0;            // index of the checkpoint being chased
  let legStart = 0;       // simT the current leg began
  let lapStart = 0;
  let lastPos: PlayerState['position'] | null = null;
  let pathM = 0, eSum = 0, eSamples = 0;
  const legTimes: number[] = [];
  const mechE = () => {
    const v = capper.velocity;
    return 0.5 * (v.x ** 2 + v.y ** 2 + v.z ** 2) +
      28 * Math.max(0, capper.position.y - hmHeight(fld, capper.position.x, capper.position.z));
  };
  const place = (i: number) => {
    const pt = ring[i % 4]!;
    flag.pos.x = pt.x; flag.pos.y = pt.y; flag.pos.z = pt.z;
    flag.home.x = pt.x; flag.home.y = pt.y; flag.home.z = pt.z;
    if (flag.state !== 'home') {flag.state = 'home';}
    flag.carrier = undefined as never;
  };
  place(0);

  for (let i = 0; i < simBudgetS * 20; i++) {
    if (Date.now() - t0 > simBudgetS * 800) {break;}
    step(room, 1, dt);
    simT += dt;
    room.messages.respawnTick(simNow());
    if (flag.state === 'carried' && flag.carrier === capper.id) {stat.grabs++;}
    if (lastPos) {pathM += Math.hypot(
      capper.position.x - lastPos.x, capper.position.y - lastPos.y, capper.position.z - lastPos.z);}
    lastPos = { ...capper.position };
    eSum += mechE(); eSamples++;

    const tgt = ring[leg % 4]!;
    const near = Math.hypot(capper.position.x - tgt.x, capper.position.z - tgt.z);
    if (near < 25) {
      legTimes.push(simT - legStart);
      leg++;
      legStart = simT;
      if (leg % 4 === 0) {
        const lapT = simT - lapStart;
        stat.laps++;
        if (stat.bestLap === 0 || lapT < stat.bestLap) {stat.bestLap = lapT;}
        if (opts.verbose) {console.log(`  lap ${stat.laps}: ${lapT.toFixed(1)}s`);}
        lapStart = simT;
      }
      place(leg);
    }
    if (opts.verbose && i % 400 === 0) {
      console.log(
        `  t=${simT.toFixed(0)}s leg${leg % 4 + 1} @(${capper.position.x.toFixed(0)},${capper.position.y.toFixed(0)},${capper.position.z.toFixed(0)}) ` +
        `v=${Math.hypot(capper.velocity.x, capper.velocity.z).toFixed(0)} E=${mechE().toFixed(0)}`,
      );
    }
  }
  stat.legTimes = legTimes;
  stat.avgLap = stat.laps > 0 ? legTimes.reduce((a, b) => a + b, 0) / stat.laps : 0;
  stat.avgSpeed = simT > 0 ? pathM / simT : 0;
  stat.avgE = eSamples > 0 ? eSum / eSamples : 0;
  return stat;
}
