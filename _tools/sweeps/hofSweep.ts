/**
 * HoF genome sweep — BASE-LEVEL evolution for the heavy-on-flag role.
 * Two gene families:
 *   categorical — the whole archetype: perk, weapon slots, builder trait.
 *     Class is implicit in the kit (mortar ⇒ heavy, lightning ⇒ light),
 *     so evolution can reject "heavy+mortar+planted" outright if a roving
 *     mid anchor denies better. The mortar stays in the pool on purpose —
 *     if it's dead weight on the stand, the sweep proves it.
 *   continuous — the posted-anchor policy params in BOT_TUNING.hof plus
 *     the bodyblock-pop thresholds and duty/leash scaling.
 *
 * Scored inside REAL 8v8 matches (nobody frozen — offense clears, re-posts,
 * midfield wars all count) with 2 cappers per side for flag-event density.
 *
 *   cd server_bun && bun ../_tools/sweeps/hofSweep.ts [--genomes 16] [--seed 1] [--mins 6]
 *                                                    [--gens 8] [--pop 10] [--cappers 2]
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { PerkId } from '../../shared/perks.ts';
import type { BotLoadout } from '../../shared/botLoadouts.ts';
import { measureDefense, type DefStat } from '../../server_bun/tests/scenarios/defenseMeasure.ts';

const OUT_DIR = resolve(import.meta.dir, 'out');
// Cheapest flag-action density first — successive-halving race.
const MAPS = ['raindance_nef', 'surreal'].map((name) => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  return { name, spec, f, bases: { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) } };
});

// --- categorical genes: the archetype ------------------------------------
const W = WeaponType;
const PERKS: PerkId[] = ['juggernaut', 'plated', 'vitality', 'overcharge', 'featherjets', 'regenerator'];
const NEAR = [W.Chaingun, W.Shotgun, W.Flak, W.Lightning];
const MID  = [W.Disc, W.Cannon, W.GrenadeLauncher, W.PlasmaGun, W.Sticky];
const FAR  = [W.Mortar, W.Disc, W.BoltLauncher, W.PlasmaCannon, W.RocketLauncher];
const BELT = [W.Grenade, W.ClusterBomb, W.Javelin, W.ImpactGrenade, W.ArmorGrenade];
// Categorical dim = [label, option count]. Values stored as indices.
const CDIMS: [string, number][] = [
  ['perk', PERKS.length],
  ['near', NEAR.length],
  ['mid', MID.length],
  ['far', FAR.length],
  ['belt', BELT.length],
  ['builder', 2],
];
// Production archetype for the baseline row.
const BASE_CATS = [0 /* juggernaut */, 0 /* chaingun */, 0 /* disc */, 0 /* mortar */, 0 /* grenade */, 1 /* builder */];

