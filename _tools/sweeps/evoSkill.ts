/**
 * evoSkill.ts — skill-dial evolution pit. Unlike hhEvo (whole-team build
 * scored on headhunt margin), each genome is a BotTierMods row applied
 * continuously (floats, not tier names) to a slice of one FFA room's
 * bots, and fitness reads what the user actually asked about:
 *
 *   HA%      — hits / shots, per genome (botShot + hit room events)
 *   energy   — mean energy-pool fill sampled once per sim-second, plus
 *              dry-out transitions (energy reaches 0 while previously
 *              >0 — the "ran the tank empty" moments)
 *
 * Every bot in a dm match carries a genome; they frag each other, so a
 * genome's numbers are earned against dodging targets, not dummies.
 * Selection keeps the top half by `ha + wE*energyFill`; losers re-roll
 * as mutants of random survivors.
 *
 *   bun _tools/sweeps/evoSkill.ts                      # 6 genomes, 4 gens
 *   bun _tools/sweeps/evoSkill.ts --gens 8 --bots 16 --mins 4
 *
 * Appends JSONL per generation to _tools/sweeps/out/evoSkill.jsonl —
 * each line carries every genome's full metric row, so "which dial
 * moved HA%" is answerable by diffing winners vs losers across gens.
 */
process.env.FPS_MPC_OFF ??= '1';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import type { BotSkill } from '../../shared/botSkill.ts';
import { ENERGY, GRAVITY } from '../../shared/movement.ts';
import type { BotTierMods } from '../../shared/botSkill.ts';
import { hmParseBin, hmScaled, hmHeight } from '../../shared/heightfield.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { BotLoadout } from '../../shared/botLoadouts.ts';

const arg = (name: string, dflt: string | number): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : String(dflt);
};
const POP = Number(arg('pop', 6));
const GENS = Number(arg('gens', 4));
const BOTS = Number(arg('bots', 12));
const MINS = Number(arg('mins', 3));
const SEED = Number(arg('seed', 1));
const ARENA = Number(arg('arena', 250));
const WE = Number(arg('we', 0.5));        // energy weight in fitness
// --pure <WeaponName>: every slot on every bot holds the same gun —
// kills the weapon-mix confound in HA%. --map <name>: real terrain
// (maps/<name>.bin+.json) instead of the flat harness field — the
// energy axis only means anything with real skiing to fuel it.
const PURE = arg('pure', '');
const MAP = arg('map', '');
// --inject aim=1.45,jit=0.5,temp=1.3,react=0.45: pin a named genome
// into slot 0 — e.g. the impossible tier row — as a fixed ceiling probe.
const INJECT = arg('inject', '');
// --fit air|ha|mech: fitness numerator - air = ha+a share (default),
// ha = the >5m bucket alone, mech = mean ½v²+g·h per unit mass
// (conserve total energy; altitude falls out of the physics).
const FIT = arg('fit', 'air');
const MODE = arg('mode', 'dm');
const parseGenome = (s: string): Genome => {
  const g = { ...BASE } as Genome;
  for (const kv of s.split(',')) {
    const [k, v] = kv.split('=');
    const key = k === 'jit' ? 'jitter' : k === 'temp' ? 'temper' : k;
    if (key && key in CLAMP && v) {(g as Record<string, number>)[key] = Number(v);}
  }
  return g;
};
const OUT_DIR = resolve(import.meta.dir, 'out');
mkdirSync(OUT_DIR, { recursive: true });
const OUT = resolve(OUT_DIR, 'evoSkill.jsonl');

type Genome = { aim: number; move: number; react: number; jitter: number; temper: number; thrift: number; airLove: number };
const BASE: Genome = { aim: 1, move: 1, react: 1, jitter: 1, temper: 1, thrift: 0, airLove: 0 };
const CLAMP: Record<keyof Genome, [number, number]> = {
  aim: [0.4, 1.6], move: [0.5, 1.5], react: [0.3, 2.5], jitter: [0.3, 2.5], temper: [0.6, 1.5], thrift: [0, 0.95], airLove: [0, 1],
};

// Own mulberry32 — NEVER botRand: the room's seeded stream must draw
// the identical sequence with or without this driver running.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6D_2B_79_F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rng = prng(SEED);

const mutate = (g: Genome): Genome => {
  const m = { ...g };
  const keys = Object.keys(m) as (keyof Genome)[];
  const hits = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < hits; i++) {
    const k = keys[Math.floor(rng() * keys.length)]!;
    const [lo, hi] = CLAMP[k];
    // thrift is a 0-based personality share - a multiplicative nudge
    // can never leave 0. Additive for it, multiplicative elsewhere.
    m[k] = k === 'thrift' || k === 'airLove'
      ? Math.min(hi, Math.max(lo, m[k] + (rng() - 0.4) * 0.3))
      : Math.min(hi, Math.max(lo, m[k] * (1 + (rng() - 0.5) * 0.2)));
  }
  return m;
};

