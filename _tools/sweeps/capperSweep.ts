/**
 * Capper genome sweep — random-samples BOT_TUNING, scores each genome on
 * the real cap-run loop (grab time, carry time, transit speed, banked
 * mechanical energy), and writes a CSV + a best-config printout.
 *
 *   cd server_bun && bun ../_tools/sweeps/capperSweep.ts [--genomes 24] [--trials 2] [--seed 1] [--budget 120]
 *
 * 'spawn bunch of cappers with random attributes and see which get the
 * best capping times' — this is that, with a fitness column. Re-run with
 * --seed N for a different draw; winners get folded back into BOT_TUNING
 * defaults or drive a CMA-ES pass later.
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { measureCap, type RunStat } from '../../server_bun/tests/scenarios/capMeasure.ts';

const OUT_DIR = resolve(import.meta.dir, 'out');
const field = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../maps/peaks.bin'))));
const kat = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../maps/katabatic.bin'))));
const baseAt = (f: typeof field, x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const PEAKS = { alpha: baseAt(field, -150, 0), bravo: baseAt(field, 150, 0) };
const KAT = { alpha: baseAt(kat, 236.85, -127.11), bravo: baseAt(kat, -423.57, 281.67) };

// Genome dims: [dotted BOT_TUNING path, min, max]. Bounds are sane ranges
// around the defaults — the sweep may find the interesting corner.
type Dim = [path: string, lo: number, hi: number];
const DIMS: Dim[] = [
  ['moves.jetHoldBase', 0.1, 1.5],
  ['moves.jetHoldRand', 0.0, 1.2],
  ['moves.tankedMin', 0, 45],
  ['moves.comfyEnergy', 10, 60],
  ['moves.runwayBase', 10, 120],
  ['moves.runwayDropK', 0.5, 5],
  ['moves.runwaySpeedK', 0.1, 1.5],
  ['moves.ceilingAgl', 12, 80],
  ['moves.runInSpeed', 15, 45],
  ['moves.runInGdMax', 40, 200],
  ['moves.hopSpeed', 2, 15],
  ['moves.skiVetoRise', 1, 8],
  ['moves.skiVetoSpeed', 3, 16],
  ['moves.climbRise', 0.5, 6],
  ['lines.commitS', 0.5, 6],
  ['lines.reach', 25, 140],
  ['lines.runnerReachK', 1, 4],
  ['lines.runnerConeK', 0.8, 4],
  ['lines.runnerDropW', 0.5, 4],
  ['lines.runnerStraightW', 0.5, 10],
  ['lines.apexGd', 60, 400],
  ['lines.apexW', 0, 2.5],
  ['lines.progressW', 0.3, 2],
  ['lines.earlyClimbW', 0, 60],
  ['steer.step', 3, 20],
  ['steer.turnRate', 1.5, 10],
  ['steer.slopeThresh', 0.2, 1.2],
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

// Deterministic RNG — a sweep must be replayable.
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
const GENOMES = arg('genomes', 24);
const TRIALS = arg('trials', 2);
const SEED = arg('seed', 1);
const BUDGET = arg('budget', 120);
const USE_KAT = process.argv.includes('--kat'); // the ~775m route instead of 300m
const MAP = USE_KAT ? { f: kat, bases: KAT, name: 'katabatic' } : { f: field, bases: PEAKS, name: 'peaks' };

/** Fitness: a cap is mandatory, then shorter is better — total latency
 *  is grab+transit; banked E is the tiebreak (fast AND efficient). */
function fitness(s: RunStat): number {
  if (!s.caps) return -s.grabT - 1e4; // never capped — distance-to-grab is the signal
  return s.caps * 1e4 + s.avgSpeed * 20 - (s.grabT + s.carryT) - s.avgE * 0.5;
}

const defaults = DIMS.map(([p]) => get(p));
const rng = mulberry32(SEED);
mkdirSync(OUT_DIR, { recursive: true });
const csvPath = resolve(OUT_DIR, `capper_sweep_${MAP.name}_seed${SEED}.csv`);
if (!existsSync(csvPath)) {
  appendFileSync(csvPath, 'genome,trial,' + DIMS.map(d => d[0]).join(',') + ',caps,grabT,carryT,pathM,avgSpeed,avgE,fitness\n');
}

interface Row { genes: number[]; stat: RunStat; fit: number }
const results: Row[] = [];

// Baseline: unmodified tuning, for the report's delta column.
for (let t = 0; t < TRIALS; t++) {
  const stat = measureCap(MAP.f, MAP.bases, { simBudgetS: BUDGET, tag: 'baseline' });
  results.push({ genes: defaults.slice(), stat, fit: fitness(stat) });
}

for (let g = 0; g < GENOMES; g++) {
  const genes = DIMS.map(([, lo, hi]) => lo + rng() * (hi - lo));
  for (let t = 0; t < TRIALS; t++) {
    genes.forEach((v, i) => set(DIMS[i]![0], v));
    const stat = measureCap(MAP.f, MAP.bases, { simBudgetS: BUDGET, tag: `g${g}` });
    const fit = fitness(stat);
    results.push({ genes, stat, fit });
    appendFileSync(csvPath,
      `${g},${t},${genes.map(v => v.toFixed(3)).join(',')},${stat.caps},${stat.grabT.toFixed(1)},${stat.carryT.toFixed(1)},${stat.pathM.toFixed(0)},${stat.avgSpeed.toFixed(1)},${stat.avgE.toFixed(0)},${fit.toFixed(1)}\n`);
    console.log(`g${g} t${t}: caps=${stat.caps} grab=${stat.grabT.toFixed(0)}s carry=${stat.carryT.toFixed(0)}s spd=${stat.avgSpeed.toFixed(1)} E=${stat.avgE.toFixed(0)} fit=${fit.toFixed(0)}`);
  }
  defaults.forEach((v, i) => set(DIMS[i]![0], v)); // restore before next genome
}
defaults.forEach((v, i) => set(DIMS[i]![0], v));

results.sort((a, b) => b.fit - a.fit);
console.log('\n=== top 5 genomes (fitness = caps, then speed/latency/energy) ===');
for (const r of results.slice(0, 5)) {
  const diffs = DIMS.map(([p], i) => {
    const d = r.genes[i]! - defaults[i]!;
    return Math.abs(d) > 1e-9 ? `${p}=${r.genes[i]!.toFixed(2)}` : null;
  }).filter(Boolean).join(' ');
  console.log(`fit=${r.fit.toFixed(0)} caps=${r.stat.caps} grab=${r.stat.grabT.toFixed(0)}s carry=${r.stat.carryT.toFixed(0)}s spd=${r.stat.avgSpeed.toFixed(1)} E=${r.stat.avgE.toFixed(0)}\n   ${diffs || '(default)'}`);
}
console.log(`\nCSV → ${csvPath}`);
void KAT; // long route available via --kat later if needed