// --- continuous genes: the posted-anchor policy ---------------------------
type Dim = [path: string, lo: number, hi: number];
const DIMS: Dim[] = [
  ['hof.threatR', 15, 90],
  ['hof.dropR', 8, 60],
  ['hof.leanK', 0.01, 0.25],
  ['hof.leanMax', 0.5, 12],
  ['hof.postHome', 1, 15],
  ['hof.postCarried', 5, 60],
  ['moves.blockSelfD', 10, 60],
  ['moves.blockOd', 20, 200],
  ['moves.blockClosing', 2, 20],
  ['moves.blockEta', 0.3, 3],
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

function hofSpecOf(genes: number[]): { perk: PerkId; kit: BotLoadout; builder: boolean } {
  const c = genes.slice(0, CDIMS.length).map((v, i) => Math.min(CDIMS[i]![1] - 1, Math.max(0, Math.round(v))));
  return {
    perk: PERKS[c[0]!]!,
    kit: { perk: PERKS[c[0]!]!, near: NEAR[c[1]!]!, mid: MID[c[2]!]!, far: FAR[c[3]!]!, belt: BELT[c[4]!]!, side: W.Pistol },
    builder: c[5]! === 1,
  };
}
function catLabel(genes: number[]): string {
  const s = hofSpecOf(genes);
  return `${s.perk}+${WeaponType[s.kit.near]}/${WeaponType[s.kit.mid]}/${WeaponType[s.kit.far]}/${WeaponType[s.kit.belt]}${s.builder ? '+build' : ''}`;
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
const GENOMES = arg('genomes', 16);
const SEED = arg('seed', 1);
const MINS = arg('mins', 6);
const GENS = arg('gens', 0);
const POP = arg('pop', 10);
const CAPPERS = arg('cappers', 2);
const ELITES = Math.max(1, Math.floor(POP / 4));

/** Defense quality: concede nothing, kill carriers fast, flag stays home,
 *  HoF alive and dealing. Caps are the catastrophic term. */
function fitness(s: DefStat): number {
  return -s.caps * 120 - s.awayS * 0.6 - s.medHold * 2 - s.grabs * 8
    + s.returns * 10 + s.hofKills * 4 - s.hofDeaths * 3;
}

const defaults = [...BASE_CATS, ...DIMS.map(([p]) => get(p))];
const rng = mulberry32(SEED);
mkdirSync(OUT_DIR, { recursive: true });
const csvPath = resolve(OUT_DIR, `hof_sweep_seed${SEED}.csv`);
if (!existsSync(csvPath)) {
  appendFileSync(csvPath, 'genome,map,arch,' + DIMS.map(d => d[0]).join(',')
    + ',grabs,caps,drops,returns,medHold,awayS,hofK,hofD,kills,scoreA,scoreB,fitness\n');
}

interface Row { genes: number[]; fit: number }
const results: Row[] = [];
let gid = 0;

function evalMap(genes: number[], m: (typeof MAPS)[number], id: number): DefStat {
  const s = measureDefense(m.f, m.bases, m.spec, {
    simBudgetS: MINS * 60, seed: SEED * 1000 + id * 17,
    tag: `g${id}:${m.name}`, hofSpec: hofSpecOf(genes), capperWant: CAPPERS,
  });
  console.log(`  g${id} ${m.name} [${catLabel(genes)}]: caps=${s.caps} grabs=${s.grabs} hold=${s.medHold.toFixed(0)}s away=${s.awayS.toFixed(0)}s hofK=${s.hofKills} hofD=${s.hofDeaths} ret=${s.returns}`);
  appendFileSync(csvPath,
    `${id},${m.name},"${catLabel(genes)}",${genes.slice(CDIMS.length).map(v => v.toFixed(3)).join(',')},${s.grabs},${s.caps},${s.drops},${s.returns},${s.medHold.toFixed(1)},${s.awayS.toFixed(0)},${s.hofKills},${s.hofDeaths},${s.kills},${s.scoreA},${s.scoreB},${fitness(s).toFixed(1)}\n`);
  return s;
}

let raceQueue: { id: number; genes: number[]; fits: number[] }[] = [];
function stageOne(genes: number[]): number {
  const id = gid++;
  genes.slice(CDIMS.length).forEach((v, i) => set(DIMS[i]![0], v));
  const fit = fitness(evalMap(genes, MAPS[0]!, id));
  raceQueue.push({ id, genes: genes.slice(), fits: [fit] });
  return fit;
}
function finishRace(): void {
  raceQueue.sort((a, b) => b.fits[0]! - a.fits[0]!);
  const survivors = raceQueue.slice(0, Math.max(1, Math.ceil(raceQueue.length / 2)));
  for (const q of survivors) {
    q.genes.slice(CDIMS.length).forEach((v, i) => set(DIMS[i]![0], v));
    for (const m of MAPS.slice(1)) {
      q.fits.push(fitness(evalMap(q.genes, m, q.id)));
    }
    results.push({ genes: q.genes, fit: q.fits.reduce((a, b) => a + b, 0) / q.fits.length });
  }
  for (const q of raceQueue.slice(survivors.length)) {
    results.push({ genes: q.genes, fit: q.fits[0]! });
  }
  raceQueue = [];
  defaults.slice(CDIMS.length).forEach((v, i) => set(DIMS[i]![0], v));
}

function gauss(): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

stageOne(defaults.slice());
finishRace();
console.log(`  baseline fit=${results[0]!.fit.toFixed(0)}`);

if (GENS > 0) {
  // Mixed-genome ES: continuous dims get antithetic ±ε children;
  // categorical genes mutate by resample (15% per slot) — a Gaussian
  // nudge on an index isn't a mutation, it's drift toward the middle.
  const mean = results[0]!.genes.slice();
  const sigma = DIMS.map(([, lo, hi]) => (hi - lo) * 0.25);
  for (let gen = 0; gen < GENS; gen++) {
    const pop: { genes: number[]; fit: number }[] = [];
    for (let k = 0; k < Math.ceil(POP / 2); k++) {
      const eps = mean.slice(CDIMS.length).map((_, i) => gauss() * sigma[i]!);
      for (const sign of [1, -1]) {
        if (pop.length >= POP) break;
        const genes = mean.map((m, i) => {
          if (i < CDIMS.length) {
            // categorical slot: resample with 15% chance, else keep mean's pick
            return rng() < 0.15 ? Math.floor(rng() * CDIMS[i]![1]) : m;
          }
          const [, lo, hi] = DIMS[i - CDIMS.length]!;
          return Math.min(hi, Math.max(lo, m + sign * eps[i - CDIMS.length]!));
        });
        const fit = stageOne(genes);
        pop.push({ genes, fit });
      }
    }
    finishRace();
    pop.sort((a, b) => b.fit - a.fit);
    const rankOf = new Map(pop.map((c, i) => [c, pop.length - i - (pop.length + 1) / 2]));
    const elite = pop.slice(0, ELITES);
    const w = elite.map((c) => Math.max(0.1, rankOf.get(c)!));
    const wsum = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < mean.length; i++) {
      mean[i] = elite.reduce((a, e, j) => a + e.genes[i]! * w[j]!, 0) / wsum;
    }
    for (let i = 0; i < sigma.length; i++) {
      const [, lo, hi] = DIMS[i]!;
      sigma[i] = Math.max((hi - lo) * 0.03, sigma[i]! * 0.8);
    }
    console.log(`  gen${gen}: eliteFit=${elite[0]!.fit.toFixed(0)}`);
  }
} else {
  for (let g = 0; g < GENOMES; g++) {
    const genes = [
      ...CDIMS.map(([, n]) => Math.floor(rng() * n)),
      ...DIMS.map(([, lo, hi]) => lo + rng() * (hi - lo)),
    ];
    stageOne(genes);
  }
  finishRace();
}
defaults.slice(CDIMS.length).forEach((v, i) => set(DIMS[i]![0], v));

results.sort((a, b) => b.fit - a.fit);
console.log('\n=== top 5 genomes (higher = better defense) ===');
for (const r of results.slice(0, 5)) {
  const diffs = DIMS.map(([p], i) => {
    const d = r.genes[i + CDIMS.length]! - defaults[i + CDIMS.length]!;
    return Math.abs(d) > 1e-9 ? `${p}=${r.genes[i + CDIMS.length]!.toFixed(2)}` : null;
  }).filter(Boolean).join(' ');
  console.log(`fit=${r.fit.toFixed(0)} arch=${catLabel(r.genes)}\n   ${diffs || '(default policy)'}`);
}
console.log(`\nCSV → ${csvPath}`);