interface Metrics { asw: Record<'ha' | 'a' | 's' | 'w' | 'st' | 'i', number>; kills: number; deaths: number; eSum: number; eN: number; dry: number; prevE: Map<string, number>; mechSum: number; mechN: number }
const mkMetrics = (): Metrics => ({ asw: { ha: 0, a: 0, s: 0, w: 0, st: 0, i: 0 }, kills: 0, deaths: 0, eSum: 0, eN: 0, dry: 0, prevE: new Map(), mechSum: 0, mechN: 0 });
const bucket = (alt: number, speed: number, skiing: boolean, onGround: boolean): keyof Metrics['asw'] => {
  // onGround is the authority — sim pos rides ~1.5m above the surface
  // (eye/body offset), so a raw altitude check buckets standing bots
  // as airborne. Air splits ha/a on altitude; ground splits i/st/s/w.
  if (!onGround) {return alt > 5 ? 'ha' : 'a';}
  if (speed < 1) {return 'i';}
  if (speed < 5) {return 'st';}
  return skiing ? 's' : 'w';
};

/** Apply a genome continuously: mods rows carry react/jitter/temper,
 *  axes+movement carry aim/move. heroTick lerps FROM base* each think,
 *  so both base and live fields must be written or hero mode reverts
 *  the genome on the first pressure tick. */
function applyGenome(s: BotSkill, g: Genome): void {
  s.baseMods = { aim: g.aim, move: g.move, react: g.react, jitter: g.jitter, temper: g.temper };
  Object.assign(s.mods, s.baseMods); // mods is readonly — mutate contents
  for (const ax of ['snap', 'track', 'arcLead', 'arcJudge'] as const) {
    s.baseAxes[ax].moving *= g.aim; s.baseAxes[ax].still *= g.aim;
    s.axes[ax].moving *= g.aim; s.axes[ax].still *= g.aim;
  }
  s.baseMove *= g.move; s.movement *= g.move;
  s.thrift = g.thrift; // personality draws — overwrite the roll outright
  s.airLove = g.airLove;
}

