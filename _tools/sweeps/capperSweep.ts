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
import { measureLap } from '../../server_bun/tests/scenarios/lapMeasure.ts';

const OUT_DIR = resolve(import.meta.dir, 'out');
// Real T2 routes only (porter-imported .mis flags + .ter heightfields;
// the flat hand-authored specs like raindance/crossfire/henge are NOT
// real T2 maps and are excluded). Chosen to span the 121m→982m
// flag-distance range so a genome can't win on one terrain's quirks.
const MAPS = ['oasis', 'broadside_nef', 'escalade', 'raindance_nef', 'katabatic', 'surreal'].map((name) => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };
  const flagM = Math.hypot(bases.alpha.x - bases.bravo.x, bases.alpha.z - bases.bravo.z);
  return { name, f, bases, flagM };
});

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
  ['moves.tapEnergyMin', 4, 50],
  ['moves.diveAglMin', 4, 40],
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
  ['moves.hopRiseFar', 1, 6],
  ['moves.hopRiseHi', 1, 6],
  ['moves.tailTapSpeed', 25, 70],
  ['moves.boostRise', 0, 4],
  ['steer.step', 3, 20],
  ['steer.turnRate', 1.5, 10],
  ['steer.slopeThresh', 0.2, 1.2],
  ['steer.landW', 0, 1.5],
  ['graph.climbTax', 0, 0.2],
  ['graph.diveCredit', 0, 0.15],
  ['graph.dipTax', 0, 0.15],
  ['graph.ahead', 15, 80],
  ['brain.thinkS', 0.1, 0.8],
  ['brain.heroThinkK', 0.2, 1.5],
  ['brain.wanderBase', 0.1, 1.5],
  ['brain.wanderRand', 0.1, 1.5],
  ['brain.dutyBase', 0.1, 1.5],
  ['brain.dutyRand', 0.1, 1.5],
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
const GENS = arg('gens', 0);   // >0 = evolution mode (no flat random phase)
const POP = arg('pop', 4);     // children per generation
const ELITES = Math.max(1, Math.floor(POP / 4));
const USE_KAT = process.argv.includes('--kat'); // --kat restricts to katabatic only
// --lap: checkpoint-circuit mode — the capper laps an 800m square chasing a
// teleporting flag on raindance at 1.0x and 1.5x vertical gain. Fitness is
// lap pace: approach AND departure economy in one number.
const LAP = process.argv.includes('--lap');
const MAP_LIST = LAP ? MAPS.filter(m => m.name === 'raindance_nef') : (USE_KAT ? MAPS.filter(m => m.name === 'katabatic') : MAPS);
const LAP_SCALES = [1.0, 1.5];

/** Fitness: a cap is mandatory, then shorter is better — total latency
 *  is grab+transit; banked E is the tiebreak (fast AND efficient). */
function fitness(s: RunStat): number {
  if (!s.caps) return -s.grabT - 1e4; // never capped — distance-to-grab is the signal
  return s.caps * 1e4 + s.avgSpeed * 20 - (s.grabT + s.carryT) - s.avgE * 0.5;
}

const defaults = DIMS.map(([p]) => get(p));
const rng = mulberry32(SEED);
mkdirSync(OUT_DIR, { recursive: true });
const csvPath = resolve(OUT_DIR, `capper_sweep_${MAP_LIST.length > 1 ? 't2' : MAP_LIST[0]!.name}_seed${SEED}.csv`);
if (!existsSync(csvPath)) {
  appendFileSync(csvPath, 'genome,map,' + DIMS.map(d => d[0]).join(',') + ',caps,grabT,carryT,pathM,avgSpeed,avgE,fitness\n');
}

interface Row { genes: number[]; stat: RunStat; fit: number }
const results: Row[] = [];
let gid = 0;

