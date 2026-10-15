/**
 * Energy-retention sweep — focused 5-dim sweep on the levers that govern
 * how much mechanical energy the capper banks between stands and arrives
 * with at the grab. Scores each genome on grabV (entry speed), approachE
 * (mean approach energy), peakE (max banked E), and avgSpeed.
 *
 *   cd server_bun && bun ../_tools/sweeps/energySweep.ts [--genomes 20] [--seed 1] [--budget 180]
 *
 * The five dims (all from botTuning.ts):
 *   lines.eScoreW       — route scorer's energy weight (default 0.2)
 *   moves.skiVetoRise   — steep-climb grade that releases ski (default 2.7)
 *   moves.skiVetoSpeed  — below this on steep grade, don't ski (default 7)
 *   moves.runInSpeed    — committed runner boost ceiling (default 36)
 *   moves.strikeBankGd  — bank leg distance for refill (default 200)
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { measureCap, type RunStat } from '../../server_bun/tests/scenarios/capMeasure.ts';

const OUT_DIR = resolve(import.meta.dir, 'out');
const MAPS = ['peaks', 'katabatic'].map((name) => {
  const raw = readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`)).toString('utf8');
  const spec = JSON.parse(raw);
  if (!spec.bases?.bravo) { console.error(`bad spec for ${name}: keys=[${Object.keys(spec).join(',')}] bases=${JSON.stringify(spec.bases)}`); process.exit(1); }
  console.error(`DEBUG ${name}: bases.alpha=${JSON.stringify(spec.bases.alpha)} bases.bravo=${JSON.stringify(spec.bases.bravo)} terrain=${spec.terrain}`);
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };
  const flagM = Math.hypot(bases.alpha.x - bases.bravo.x, bases.alpha.z - bases.bravo.z);
  return { name, f, bases, flagM };
});

type Dim = [path: string, lo: number, hi: number];
const DIMS: Dim[] = [
  ['lines.eScoreW', 0.2, 2.0],
  ['moves.skiVetoRise', 0.5, 5.0],
  ['moves.skiVetoSpeed', 3, 16],
  ['moves.runInSpeed', 30, 50],
  ['moves.strikeBankGd', 150, 350],
];

function get(path: string): number {
  return path.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)[k], BOT_TUNING as unknown) as number;
}
function set(path: string, v: number): void {
  const parts = path.split('.');
  const last = parts.pop()!;
  const obj = parts.reduce((o: unknown, k) => (o as Record<string, unknown>)[k], BOT_TUNING as unknown) as Record<string, number>;
  obj[last] = v;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const GENOMES = arg('genomes', 20);
const SEED = arg('seed', 1);
const BUDGET = arg('budget', 180);

function fitness(s: RunStat): number {
  if (!s.caps) return -s.grabT - 1e4;
  return s.caps * 1e4 + s.avgSpeed * 20 - (s.grabT + s.carryT) - s.avgE * 0.5 + s.grabV * 30;
}

const defaults = DIMS.map(([p]) => get(p));
const rng = mulberry32(SEED);
mkdirSync(OUT_DIR, { recursive: true });
const csvPath = resolve(OUT_DIR, `energy_sweep_seed${SEED}.csv`);
if (!existsSync(csvPath)) {
  appendFileSync(csvPath, 'genome,map,' + DIMS.map(d => d[0]).join(',') + ',caps,grabT,carryT,pathM,avgSpeed,grabV,approachE,peakE,fitness\n');
}

interface Row { genes: number[]; stat: RunStat; fit: number }
const results: Row[] = [];
let gid = 0;

function evaluate(genes: number[], tag: string): void {
  genes.forEach((v, i) => set(DIMS[i]![0], v));
  for (const m of MAPS) {
    const stat = measureCap(m.f, m.bases, { simBudgetS: Math.round(Math.max(BUDGET * 1.2, BUDGET * Math.min(3, m.flagM / 300))), tag: `${tag}:${m.name}` });
    const fit = fitness(stat);
    results.push({ genes: genes.slice(), stat, fit });
    appendFileSync(csvPath,
      `${gid},${m.name},${genes.map(v => v.toFixed(3)).join(',')},${stat.caps},${stat.grabT.toFixed(1)},${stat.carryT.toFixed(1)},${stat.pathM.toFixed(0)},${stat.avgSpeed.toFixed(1)},${stat.grabV.toFixed(1)},${stat.approachE.toFixed(0)},${stat.peakE.toFixed(0)},${fit.toFixed(1)}\n`);
    console.log(`g${gid} ${m.name}: caps=${stat.caps} grab=${stat.grabT.toFixed(0)}s carry=${stat.carryT.toFixed(0)}s spd=${stat.avgSpeed.toFixed(1)} grabV=${stat.grabV.toFixed(1)} apprE=${stat.approachE.toFixed(0)} peakE=${stat.peakE.toFixed(0)} fit=${fit.toFixed(0)}`);
  }
  defaults.forEach((v, i) => set(DIMS[i]![0], v));
  gid++;
}

evaluate(defaults.slice(), 'baseline');

for (let g = 0; g < GENOMES; g++) {
  const genes = DIMS.map(([, lo, hi]) => lo + rng() * (hi - lo));
  evaluate(genes, `g${g}`);
}
defaults.forEach((v, i) => set(DIMS[i]![0], v));

results.sort((a, b) => b.fit - a.fit);
console.log('\n=== top 5 genomes (fitness = caps, speed, grabV, energy) ===');
for (const r of results.slice(0, 5)) {
  const diffs = DIMS.map(([p], i) => {
    const d = r.genes[i]! - defaults[i]!;
    return Math.abs(d) > 1e-9 ? `${p}=${r.genes[i]!.toFixed(2)}` : null;
  }).filter(Boolean).join(' ');
  console.log(`fit=${r.fit.toFixed(0)} caps=${r.stat.caps} spd=${r.stat.avgSpeed.toFixed(1)} grabV=${r.stat.grabV.toFixed(1)} apprE=${r.stat.approachE.toFixed(0)} peakE=${r.stat.peakE.toFixed(0)}\n   ${diffs || '(default)'}`);
}

console.log('\n=== baseline for comparison ===');
const base = results.find(r => r.genes.every((g, i) => Math.abs(g - defaults[i]!) < 1e-9));
if (base) {
  console.log(`fit=${base.fit.toFixed(0)} caps=${base.stat.caps} spd=${base.stat.avgSpeed.toFixed(1)} grabV=${base.stat.grabV.toFixed(1)} apprE=${base.stat.approachE.toFixed(0)} peakE=${base.stat.peakE.toFixed(0)}`);
}
console.log(`\nCSV → ${csvPath}`);