function runEra(pop: Genome[], genSeed: number): Metrics[] {
  let field;
  if (MAP) {
    const buf = readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.bin`));
    const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8')) as { heightScale?: number };
    field = hmScaled(hmParseBin(buf, spec.heightScale ?? 1), spec.heightScale ?? 1);
  }
  const room = mkRoom({ mode: MODE, bots: BOTS, botSkill: 'medium', arena: { x: 0, z: 0, radius: ARENA } }, MODE, genSeed, false, field);
  const ctl = room.bots as unknown as {
    brains: Map<string, { skill: BotSkill }>;
    loadouts: Map<string, BotLoadout>;
    roster: { refitClass(id: string): void };
  };
  const genomeOf = new Map<string, number>();
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  if (PURE) {
    const wt = (WeaponType as unknown as Record<string, number>)[PURE];
    if (wt === undefined) {throw new Error(`--pure: no weapon named '${PURE}'`);}
    for (const p of bots) {
      ctl.loadouts.set(p.id, { perk: 'none', near: wt, mid: wt, far: wt, belt: wt, side: wt });
      ctl.roster.refitClass(p.id);
    }
  }
  bots.forEach((p, i) => {
    const gi = i % pop.length;
    genomeOf.set(p.id, gi);
    applyGenome(ctl.brains.get(p.id)!.skill, pop[gi]!);
  });

  const M: Metrics[] = pop.map(mkMetrics);
  room.events.on((e): void => {
    if (e.type === 'kill') {
      const g = genomeOf.get(e.shooterId); if (g !== undefined) {M[g]!.kills += 1;}
      const d = genomeOf.get(e.targetId); if (d !== undefined) {M[d]!.deaths += 1;}
    }
  });

  // Chunked stepping: one sample per sim-second per bot — asw bucket
  // (same rule as client aswBucket) plus energy fill/dry-outs.
  const ticks = Math.round(MINS * 60 / 0.05);
  const chunk = 20; // 1 sim-second
  for (let done = 0; done < ticks; done += chunk) {
    step(room, Math.min(chunk, ticks - done));
    for (const p of bots) {
      const gi = genomeOf.get(p.id); if (gi === undefined) {continue;}
      const sim = room.moveSim.simOf(p.id);
      const ec = room.moveSim.econOf(p.id);
      const m = M[gi]!;
      if (sim) {
        const st = sim.state;
        const pos = st.pos!;
        const vel = st.vel!;
        const ground = field ? hmHeight(field, pos.x, pos.z) : 60;
        const speed = Math.hypot(vel.x, vel.z);
        const alt = pos.y - ground;
        m.asw[bucket(alt, speed, sim.input.skiHeld, st.onGround)] += 1;
        // Total mechanical energy per unit mass: ½v² + g·h. Altitude
        // is stored kinetic energy — conserving E IS the altitude ask.
        m.mechSum += 0.5 * (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) + -GRAVITY * Math.max(0, alt);
        m.mechN += 1;
      }
      if (ec) {
        const cap = ENERGY.max * ec.energyMax;
        m.eSum += cap > 0 ? ec.energy / cap : 0; m.eN += 1;
        const prev = m.prevE.get(p.id);
        if (prev !== undefined && prev > 0 && ec.energy <= 0) {m.dry += 1;}
        m.prevE.set(p.id, ec.energy);
      }
    }
  }
  room.dispose();
  return M;
}

// Seed pool: the medium baseline plus spread mutants so gen-0 already
// shows direction — a uniform pool takes 2 gens just to differentiate.
const pool: Genome[] = INJECT ? [parseGenome(INJECT), BASE] : [BASE];
while (pool.length < POP) {pool.push(mutate(BASE));}

console.log(`evoSkill: pop=${POP} gens=${GENS} bots=${BOTS} mins=${MINS} seed=${SEED}`);
console.log('gen | genome aim/move/react/jitter/temper | air% (ha+a split) s% w% st% i% | kills deaths eFill dry | fit');
for (let gen = 0; gen < GENS; gen++) {
  const M = runEra(pool, SEED * 1_000_003 + gen * 977);
  const rows = pool.map((g, i) => {
    const m = M[i]!;
    const n = m.asw.ha + m.asw.a + m.asw.s + m.asw.w + m.asw.st + m.asw.i || 1;
    const air = (m.asw.ha + m.asw.a) / n;
    const eFill = m.eN > 0 ? m.eSum / m.eN : 0;
    const mech = m.mechN > 0 ? m.mechSum / m.mechN : 0;
    // mech is ~[0..2000+] J/kg - scale to ~[0..1] against a generous
    // sustained target (60 m/s cruise ≈ 1800) so it mixes with shares.
    // survive: survivability doctrine - high air is the means, not
    // dying is the goal. Score = ha share + not-dying share (lives
    // intact across the era). Both [0..1]-ish, same weight.
    const survive = (m.asw.ha / n) + Math.max(0, 1 - m.deaths / (n / 60));
    const fit = (FIT === 'ha' ? m.asw.ha / n : FIT === 'mech' ? Math.min(1, mech / 1800) : FIT === 'survive' ? survive : air) + WE * eFill;
    return { g, m, n, air, eFill, mech, fit };
  }).sort((a, b) => b.fit - a.fit);
  for (const r of rows) {
    const pct = (v: number): string => `${(v / r.n * 100).toFixed(0).padStart(2)}`;
    console.log(
      `${gen}   | aim ${r.g.aim.toFixed(2)} move ${r.g.move.toFixed(2)} react ${r.g.react.toFixed(2)} jit ${r.g.jitter.toFixed(2)} temp ${r.g.temper.toFixed(2)} thr ${r.g.thrift.toFixed(2)} air ${r.g.airLove.toFixed(2)}` +
      ` | ${(r.air * 100).toFixed(1).padStart(5)}% (${pct(r.m.asw.ha)}+${pct(r.m.asw.a)}) s${pct(r.m.asw.s)} w${pct(r.m.asw.w)} st${pct(r.m.asw.st)} i${pct(r.m.asw.i)}` +
      ` | ${String(r.m.kills).padStart(3)} ${String(r.m.deaths).padStart(3)} ${(r.eFill * 100).toFixed(1).padStart(5)}% ${String(r.m.dry).padStart(3)} E${r.mech.toFixed(0).padStart(4)} | ${r.fit.toFixed(3)}`,
    );
  }
  appendFileSync(OUT, `${JSON.stringify({ gen, rows: rows.map((r): object => ({ g: r.g, asw: r.m.asw, kills: r.m.kills, deaths: r.m.deaths, eFill: r.eFill, dry: r.m.dry, mech: r.mech, fit: r.fit })) })}\n`);
  // Top half survives; losers are mutants of random survivors.
  const keep = Math.max(1, Math.floor(rows.length / 2));
  const survivors = rows.slice(0, keep).map((r): Genome => r.g);
  pool.length = 0;
  pool.push(...survivors);
  while (pool.length < POP) {pool.push(mutate(survivors[Math.floor(rng() * survivors.length)]!));}
}
console.log(`results → ${OUT}`);