function evaluate(genes: number[], tag: string): void {
  genes.forEach((v, i) => set(DIMS[i]![0], v));
  for (const m of MAP_LIST) {
    for (let t = 0; t < TRIALS; t++) {
      if (LAP) {
        for (const hs of LAP_SCALES) {
          const st = measureLap(m.f, m as unknown as Record<string, unknown>, { simBudgetS: BUDGET, heightScale: hs, tag: `${tag}:${m.name}@${hs}` });
          // One cap-chase circuit ~3.2km; lap pace is the honest number —
          // banked E the tiebreak. No laps = the genome never corners.
          const fit = st.laps * 1e4 + st.avgSpeed * 40 - (st.avgLap || st.legTimes.reduce((a, b) => a + b, 0)) - st.avgE * 0.3;
          results.push({ genes: genes.slice(), stat: { grabT: st.legTimes[0] ?? 0, carryT: st.avgLap, pathM: st.avgSpeed * BUDGET, avgSpeed: st.avgSpeed, avgE: st.avgE, caps: st.laps }, fit });
          appendFileSync(csvPath,
            `${gid},${m.name}@x${hs},${genes.map(v => v.toFixed(3)).join(',')},${st.laps},${(st.legTimes[0] ?? 0).toFixed(1)},${st.avgLap.toFixed(1)},${(st.avgSpeed * BUDGET).toFixed(0)},${st.avgSpeed.toFixed(1)},${st.avgE.toFixed(0)},${fit.toFixed(1)}\n`);
          console.log(`g${gid} ${m.name}@x${hs} t${t}: laps=${st.laps} best=${st.bestLap.toFixed(0)}s avg=${st.avgLap.toFixed(0)}s spd=${st.avgSpeed.toFixed(1)} E=${st.avgE.toFixed(0)} fit=${fit.toFixed(0)}`);
        }
        continue;
      }
      const stat = measureCap(m.f, m.bases, { simBudgetS: Math.round(BUDGET * Math.min(3, Math.max(1, m.flagM / 300))), tag: `${tag}:${m.name}` });
      const fit = fitness(stat);
      results.push({ genes: genes.slice(), stat, fit });
      appendFileSync(csvPath,
        `${gid},${m.name},${genes.map(v => v.toFixed(3)).join(',')},${stat.caps},${stat.grabT.toFixed(1)},${stat.carryT.toFixed(1)},${stat.pathM.toFixed(0)},${stat.avgSpeed.toFixed(1)},${stat.avgE.toFixed(0)},${fit.toFixed(1)}\n`);
      console.log(`g${gid} ${m.name} t${t}: caps=${stat.caps} grab=${stat.grabT.toFixed(0)}s carry=${stat.carryT.toFixed(0)}s spd=${stat.avgSpeed.toFixed(1)} E=${stat.avgE.toFixed(0)} fit=${fit.toFixed(0)}`);
    }
  }
  defaults.forEach((v, i) => set(DIMS[i]![0], v)); // restore before next genome
  gid++;
}

// Gaussian sample (Box-Muller) for the evolution mode.
function gauss(): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Baseline: unmodified tuning, for the report's delta column.
evaluate(defaults.slice(), 'baseline');

if (GENS > 0) {
  // (μ/μ,λ) evolution strategy: children drawn ~N(mean, sigma) around
  // the current best region; mean recenters on the top quartile each
  // generation and sigma anneals — local refinement after the random
  // phase maps the terrain. True CMA-ES adds covariance; this is the
  // cheap diagonal version.
  const mean = defaults.slice();
  const sigma = DIMS.map(([, lo, hi]) => (hi - lo) * 0.25);
  for (let gen = 0; gen < GENS; gen++) {
    const pop: { genes: number[]; fit: number }[] = [];
    for (let k = 0; k < POP; k++) {
      const genes = mean.map((m, i) => {
        const [, lo, hi] = DIMS[i]!;
        return Math.min(hi, Math.max(lo, m + gauss() * sigma[i]!));
      });
      const before = results.length;
      evaluate(genes, `gen${gen}e${k}`);
      const fit = results.slice(before).reduce((a, r) => a + r.fit, 0) / Math.max(1, results.length - before);
      pop.push({ genes, fit });
    }
    pop.sort((a, b) => b.fit - a.fit);
    const elite = pop.slice(0, ELITES);
    for (let i = 0; i < mean.length; i++) {
      mean[i] = elite.reduce((a, e) => a + e.genes[i]!, 0) / elite.length;
    }
    for (let i = 0; i < sigma.length; i++) {
      const [, lo, hi] = DIMS[i]!;
      sigma[i] = Math.max((hi - lo) * 0.03, sigma[i]! * 0.8);
    }
    console.log(`  gen${gen}: eliteFit=${elite[0]!.fit.toFixed(0)} meanFit=${(elite.reduce((a, e) => a + e.fit, 0) / elite.length).toFixed(0)}`);
  }
} else {
  for (let g = 0; g < GENOMES; g++) {
    const genes = DIMS.map(([, lo, hi]) => lo + rng() * (hi - lo));
    evaluate(genes, `g${g}`);
  }
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
