/**
 * Cap-stat table — the capper scoreboard, printed per map per seed.
 *
 *   cd server_bun && bun ../_tools/sweeps/capStat.ts [--maps a,b] [--seeds 1,2]
 *                                              [--budget 120] [--repeat 3] [--verbose]
 *
 * Reports the numbers a capper is judged on: grabV (speed through the
 * stand at the grab instant), grab latency, carry time, route pace and
 * banked mechanical energy. Rooms carry the real map spec (structures
 * included), so the stand is the stand a live match uses.
 *
 * --repeat N measures back-to-back caps inside ONE match (default 1 =
 * first cap only, the same thing capRun.test.ts asserts on).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { measureRepeat } from '../../server_bun/tests/scenarios/capRepeat.ts';

const strArg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const numArg = (name: string, dflt: number): number => Number(strArg(name, String(dflt)));

const ALL = ['oasis', 'broadside_nef', 'escalade', 'raindance_nef', 'katabatic', 'surreal'];
const NAMES = strArg('maps', ALL.join(',')).split(',').filter(Boolean);
const SEEDS = strArg('seeds', '1').split(',').map(Number);
const BUDGET = numArg('budget', 120);
const REPEAT = numArg('repeat', 1);
const VERBOSE = process.argv.includes('--verbose');

// --set moves.runInSpeed=52 — poke one BOT_TUNING knob for an A/B without
// editing the table. Repeatable. Dotted path, same shape capperSweep uses.
const sets = process.argv.flatMap((a, i) => (a === '--set' ? [process.argv[i + 1]!] : []));
for (const s of sets) {
  const [path, val] = s.split('=');
  const parts = (path ?? '').split('.');
  const last = parts.pop()!;
  const obj = parts.reduce((o: unknown, k) => (o as Record<string, unknown>)[k], BOT_TUNING as unknown) as Record<string, number>;
  if (!(last in obj)) {throw new Error(`--set: unknown tuning path ${path}`);}
  obj[last] = Number(val);
  console.log(`tune: ${path} = ${val}`);
}

const MAPS = NAMES.map((name) => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };
  const flagM = Math.hypot(bases.alpha.x - bases.bravo.x, bases.alpha.z - bases.bravo.z);
  return { name, f, spec, bases, flagM };
});

const fmt = (v: number, w = 6, d = 1) => v.toFixed(d).padStart(w);

interface Row { map: string; seed: number; caps: number; grabT: number; grabV: number; carryT: number; pace: number; peakE: number; approachE: number }
const rows: Row[] = [];

for (const m of MAPS) {
  for (const seed of SEEDS) {
    // Budget scales with flag distance: a 1km stand-to-stand run is not a
    // 120s question.
    const legs = Math.round(Math.max(BUDGET * 1.2, BUDGET * Math.min(3, m.flagM / 300)));
    const r = measureRepeat(m.f, m.spec, m.bases, {
      simBudgetS: legs * Math.max(1, REPEAT), seed, want: REPEAT, verbose: VERBOSE, tag: `${m.name}:s${seed}`,
    });
    const s = r.stat;
    rows.push({ map: m.name, seed, caps: r.caps, grabT: s.grabT, grabV: s.grabV, carryT: s.carryT, pace: s.avgSpeed, peakE: s.peakE, approachE: s.approachE });
    const vs = r.legs.map(l => l.grabV.toFixed(0)).join(',');
    console.log(
      `${m.name.padEnd(14)} s${seed} flag=${m.flagM.toFixed(0).padStart(4)}m ` +
      `caps=${String(r.caps).padStart(2)} grab=${fmt(s.grabT)}s grabV=${fmt(s.grabV)} ` +
      `carry=${fmt(s.carryT)}s pace=${fmt(s.avgSpeed)} ` +
      `appE=${fmt(s.approachE, 5, 0)} peakE=${fmt(s.peakE, 5, 0)} legs=[${vs}]`,
    );
  }
}

const capped = rows.filter(r => r.caps > 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log('\n=== summary ===');
const totalCaps = rows.reduce((a, r) => a + r.caps, 0);
console.log(`runs=${rows.length} capped=${capped.length}/${rows.length} caps/run=${(totalCaps / rows.length).toFixed(2)}`);
if (capped.length) {
  console.log(`grabs:   t=${fmt(mean(capped.map(r => r.grabT)))}s  v=${fmt(mean(capped.map(r => r.grabV)))} m/s`);
  console.log(`carries: t=${fmt(mean(capped.map(r => r.carryT)))}s  pace=${fmt(mean(capped.map(r => r.pace)))} m/s`);
}
for (const m of MAPS) {
  const rs = rows.filter(r => r.map === m.name);
  const ok = rs.filter(r => r.caps > 0);
  console.log(
    `${m.name.padEnd(14)} caps/run=${(rs.reduce((a, r) => a + r.caps, 0) / rs.length).toFixed(2)}  ` +
    `grabV=${ok.length ? fmt(mean(ok.map(r => r.grabV))) : '  n/a'}  ` +
    `grabT=${ok.length ? fmt(mean(ok.map(r => r.grabT))) : '  n/a'}s  ` +
    `carry=${ok.length ? fmt(mean(ok.map(r => r.carryT))) : '  n/a'}s  ` +
    `pace=${ok.length ? fmt(mean(ok.map(r => r.pace))) : '  n/a'}`,
  );
}
