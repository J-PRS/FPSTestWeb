/**
 * Approach probe — tick-resolution telemetry for the last stretch of a
 * capper's run at the enemy stand. Answers "where did the speed go"
 * instead of "did he cap": prints od, speed, height over the flag, the
 * jet gate that fired and the move intent, plus the closest point of
 * approach (CPA) to the flag and the speed there.
 *
 *   cd server_bun && bun ../_tools/sweeps/approachProbe.ts [--map katabatic]
 *        [--seed 9001] [--budget 240] [--window 160] [--dt 4] [--all]
 *
 * --dt N prints every N ticks (default 4 = 0.2s). --all probes every T2
 * map in one go; without it only --map runs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_LOADOUTS } from '../../shared/botLoadouts.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { mkRoom, step, watch } from '../../server_bun/tests/scenarios/harness.ts';

const strArg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const numArg = (name: string, dflt: number): number => Number(strArg(name, String(dflt)));

const ALL = process.argv.includes('--all');
const MAPS = (ALL ? ['oasis', 'broadside_nef', 'escalade', 'raindance_nef', 'katabatic', 'surreal', 'peaks', 'dunes']
  : [strArg('map', 'katabatic')]);
const SEEDS = strArg('seeds', '9001').split(',').map(Number);
const BUDGET = numArg('budget', 240);
const WINDOW = numArg('window', 160);
const DTEVERY = numArg('dt', 4);

for (const name of MAPS) {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  // dunes rides slagheap at 1.5 gain on the default 1500 wrap.
  const f = name === 'dunes'
    ? hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../maps/slagheap.bin'))), 1.5, 1500)
    : hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };
  const flagM = Math.hypot(bases.alpha.x - bases.bravo.x, bases.alpha.z - bases.bravo.z);

  for (const seed of SEEDS) {
    const room = mkRoom({ ...spec, mode: 'ctf', bots: 6, botFill: 6, bases }, 'ctf', seed, false, f);
    const w = watch(room);
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const capper = bots.find((p) => p.team === 'alpha')!;
    const ctl = room.bots as unknown as {
      loadouts: Map<string, (typeof BOT_LOADOUTS)[number]>;
      roster: { roles: Map<string, string>; refitClass(id: string): void };
      brains: Map<string, { jetDebug: { why: string; out: boolean; hold: number; escapeT: number }; standoff: { x: number; z: number; radius: number; strength: number } | null }>;
      lastOut: Map<string, { dest: { x: number; y: number; z: number }; move?: { ski: boolean; jet: boolean; jump: boolean; park?: boolean } }>;
    };
    ctl.loadouts.set(capper.id, { ...BOT_LOADOUTS[0]!, belt: WeaponType.Implodisc });
    ctl.roster.refitClass(capper.id);
    ctl.roster.roles.set(capper.id, 'capper');
    capper.perk = 'featherjets';
    room.moveSim.setPerk(capper.id, 'featherjets');
    for (const p of bots) if (p !== capper) room.bots.quiet.add(p.id);

    const flag = room.flags!.flags.get('bravo')!;
    const dt = 0.05;
    let simT = 0;
    let grabbed = -1, grabV = 0, grabT = 0;
    // CPA to the flag over the whole run: the honest "did the line go
    // through the ring" number.
    let cpa = Infinity, cpaV = 0, cpaT = 0, cpaDy = 0;
    let laps = 0, lastSide = 0, lastR = Infinity;
    console.log(`\n=== ${name} s${seed} flag=${flagM.toFixed(0)}m stand=(${bases.bravo.x.toFixed(0)},${bases.bravo.y.toFixed(0)},${bases.bravo.z.toFixed(0)}) ===`);
    for (let i = 0; i < BUDGET * 20; i++) {
      step(room, 1, dt);
      simT += dt;
      const px = capper.position.x, py = capper.position.y, pz = capper.position.z;
      const od = Math.hypot(flag.pos.x - px, flag.pos.z - pz);
      const spd = Math.hypot(capper.velocity.x, capper.velocity.z);
      const dy = py - flag.pos.y;
      if (flag.state === 'home' || flag.state === 'dropped') {
        if (od < cpa) { cpa = od; cpaV = spd; cpaT = simT; cpaDy = dy; }
      }
      // Lap counter inside the watch ring: a full angular revolution at
      // near-constant radius is the orbit signature.
      if (flag.state === 'home' && od < 40) {
        const ang = Math.atan2(pz - flag.pos.z, px - flag.pos.x);
        const side = Math.sign(Math.sin(ang - 0));
        if (lastR < 40 && side !== lastSide && side !== 0) laps += 0;
        lastSide = side; lastR = od;
      }
      if (grabbed < 0 && flag.carrier === capper.id) {
        grabbed = i; grabV = spd; grabT = simT;
        console.log(`  >>> GRAB t=${simT.toFixed(1)}s v=${spd.toFixed(1)}m/s dy=${dy.toFixed(1)} od=${od.toFixed(1)}`);
      }
      const jd = ctl.brains.get(capper.id)?.jetDebug;
      const so = ctl.brains.get(capper.id)?.standoff;
      const out = ctl.lastOut.get(capper.id);
      const mv = out?.move;
      if (od < WINDOW && i % DTEVERY === 0) {
        console.log(
          `  t=${simT.toFixed(1)} od=${od.toFixed(0).padStart(4)} v=${spd.toFixed(0).padStart(3)} vy=${capper.velocity.y.toFixed(0).padStart(3)} ` +
          `dy=${dy.toFixed(0).padStart(4)} E=${(room.moveSim.energyOf(capper.id) ?? -1).toFixed(0).padStart(3)} ` +
          `jet=${(jd?.why ?? '?').padEnd(8)}${jd?.out ? 'ON ' : 'off'} hold=${(jd?.hold ?? 0).toFixed(1)} ` +
          `esc=${(jd?.escapeT ?? 0).toFixed(1)} so=${so ? `${so.radius.toFixed(0)}@${so.strength.toFixed(2)}` : '-'} ` +
          `mv=${mv ? `${mv.ski ? 'S' : '-'}${mv.jet ? 'J' : '-'}${mv.jump ? 'H' : '-'}${mv.park ? 'P' : '-'}` : '?'} ` +
          `state=${flag.state} dest=(${(out?.dest.x ?? 0).toFixed(0)},${(out?.dest.z ?? 0).toFixed(0)})`,
        );
      }
      if (flag.state === 'carried' && flag.carrier === capper.id) {
        // After the grab, stop logging the approach.
        if (i % 200 === 0) console.log(`  [carrying] t=${simT.toFixed(0)} odHome=${Math.hypot(bases.alpha.x - px, bases.alpha.z - pz).toFixed(0)} v=${spd.toFixed(1)}`);
      }
      if (w.count('matchEnd') > 0) { console.log(`  >>> CAP t=${simT.toFixed(1)} (carry ${(simT - grabT).toFixed(1)}s)`); break; }
      if (flag.state === 'home' && grabbed >= 0) { console.log(`  >>> flag home t=${simT.toFixed(1)} (carry ${(simT - grabT).toFixed(1)}s)`); break; }
    }
    console.log(`  CPA=${cpa.toFixed(1)}m @v=${cpaV.toFixed(1)} dy=${cpaDy.toFixed(1)} t=${cpaT.toFixed(1)}s | grab=${grabT ? grabT.toFixed(1) + 's@' + grabV.toFixed(1) : 'NONE'}`);
  }
}
