/**
 * hhEvo.ts — headhunt team-vs-team evolution pit. Each genome is a whole
 * team's build: per-axis skill mix (aim/move/react/jitter/temper tiers)
 * plus its kit (near/mid/far/belt/perk). Pairings play `matches`
 * headhunt games with sides SWAPPED (spawn asymmetry is real); fitness
 * is held-token score margin — the mode's own objective, not K/D.
 *
 * Population is a hall-of-fame pool, not a pair: each generation is a
 * round-robin, the top half lives, losers re-roll as mutants of a random
 * survivor. A champion only earns the crown by beating DIVERSE builds —
 * A-beats-B-beats-A rock-paper-scissors can't fake its way to the top.
 *
 *   bun _tools/sweeps/hhEvo.ts                        # seed pool, 3 gens
 *   bun _tools/sweeps/hhEvo.ts --gens 8 --pop 8 --mins 6 --jobs out
 *   bun _tools/sweeps/hhEvo.ts --genomes mypool.json  # custom seed pool
 *
 * Results append JSONL to _tools/sweeps/out/hhevo.jsonl — reruns resume
 * the pool from the file's last `pool` line when it exists.
 */
// Harnesses step() in a tight loop — the MPC worker never pumps, so
// every solve pays ~100-300ms synchronously inside the tick. Off by
// default here; set FPS_MPC_OFF=0 to measure planner-on outcomes.
process.env.FPS_MPC_OFF ??= '1';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { kitConsistent, WILDCARD_SLOTS, type BotLoadout } from '../../shared/botLoadouts.ts';
import type { BotTier, BotSkillMix, BotSkill } from '../../shared/botSkill.ts';
import { rollSkill } from '../../shared/botSkill.ts';
import { PERK_ORDER, type PerkId } from '../../shared/perks.ts';
import { mkRoom, step, pin } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow, simNowAdvance, simNowReset } from '../../server_bun/src/simClock.ts';

const arg = (name: string, dflt: string | number): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : String(dflt);
};

const POP = Number(arg('pop', 6));
const GENS = Number(arg('gens', 3));
const MINS = Number(arg('mins', 4));
const PER = Number(arg('per', 6));
const MATCHES = Number(arg('matches', 2)); // per pairing — sides alternate
const SEED = Number(arg('seed', 1));
const WALL_S = Number(arg('wall', 1800));
const ARENA = Number(arg('arena', 300));
const OUT_DIR = resolve(import.meta.dir, 'out');
mkdirSync(OUT_DIR, { recursive: true });
const OUT = resolve(OUT_DIR, arg('out', 'hhevo.jsonl'));
// --workers N: shard each generation's matches across N `bun hhEvo
// --eval` child processes. Pairings are independent deterministic
// matches (per-pairing seeds), so results are identical at any N.
const WORKERS = Math.max(1, Number(arg('workers', 1)));
// --race θ: within a pairing (contiguous task group), once |margin|
// exceeds θ the rest are skipped — successive-halving at match
// granularity. 0 = off. Validate θ against pair-replay history:
// headhunt margins can swing ~±50 on a late hoard scatter.
const RACE = Number(arg('race', 0));
// --tie θ / --tiebreak N: the budget inverse of racing. A pairing whose
// worst-map margin lands inside ±θ is a coin flip at this sample size —
// spend N extra matches PER MAP on it. Budget flows from blowouts to
// contested pairings, which is where the fitness information lives.
const TIE = Number(arg('tie', MINS * 3)); // ~3-token/min swing scale
const TIEBREAK = Number(arg('tiebreak', 1));

// ---- gene space -----------------------------------------------------------
const TIERS: BotTier[] = ['easy', 'medium', 'hard', 'impossible'];
// Slot pools = the codebase's own wildcard table (measured band
// assignments) + the full PERK_ORDER — new weapons/perks join the evo
// automatically instead of drifting stale. 'vitality' was a silent
// no-op gene (not a PerkId — resolved to none); full perk list now.
const PERKS = PERK_ORDER;
const NEAR = WILDCARD_SLOTS.near;
const MID = WILDCARD_SLOTS.mid;
const FAR = WILDCARD_SLOTS.far;
const BELT = WILDCARD_SLOTS.belt;
const SIDE = WILDCARD_SLOTS.side;
const W = WeaponType;

/** Flat index genome — every gene is an index into its DIMS table. */
type GDims = Record<string, readonly unknown[]>;
const DIMS: GDims = {
  aim: TIERS, move: TIERS, react: TIERS, jitter: TIERS, temper: TIERS,
  near: NEAR, mid: MID, far: FAR, belt: BELT, side: SIDE, perk: PERKS,
};
type Genome = Record<string, number>;
const GENE_KEYS = Object.keys(DIMS);

const skillMix = (g: Genome): BotSkillMix => ({
  aim: TIERS[g.aim!], move: TIERS[g.move!], react: TIERS[g.react!],
  jitter: TIERS[g.jitter!], temper: TIERS[g.temper!],
});
const kitOf = (g: Genome): BotLoadout => ({
  perk: PERKS[g.perk!] ?? 'none',
  near: NEAR[g.near!]!, mid: MID[g.mid!]!, far: FAR[g.far!]!,
  belt: BELT[g.belt!]!, side: SIDE[g.side!]!,
});
/** kitConsistent rejects class-locked mixes — mutants that roll one
 *  re-roll, not crash. */
const legal = (g: Genome): boolean => kitConsistent(kitOf(g));
const gname = (g: Genome): string =>
  `${TIERS[g.aim!][0]}${TIERS[g.move!][0]}${TIERS[g.react!][0]}${TIERS[g.jitter!][0]}${TIERS[g.temper!][0]}:` +
  `${WeaponType[NEAR[g.near!]!]}+${WeaponType[MID[g.mid!]!]}+${WeaponType[FAR[g.far!]!]}+${WeaponType[BELT[g.belt!]!]}+${WeaponType[SIDE[g.side!]!]}/${PERKS[g.perk!]}`;

const idx = (list: readonly unknown[], v: unknown): number => Math.max(0, list.indexOf(v));

/** Parse a gname back into a Genome — lets --pairs replay any board row
 *  verbatim ("immhh:Shotgun+Disc+Mortar+Grenade/regenerator"). */
const parseGname = (s: string): Genome | null => {
  const [axes, kit] = s.split(':');
  if (!axes || !kit || axes.length !== 5) {return null;}
  const tierOf = (c: string): number => ({ e: 0, m: 1, h: 2, i: 3 } as Record<string, number>)[c] ?? -1;
  const t = [...axes].map(tierOf);
  if (t.some((x) => x < 0)) {return null;}
  const [ws, perk] = kit.split('/');
  const wn = ws!.split('+');
  if ((wn.length !== 4 && wn.length !== 5) || !perk) {return null;} // 4 = pre-side-gene gnames
  const slotOf = (list: readonly WeaponType[], name: string): number =>
    list.findIndex((w) => WeaponType[w] === name);
  const g: Genome = { aim: t[0], move: t[1], react: t[2], jitter: t[3], temper: t[4],
    near: slotOf(NEAR, wn[0]!), mid: slotOf(MID, wn[1]!), far: slotOf(FAR, wn[2]!),
    belt: slotOf(BELT, wn[3]!), side: wn[4] ? slotOf(SIDE, wn[4]) : 0, perk: idx(PERKS, perk) };
  return legal(g) ? g : null;
};

// ---- seed pool: hand-authored diversity, not random mush -------------------
const seedGenome = (over: Partial<Record<keyof typeof DIMS, unknown>>): Genome => {
  const base = { aim: 'medium', move: 'medium', react: 'medium', jitter: 'medium', temper: 'medium',
    near: W.Shotgun, mid: W.Chaingun, far: W.Mortar, belt: W.Grenade, side: W.Pistol, perk: 'none', ...over } as Record<string, unknown>;
  const g: Genome = {};
  for (const k of GENE_KEYS) {g[k] = idx(DIMS[k]!, base[k]);}
  return g;
};
const SEED_POOL: Genome[] = [
  seedGenome({}),                                                            // balanced medium
  seedGenome({ aim: 'impossible', jitter: 'impossible', temper: 'hard' }),   // aimbot squad
  seedGenome({ move: 'impossible', aim: 'easy', jitter: 'easy' }),           // stormtrooper skiers
  seedGenome({ aim: 'hard', move: 'easy', far: W.Railgun, mid: W.Disc }),    // sniper stand
  seedGenome({ react: 'impossible', temper: 'impossible', near: W.Flak }),   // twitch swarm
  seedGenome({ move: 'hard', perk: 'overcharge', belt: W.Javelin }),         // ski-raid crew
  seedGenome({ aim: 'hard', far: W.Mortar, mid: W.GrenadeLauncher, perk: 'plated' }), // artillery
  seedGenome({ move: 'impossible', react: 'hard', near: W.Shotgun, perk: 'featherjets' }), // knife fight
];

// ---- rng ------------------------------------------------------------------
let rngs = SEED >>> 0 || 1;
const rand = (): number => ((rngs = (rngs * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T>(l: readonly T[]): T => l[Math.floor(rand() * l.length)]!;

const mutate = (g: Genome): Genome => {
  for (let tries = 0; tries < 20; tries += 1) {
    const m = { ...g };
    // 1-2 gene hits; ±1 tier nudges for skill axes, resample for kit slots.
    const hits = 1 + (rand() < 0.5 ? 1 : 0);
    for (let i = 0; i < hits; i += 1) {
      const k = pick(GENE_KEYS);
      const n = DIMS[k]!.length;
      m[k] = k in { aim: 1, move: 1, react: 1, jitter: 1, temper: 1 }
        ? Math.max(0, Math.min(n - 1, m[k]! + (rand() < 0.5 ? -1 : 1)))
        : Math.floor(rand() * n);
    }
    if (legal(m)) {return m;}
  }
  return g;
};

// ---- the match -------------------------------------------------------------
interface MapCtx { name: string; field: Heightfield; specTerrain: Record<string, unknown>; atY(x: number, z: number): number }
const mapCtx = (name: string): MapCtx => {
  if (!name || name === 'flat') {
    const field: Heightfield = { size: 4, data: new Uint8Array(16).fill(60), stride: 1 };
    return { name: 'flat', field, specTerrain: {}, atY: (x, z) => hmHeight(field, x, z) + 2 };
  }
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8')) as { terrain?: string };
  const field = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain ?? name + '.bin'}`))));
  return { name, field, specTerrain: spec as Record<string, unknown>, atY: (x, z) => hmHeight(field, x, z) + 2 };
};
// --maps flat,katabatic: every pairing runs MATCHES games PER MAP and its
// fitness margin is the WORST map — a genome that only works on one
// arena can't fake general strength (map-matrix admission).
// --maps a,b,c | 'all' — expands to every maps/*.json. --mapsel random
// draws one map per match (seeded, parent-side so sharding can't reorder
// the stream); default 'matrix' runs every pairing on every map.
const MAPSEL = arg('mapsel', 'matrix');
let mapNames = arg('maps', arg('map', 'flat')).split(',');
if (mapNames.length === 1 && mapNames[0] === 'all') {
  mapNames = readdirSync(resolve(import.meta.dir, '../../maps'))
    .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    .filter((name) => {
      const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8')) as { terrain?: string };
      const bin = spec.terrain ?? `${name}.bin`;
      return !bin.startsWith('t2') && existsSync(resolve(import.meta.dir, `../../maps/${bin}`));
    }).sort();
  console.log(`maps=all → ${mapNames.length} playable: ${mapNames.join(' ')}\n`);
}
const MAPS = mapNames.map(mapCtx);
// --mode: dm/ctf/headhunt/nuggets/conquest — fitness is always
// room.scores margin so the mode's own objective stays the target.
// Duel = --mode dm --per 1.
const MODE = arg('mode', 'headhunt');
// --mode chaos: each match draws a random mode (seeded, parent-side like
// mapsel=random). Fitness is each mode's own score — a chaos pool is
// selected for cross-mode generality.
const MODES = MODE === 'chaos' ? ['headhunt', 'dm', 'ctf', 'conquest', 'nuggets', 'rabbit'] : [MODE];

/** Behavior descriptors — the QD axes. agg=kills/min, mob=mean planar
 *  speed, air=airborne fraction, life=median lifespan, heldEnd=final
 *  pocket. Selection doesn't use them yet; they're the grid the
 *  MAP-Elites pass will key on. */
interface Desc { agg: number; mob: number; air: number; life: number; heldEnd: number; hype: number }
interface MatchResult { aScore: number; bScore: number; aK: number; aD: number; bK: number; bD: number; tokens: number; simS: number; aDesc: Desc; bDesc: Desc; aGrabs: number; bGrabs: number }

/** One headhunt game: ga plays alpha, gb plays bravo. Score = held tokens. */
function runMatch(ga: Genome, gb: Genome, seed: number, ctx: MapCtx = MAPS[0]!, mode: string = MODE): MatchResult {
  // Fresh sim clock per match — respawn/protection timers read simNow
  // absolutely, so without this a match's outcome depends on how much
  // sim-time ran before it (serial order ≠ shard order ≠ --pairs replay).
  simNowReset(0);
  const PROF = !!process.env.FPS_HHPROF;
  const prof = { setup: 0, step: 0, respawn: 0, pLoop: 0, score: 0 };
  const profT = PROF ? performance.now() : 0;
  const room = mkRoom({
    ...ctx.specTerrain,
    mode,
    bots: PER * 2,
    botFill: PER * 2,
    botSkill: { alpha: skillMix(ga), bravo: skillMix(gb) },
    arena: { x: 0, z: 0, radius: ARENA },
  }, mode, seed, false, ctx.field);
  room.spec.botFill = 0;
  (room as { endMatch: (w: string) => void }).endMatch = () => {};

  const ctl = room.bots as unknown as {
    loadouts: Map<string, BotLoadout>;
    brains: Map<string, { skill: BotSkill }>;
    roster: { alts: Map<string, Partial<Record<string, WeaponType[]>>>; refitClass(id: string): void };
  };
  const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
  // FFA modes (rabbit/duel/flagrun/dm): bots are teamless, so sides are
  // a harness fiction — index split — and botSkill.{alpha,bravo} never
  // reaches tierFor(p.team). Kits are per-bot anyway; the skill matrix
  // gets re-rolled per genome directly on the brain.
  const ffa = !!room.modeSpec?.ffa;
  const sides: Record<'alpha' | 'bravo', { id: string }[]> = { alpha: [], bravo: [] };
  for (const [bi, p] of bots.entries()) {
    const team = ffa ? (bi < bots.length / 2 ? 'alpha' : 'bravo') : (p.team === 'bravo' ? 'bravo' : 'alpha');
    if (ffa) {Object.assign(ctl.brains.get(p.id)!.skill, rollSkill(p.position, skillMix(team === 'alpha' ? ga : gb)));}
    const kit = kitOf(team === 'alpha' ? ga : gb);
    ctl.loadouts.set(p.id, kit);
    ctl.roster.refitClass(p.id);
    ctl.loadouts.set(p.id, kit); // refitClass rewrites far on heavies — put it back
    ctl.roster.alts.set(p.id, {});
    p.perk = kit.perk;
    sides[team].push({ id: p.id });
  }

  // wide seating — each (re)spawn lands 60-200m from the enemy centroid,
  // the contact pressure teamSoak proved out; deterministic stream.
  let ss = (seed * 2654435761) >>> 0 || 1;
  const seatRand = (): number => ((ss = (ss * 1664525 + 1013904223) >>> 0) / 4294967296);
  const seat = (team: 'alpha' | 'bravo', i: number): void => {
    const foes = sides[team === 'alpha' ? 'bravo' : 'alpha'];
    let cx = 0, cz = 0, n = 0;
    for (const f of foes) {
      const p = room.players.getPlayer(f.id);
      if (p && !p.isDead) {cx += p.position.x; cz += p.position.z; n += 1;}
    }
    if (n) {cx /= n; cz /= n;}
    const a = seatRand() * Math.PI * 2;
    const d = 60 + seatRand() * 140;
    pin(room, sides[team][i]!.id, { x: cx + Math.cos(a) * d, y: ctx.atY(cx + Math.cos(a) * d, cz + Math.sin(a) * d), z: cz + Math.sin(a) * d });
  };
  for (let i = 0; i < sides.alpha.length; i += 1) {seat('alpha', i);}
  for (let i = 0; i < sides.bravo.length; i += 1) {seat('bravo', i);}

  const dt = 0.05;
  const BATCH = 20;
  const maxTicks = Math.floor((MINS * 60) / dt);
  const wasDead = new Set<string>();
  const sideOf = new Map<string, { team: 'alpha' | 'bravo'; i: number }>();
  for (const team of ['alpha', 'bravo'] as const) {sides[team].forEach((b, i) => sideOf.set(b.id, { team, i }));}
  // Behavior descriptor accumulators per side.
  const spd = { alpha: 0, bravo: 0, n: 0 };
  const air = { alpha: 0, bravo: 0, n: 0 };
  const lifeStart = new Map<string, number>();
  const lives: Record<'alpha' | 'bravo', number[]> = { alpha: [], bravo: [] };
  const lastHeld = new Map<string, number>();
  const grabs = { alpha: 0, bravo: 0 };
  let ticks = 0;
  const traj: number[] = [];
  // Roster is fixed post-setup — one array, not a Map-values copy per
  // batch (was ~6% of a match in wall reads + allocation churn).
  const allP = [...room.players.getAllPlayers().values()];
  let tp = PROF ? performance.now() : 0;
  for (; ticks < maxTicks; ticks += BATCH) {
    simNowAdvance(dt * 1000 * BATCH);
    step(room, BATCH, dt);
    if (PROF) {const n = performance.now(); prof.step += n - tp; tp = n;}
    room.messages.respawnTick(simNow());
    if (PROF) {const n = performance.now(); prof.respawn += n - tp; tp = n;}
    for (const p of allP) {
      const t = sideOf.get(p.id)?.team ?? 'alpha'; // FFA bots are teamless
      if (p.isDead) {
        wasDead.add(p.id);
        const born = lifeStart.get(p.id);
        if (born !== undefined) {lives[t].push((simNow() - born) / 1000); lifeStart.delete(p.id);}
      } else {
        if (wasDead.delete(p.id)) {
          const s = sideOf.get(p.id);
          if (s) {seat(s.team, s.i);}
          lifeStart.set(p.id, simNow());
        } else if (!lifeStart.has(p.id)) {lifeStart.set(p.id, simNow());}
        spd[t] += Math.hypot(p.velocity.x, p.velocity.z);
        air[t] += p.position.y > ctx.atY(p.position.x, p.position.z) + 3 ? 1 : 0;
      }
      // Token economy ledger: heldTokens only rises via pickup — the
      // positive delta is a grab (drops are losses, scored as -deltas).
      const dh = (p.heldTokens ?? 0) - (lastHeld.get(p.id) ?? 0);
      if (dh > 0) {grabs[t] += dh;}
      lastHeld.set(p.id, p.heldTokens ?? 0);
    }
    spd.n++; air.n++;
    // Score-trajectory sample for the hype descriptor — reads the same
    // ledgers the post-match scoring does (scores / ffaScores by mode).
    if (ticks % (BATCH * 4) === 0) {
      const fs = (room.scoring as { ffaScores?: Map<string, number> }).ffaScores;
      const sOf = (t: 'alpha' | 'bravo'): number => ffa
        ? sides[t].reduce((n, b) => n + (fs?.get(b.id) ?? 0), 0)
        : (t === 'alpha' ? room.scores.alpha : room.scores.bravo);
      traj.push(sOf('alpha') - sOf('bravo'));
    }
    if (PROF) {const n = performance.now(); prof.pLoop += n - tp; tp = n;}
  }
  if (PROF) {prof.setup = tp - profT - prof.step - prof.respawn - prof.pLoop; prof.score = performance.now() - tp;
    console.log(`   prof ms: setup=${prof.setup.toFixed(0)} step=${prof.step.toFixed(0)} respawn=${prof.respawn.toFixed(0)} pLoop=${prof.pLoop.toFixed(0)} score=${prof.score.toFixed(0)} sim=${(ticks * dt).toFixed(0)}s`);}
  const players = room.scoring.matchPlayers();
  const team = (t: 'alpha' | 'bravo') => {
    const rows = players.filter((p) => (sideOf.get(p.id)?.team ?? p.team ?? 'alpha') === t);
    return { k: rows.reduce((n, r) => n + r.kills, 0), d: rows.reduce((n, r) => n + r.deaths, 0) };
  };
  const ta = team('alpha'), tb = team('bravo');
  const medLife = (xs: number[]): number => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]! : 0);
  const heldOf = (t: 'alpha' | 'bravo'): number =>
    allP.filter((p) => (sideOf.get(p.id)?.team ?? 'alpha') === t).reduce((n, p) => n + (p.heldTokens ?? 0), 0);
  const simMin = (ticks * dt) / 60;
  // Hype: lead changes + comeback depth. A match that ends close after
  // swinging wide is watchable; a wire-to-wire blowout isn't. Symmetric —
  // both sides share the match's trajectory.
  const sgn = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
  let leadChanges = 0, peak = 0;
  for (let i = 1; i < traj.length; i += 1) {
    if (sgn(traj[i]!) !== 0 && sgn(traj[i]!) !== sgn(traj[i - 1]!)) {leadChanges += 1;}
    peak = Math.max(peak, Math.abs(traj[i]!));
  }
  const end = Math.abs(traj[traj.length - 1] ?? 0);
  const hype = leadChanges + (peak > 0 ? (peak - Math.min(peak, end)) / peak : 0);
  const descOf = (t: 'alpha' | 'bravo', k: number): Desc => ({
    agg: k / Math.max(0.1, simMin),
    mob: spd[t] / Math.max(1, spd.n * PER),
    air: air[t] / Math.max(1, air.n * PER),
    life: medLife(lives[t]),
    heldEnd: heldOf(t),
    hype,
  });
  // FFA modes (dm/duel/rabbit/flagrun) bank per-player pts in ffaScores
  // — kills AND rabbit hold-seconds land there; sum by our assigned
  // sides. Team modes keep room.scores.
  const ffaScore = (t: 'alpha' | 'bravo'): number => {
    const fs = (room.scoring as { ffaScores?: Map<string, number> }).ffaScores;
    let s = 0;
    for (const b of sides[t]) {s += fs?.get(b.id) ?? 0;}
    return s;
  };
  const r: MatchResult = {
    aScore: ffa ? ffaScore('alpha') : room.scores.alpha ?? 0,
    bScore: ffa ? ffaScore('bravo') : room.scores.bravo ?? 0,
    aK: ta.k, aD: ta.d, bK: tb.k, bD: tb.d,
    tokens: heldOf('alpha') + heldOf('bravo'), simS: ticks * dt,
    aGrabs: grabs.alpha, bGrabs: grabs.bravo,
    aDesc: descOf('alpha', ta.k), bDesc: descOf('bravo', tb.k),
  };
  room.dispose();
  return r;
}

// ---- match dispatch: serial, or sharded across --eval worker processes ------
interface PairTask { id: number; grp: number; ga: Genome; gb: Genome; flip: boolean; seed: number; map: string; mode?: string;
  meta?: Record<string, unknown> }
interface PairResult { id: number; aScore: number; bScore: number; aK: number; aD: number; bK: number; bD: number; aDesc: Desc; bDesc: Desc; raced: boolean }

const ctxByName = new Map(MAPS.map((c) => [c.name, c]));
const ctxFor = (name: string): MapCtx => {
  let c = ctxByName.get(name);
  if (!c) {c = mapCtx(name); ctxByName.set(name, c);} // workers don't inherit --maps
  return c;
};

/** One task file line → one match. Returns per-id results (raced tasks absent). */
const evalTasks = (tasks: PairTask[]): Map<number, MatchResult> => {
  const out = new Map<number, MatchResult>();
  let grp = -1, acc = 0, stopped = false;
  for (const t of tasks) {
    if (t.grp !== grp) {grp = t.grp; acc = 0; stopped = false;}
    if (stopped) {continue;}
    const r = runMatch(t.ga, t.gb, t.seed, ctxFor(t.map), t.mode);
    out.set(t.id, r);
    acc += t.flip ? r.bScore - r.aScore : r.aScore - r.bScore;
    if (RACE > 0 && Math.abs(acc) > RACE) {stopped = true;}
  }
  return out;
};

// --eval FILE: worker mode — read a JSONL task list, write results JSONL.
const EVAL_FILE = arg('eval', '');
if (EVAL_FILE) {
  const RES = arg('results', EVAL_FILE + '.res');
  const tasks = (readFileSync(EVAL_FILE, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { id: number; grp: number; ga: string; gb: string; flip: boolean; seed: number; map: string })
    .map((t) => ({ ...t, ga: parseGname(t.ga)!, gb: parseGname(t.gb)! })) as PairTask[]);
  const res = evalTasks(tasks);
  writeFileSync(RES, [...res].map(([id, r]) => JSON.stringify({ id, r })).join('\n') + '\n');
  process.exit(0);
}

/** Dispatch tasks: in-process at WORKERS=1, else shard contiguous
 *  groups across N bun children (pairings never split mid-way, so
 *  --race sees the whole margin trajectory). Identical results at
 *  any worker count — seeds are per-task. */
const runTasks = async (tasks: PairTask[]): Promise<Map<number, MatchResult>> => {
  if (WORKERS <= 1 || tasks.length < WORKERS * 2) {return evalTasks(tasks);}
  // split at group boundaries so every pairing stays whole
  const bounds: number[] = [0];
  for (let k = 1; k < tasks.length; k += 1) {if (tasks[k]!.grp !== tasks[k - 1]!.grp) {bounds.push(k);}}
  bounds.push(tasks.length);
  const groups = bounds.length - 1;
  const per = Math.ceil(groups / WORKERS);
  const stamp = `${process.pid}.${Date.now()}`;
  const procs: Promise<number>[] = [];
  const resFiles: string[] = [];
  for (let w = 0; w * per < groups; w += 1) {
    const slice = tasks.slice(bounds[w * per]!, bounds[Math.min(groups, w * per + per)]!);
    const tf = resolve(OUT_DIR, `.tasks.${stamp}.${w}.jsonl`);
    writeFileSync(tf, slice.map((t) => JSON.stringify({ ...t, ga: gname(t.ga), gb: gname(t.gb) })).join('\n') + '\n');
    const rf = `${tf}.res`;
    resFiles.push(rf);
    procs.push(Bun.spawn([process.execPath, import.meta.filename!, '--eval', tf, '--results', rf, '--race', String(RACE),
      '--mins', String(MINS), '--per', String(PER), '--arena', String(ARENA), '--mode', MODE],
      { stdout: 'ignore', stderr: 'inherit', cwd: process.cwd() }).exited);
  }
  await Promise.all(procs);
  for (let w = 0; w * per < groups; w += 1) {rmSync(resolve(OUT_DIR, `.tasks.${stamp}.${w}.jsonl`));}
  const out = new Map<number, MatchResult>();
  for (const rf of resFiles) {
    if (!existsSync(rf)) {continue;}
    for (const l of readFileSync(rf, 'utf8').trim().split('\n')) {
      const o = JSON.parse(l) as { id: number; r: MatchResult };
      out.set(o.id, o.r);
    }
    rmSync(rf);
  }
  return out;
};

// ---- the tournament ---------------------------------------------------------
interface Row { g: Genome; name: string; w: number; l: number; margin: number; kd: number; games: number;
  /** Worst single-pairing margin — approximate exploitability: how badly
   *  SOMEONE'S counter-build hurt this genome. Dominant genomes have
   *  shallow worsts; paper-scissors-rock picks have deep ones. */
  worst: number;
  desc: Desc[] }

/** Fictitious play over the accumulated payoff matrix → the meta-Nash
 *  mixture. answers "is the champion dominant or is the meta a blend"
 *  in one weight vector. ~30 lines, no deps. */
function nashMix(payoff: number[][], iters = 500): number[] {
  const n = payoff.length;
  const rowCount = payoff.map(() => 1); // uniform prior
  const colCount = payoff.map(() => 1);
  for (let t = 0; t < iters; t += 1) {
    const colMix = colCount.map((c) => c / colCount.reduce((a, b) => a + b));
    const colMixT = rowCount.map((c) => c / rowCount.reduce((a, b) => a + b));
    // row best-response: maximize Σ_j M[i][j]·colMix[j]
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const v = payoff[i]!.reduce((s, m, j) => s + m * colMix[j]!, 0);
      if (v > bv) {bv = v; bi = i;}
    }
    // col best-response: minimize Σ_i M[i][j]·rowMix[i]  (zero-sum)
    let bj = 0, bw = Infinity;
    for (let j = 0; j < n; j += 1) {
      const v = payoff.reduce((s, row, i) => s + row[j]! * colMixT[i]!, 0);
      if (v < bw) {bw = v; bj = j;}
    }
    rowCount[bi]! += 1; colCount[bj]! += 1;
  }
  const tot = rowCount.reduce((a, b) => a + b);
  return rowCount.map((c) => c / tot);
}

console.log(`hhEvo: ${MODE} evolution — pop=${POP} gens=${GENS} ${MINS}min×${MATCHES} per pairing, ${PER}v${PER} arena r=${ARENA} maps=${MAPS.map((m) => m.name).join('+')} seed=${SEED}\n`);

let pool: Genome[] = SEED_POOL.filter((g) => {
  if (!legal(g)) {console.log(`  dropping illegal seed kit ${gname(g)}`); return false;}
  return true;
}).slice(0, POP);
const poolFile = arg('genomes', '');
if (poolFile) {pool = (JSON.parse(readFileSync(poolFile, 'utf8')) as Genome[]).filter(legal).slice(0, POP);}

// ---- --pairs mode: replay named genomes, no evolution ----------------------
// 'A;B;C;D' = pair A-vs-B and C-vs-D, side-swapped per match. The
// experiment lane — tier ladders, forced-weapon matrices, champion checks.
const PAIRS = arg('pairs', '');
if (PAIRS) {
  for (const spec of PAIRS.split(';')) {
    const [na, nb] = spec.split(',');
    const ga = parseGname(na!), gb = parseGname(nb!);
    if (!ga || !gb) {console.log(`skip ${spec} — unparseable or illegal`); continue;}
    let mA = 0, winsA = 0;
    const dA: Desc[] = [], dB: Desc[] = [];
    for (let m = 0; m < MATCHES; m += 1) {
      const r = runMatch(m % 2 ? gb : ga, m % 2 ? ga : gb, SEED * 977 + m, MAPS[m % MAPS.length]!);
      mA += m % 2 ? r.bScore - r.aScore : r.aScore - r.bScore;
      winsA += (m % 2 ? r.bScore > r.aScore : r.aScore > r.bScore) ? 1 : 0;
      dA.push(m % 2 ? r.bDesc : r.aDesc); dB.push(m % 2 ? r.aDesc : r.bDesc);
      console.log(`  ${na} ${r.aScore}-${r.bScore} ${nb}  (kd ${r.aK}/${r.aD} vs ${r.bK}/${r.bD}, grabs ${r.aGrabs}/${r.bGrabs})`);
    }
    const dm = (xs: Desc[], k: keyof Desc): number => +(xs.reduce((s, d) => s + d[k], 0) / xs.length).toFixed(1);
    console.log(`→ ${na}  margin ${mA > 0 ? '+' : ''}${mA} (${winsA}/${MATCHES})  agg${dm(dA, 'agg')} mob${dm(dA, 'mob')} air${(Number(dm(dA, 'air')) * 100).toFixed(0)}%`);
    console.log(`  ${nb}  agg${dm(dB, 'agg')} mob${dm(dB, 'mob')} air${(Number(dm(dB, 'air')) * 100).toFixed(0)}%\n`);
    appendFileSync(OUT, `${JSON.stringify({ pair: [na, nb], marginA: mA })}\n`);
  }
  process.exit(0);
}

// --qd: MAP-Elites archive over the behavior descriptors. Each (agg, mob,
// air) cell keeps its best genome across gens, so a monoculture can't
// evict the specialists that hold other cells. Buckets are coarse on
// purpose — the chaos pool spans agg 0.2-2, mob 14-21, air 2-20%.
const QD = process.argv.includes('--qd');
const archive = new Map<string, Row>();
const cellOf = (d: Desc): string =>
  `${Math.min(3, Math.floor(d.agg / 0.5))}.${Math.min(4, Math.max(0, Math.floor((d.mob - 14) / 2)))}.${Math.min(3, Math.floor(d.air / 0.08))}`;
const stats = new Map<Genome, Row>();
const mkRow = (g: Genome): Row => ({ g, name: gname(g), w: 0, l: 0, margin: 0, kd: 0, games: 0, worst: 0, desc: [] });
const descMean = (r: Row): Desc | null => {
  if (!r.desc.length) {return null;}
  const s = r.desc.reduce((a, d) => ({ agg: a.agg + d.agg, mob: a.mob + d.mob, air: a.air + d.air, life: a.life + d.life, heldEnd: a.heldEnd + d.heldEnd, hype: a.hype + d.hype }),
    { agg: 0, mob: 0, air: 0, life: 0, heldEnd: 0, hype: 0 });
  const n = r.desc.length;
  return { agg: s.agg / n, mob: s.mob / n, air: s.air / n, life: s.life / n, heldEnd: s.heldEnd / n, hype: s.hype / n };
};
for (const g of pool) {stats.set(g, mkRow(g));}
// Payoff matrix across the CURRENT pool, rebuilt per gen (genome objects
// change between gens — index identity via pool position).
let payoff: number[][] = [];

const t0 = performance.now();
let wallStop = false;
for (let gen = 0; gen < GENS && !wallStop; gen += 1) {
  payoff = pool.map(() => pool.map(() => 0));
  // Build the whole gen's match list as tasks, then dispatch — the
  // pairings only fold back into stats after all results land, so
  // ordering/worker count can't leak into fitness.
  const genTasks: PairTask[] = [];
  let tid = 0, grp = 0;
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      // mapsel=random: each match draws a fresh map index; matrix: all maps.
      const mis = MAPSEL === 'random'
        ? Array.from({ length: MATCHES }, () => Math.floor(rand() * MAPS.length))
        : MAPS.map((_, mi) => mi).flatMap((mi) => Array.from({ length: MATCHES }, () => mi));
      for (const [k, mi] of mis.entries()) {
        genTasks.push({ id: tid++, grp, ga: pool[i]!, gb: pool[j]!, flip: k % 2 === 1,
          seed: SEED * 1000 + gen * 100 + i * 10 + j + (k + mi * 101) * 5000, map: MAPS[mi]!.name,
          mode: pick(MODES), meta: { i, j, mi } });
      }
      grp += 1;
    }
  }
  if ((performance.now() - t0) / 1000 > WALL_S) {console.log(`wall cap — stopping before gen ${gen}`); wallStop = true; break;}
  // Per-group accumulators live across dispatch rounds (base matches +
  // any tiebreakers) — stats fold per task, margins only finalize once
  // no more matches are queued for that pairing.
  const grpWins = new Map<number, number>();
  const grpPlayed = new Map<number, number>();
  const grpMap = new Map<number, Map<number, number>>();
  const grpMode = new Map<number, Map<string, number>>();
  const grpSeen = new Set<number>();
  let racedOut = 0, tiebroke = 0;
  const fold = (tasks: PairTask[], res: Map<number, MatchResult>): void => {
    for (const t of tasks) {
      const r = res.get(t.id);
      if (!r) {racedOut++; continue;}
      const g = t.grp;
      const i = t.meta!.i as number, j = t.meta!.j as number, mi = t.meta!.mi as number;
      const ga = pool[i]!, gb = pool[j]!;
      const my = t.flip ? r.bScore : r.aScore, their = t.flip ? r.aScore : r.bScore;
      const myK = t.flip ? r.bK : r.aK, myD = t.flip ? r.bD : r.aD;
      const thK = t.flip ? r.aK : r.bK, thD = t.flip ? r.aD : r.bD;
      const pm = grpMap.get(g) ?? new Map<number, number>();
      pm.set(mi, (pm.get(mi) ?? 0) + my - their); grpMap.set(g, pm);
      const gm = grpMode.get(g) ?? new Map<string, number>();
      gm.set(t.mode ?? MODE, (gm.get(t.mode ?? MODE) ?? 0) + my - their); grpMode.set(g, gm);
      grpWins.set(g, (grpWins.get(g) ?? 0) + (my > their ? 1 : 0));
      grpPlayed.set(g, (grpPlayed.get(g) ?? 0) + 1);
      const ra = stats.get(ga)!, rb = stats.get(gb)!;
      ra.kd += myK / Math.max(1, myD); rb.kd += thK / Math.max(1, thD);
      ra.games++; rb.games++;
      ra.desc.push(t.flip ? r.bDesc : r.aDesc); rb.desc.push(t.flip ? r.aDesc : r.bDesc);
      if (!grpSeen.has(g)) {
        grpSeen.add(g);
        console.log(`  g${gen} ${gname(ga)}\n     vs ${gname(gb)}: ${r.aScore}-${r.bScore} (kd ${r.aK}/${r.aD} vs ${r.bK}/${r.bD}, held ${r.tokens})`);
      }
    }
  };
  fold(genTasks, await runTasks(genTasks));
  // Tiebreak rounds: pairings whose worst-map margin is still a coin
  // flip get TIEBREAK extra matches per map until they're decided or
  // the extra budget's spent.
  for (let tb = 0; tb < TIEBREAK; tb += 1) {
    const extra: PairTask[] = [];
    for (let i = 0, g = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1, g += 1) {
        const pm = grpMap.get(g);
        if (!pm || !pm.size) {continue;}
        const marginA = Math.min(...pm.values());
        if (Math.abs(marginA) > TIE) {continue;}
        const tbMis = MAPSEL === 'random' ? [Math.floor(rand() * MAPS.length)] : MAPS.map((_, mi) => mi);
        for (const mi of tbMis) {
          extra.push({ id: tid++, grp: g, ga: pool[i]!, gb: pool[j]!,
            flip: (tb + mi) % 2 === 1, // vary sides across rounds/maps
            seed: SEED * 1000 + gen * 100 + i * 10 + j + (MATCHES + tb + mi * 101) * 5000 + 9000000,
            map: MAPS[mi]!.name, mode: pick(MODES), meta: { i, j, mi } });
        }
        tiebroke++;
      }
    }
    if (!extra.length) {break;}
    fold(extra, await runTasks(extra));
  }
  // Margins finalize: worst-map per pairing → fitness/payoff/exploitability.
  for (let i = 0, g = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1, g += 1) {
      const ga = pool[i]!, gb = pool[j]!;
      const played = grpPlayed.get(g) ?? 0;
      const mapPairs = [...(grpMap.get(g) ?? new Map<number, number>())].sort((a, b) => a[0] - b[0]);
      const mapMargins = mapPairs.map(([, v]) => v);
      if (!mapMargins.length) {continue;}
      const marginA = Math.min(...mapMargins);
      stats.get(ga)!.margin += marginA; stats.get(gb)!.margin -= marginA;
      payoff[i]![j]! += marginA; payoff[j]![i]! -= marginA;
      stats.get(ga)!.worst = Math.min(stats.get(ga)!.worst, marginA);
      stats.get(gb)!.worst = Math.min(stats.get(gb)!.worst, -marginA);
      const winsA = grpWins.get(g) ?? 0;
      stats.get(ga)!.w += winsA; stats.get(ga)!.l += played - winsA;
      stats.get(gb)!.w += played - winsA; stats.get(gb)!.l += winsA;
      if (MAPS.length > 1 || played < MATCHES * MAPS.length) {console.log(`     map margins: ${mapPairs.map(([mi, m]) => `${MAPS[mi]!.name}:${m > 0 ? '+' : ''}${m}`).join(' ')} → worst ${marginA > 0 ? '+' : ''}${marginA}${played < MATCHES * MAPS.length ? ' (raced)' : ''}`);}
      const modePairs = [...(grpMode.get(g) ?? new Map<string, number>())];
      if (MODES.length > 1 && modePairs.length > 1) {console.log(`       mode margins: ${modePairs.map(([m, v]) => `${m}:${v > 0 ? '+' : ''}${v}`).join(' ')}`);}
    }
  }
  if (racedOut) {console.log(`  racing: ${racedOut} matches skipped`);}
  if (tiebroke) {console.log(`  tiebreak: ${tiebroke} close pairing(s) ×${TIEBREAK} extra`);}
  if ((performance.now() - t0) / 1000 > WALL_S) {console.log(`wall cap — board partial, stopping`); wallStop = true;}
  const board = pool.map((g) => stats.get(g)!).sort((x, y) => y.margin - x.margin);
  console.log(`\n── gen ${gen} board ──`);
  for (const r of board) {
    const d = descMean(r);
    const style = d ? ` agg${d.agg.toFixed(1)} mob${d.mob.toFixed(0)} air${(d.air * 100).toFixed(0)}% life${d.life.toFixed(0)}s hype${d.hype.toFixed(1)}` : '';
    console.log(`  ${String(r.w).padStart(2)}-${String(r.l).padStart(2)} margin=${String(r.margin).padStart(4)} worst=${String(r.worst).padStart(4)} kd=${(r.kd / Math.max(1, r.games)).toFixed(2)} ${r.name}${style}`);
  }
  // Meta-Nash over the payoff matrix: >60% on one genome = dominant
  // strategy; a spread = the meta is a blend and the roster IS the answer.
  const mix = nashMix(payoff);
  const nashStr = mix.map((w, i) => (w > 0.05 ? `${gname(pool[i]!)} ${(w * 100).toFixed(0)}%` : '')).filter(Boolean).join('  ');
  console.log(`  nash: ${nashStr}`);
  appendFileSync(OUT, `${JSON.stringify({ gen, nash: mix, board: board.map((r) => ({ g: r.g, w: r.w, l: r.l, margin: r.margin, worst: r.worst })) })}\n`);

  // Exploiter slot (AlphaStar 'main exploiter'): candidate genomes that
  // ONLY play the champion; beat it and they earn a pool seat next gen —
  // they exist to find the leader's hole before the meta settles.
  const champ = board[0]!.g;
  const exploiters: Genome[] = [];
  const eCount = Math.max(1, Math.floor(POP / 4));
  const eTasks: PairTask[] = [];
  const candOf: Genome[] = [];
  for (let e = 0; e < eCount; e += 1) {
    const others = pool.filter((g) => g !== champ);
    const cand = mutate(others.length ? pick(others) : pick(pool));
    candOf.push(cand);
    const eMis = MAPSEL === 'random'
      ? Array.from({ length: MATCHES }, () => Math.floor(rand() * MAPS.length))
      : MAPS.map((_, mi) => mi).flatMap((mi) => Array.from({ length: MATCHES }, () => mi));
    for (const [k, mi] of eMis.entries()) {
      eTasks.push({ id: 1e6 + e * 100 + mi * MATCHES + k, grp: 1e6 + e,
        ga: k % 2 ? champ : cand, gb: k % 2 ? cand : champ, flip: k % 2 === 1,
        seed: SEED * 77 + gen * 31 + e * 7 + k + mi * 997, map: MAPS[mi]!.name, mode: pick(MODES), meta: { k } });
    }
  }
  {
    const eRes = await runTasks(eTasks);
    for (let e = 0; e < eCount; e += 1) {
      let m = 0;
      for (const [id, r] of eRes) {
        const t = eTasks.find((x) => x.id === id)!;
        if (t.grp !== 1e6 + e) {continue;}
        const k = t.meta!.k as number;
        m += k % 2 ? r.bScore - r.aScore : r.aScore - r.bScore;
      }
      const cand = candOf[e]!;
      if (m > 0) {exploiters.push(cand); console.log(`  exploiter! ${gname(cand)} beats champ by ${m}`);}
      appendFileSync(OUT, `${JSON.stringify({ gen, exploiter: gname(cand), margin: m })}\n`);
    }
  }

  // Selection: top half survives; exploiters get seats first, losers
  // re-roll as mutants of survivors.
  const keep = Math.max(1, Math.floor(pool.length / 2));
  let winners = board.slice(0, keep).map((r) => r.g);
  if (QD) {
    for (const r of board) {
      const d = descMean(r);
      if (!d) {continue;}
      const k = cellOf(d);
      const cur = archive.get(k);
      if (!cur || r.margin > cur.margin) {archive.set(k, r);}
    }
    const elites = new Map<string, Row>();
    for (const r of [...archive.values()].sort((x, y) => y.margin - x.margin)) {if (!elites.has(r.name)) {elites.set(r.name, r);}}
    winners = [...elites.values()].slice(0, Math.max(1, POP - 2)).map((r) => r.g);
    console.log(`  qd: ${archive.size} cells, ${winners.length} elites kept`);
    appendFileSync(OUT, `${JSON.stringify({ gen, archive: [...archive.entries()].map(([cell, r]) => ({ cell, g: gname(r.g), margin: r.margin, desc: descMean(r) })) })}\n`);
  }
  pool = [...winners];
  const seen = new Set(pool.map(gname));
  for (const ex of exploiters) {
    if (pool.length >= POP) {break;}
    if (!seen.has(gname(ex))) {seen.add(gname(ex)); pool.push(ex); stats.set(ex, mkRow(ex));}
  }
  while (pool.length < POP) {
    const m = mutate(pick(winners));
    if (!seen.has(gname(m)) || pool.length >= POP) {
      seen.add(gname(m)); pool.push(m); stats.set(m, mkRow(m));
    }
  }
  // Stagnation breaker: when the pool's kit diversity collapses (few
  // distinct near/mid/far shells), mutation alone is local search —
  // inject fully-random legal immigrants in place of the tail.
  const shells = new Set(pool.map((g) => `${g.near}.${g.mid}.${g.far}`));
  if (shells.size <= Math.max(2, Math.floor(pool.length / 3))) {
    let added = 0;
    while (added < 2 && added + 1 < pool.length) {
      const r: Genome = {};
      for (const k of GENE_KEYS) {r[k] = Math.floor(rand() * DIMS[k]!.length);}
      if (!legal(r) || seen.has(gname(r))) {continue;}
      const drop = pool.length - 1 - added;
      seen.delete(gname(pool[drop]!)); stats.delete(pool[drop]!);
      pool[drop] = r; seen.add(gname(r)); stats.set(r, mkRow(r));
      added++;
    }
    if (added) {console.log(`  stagnation — ${shells.size} shells in pool, injected ${added} immigrant(s)`);}
  }
  // Winners keep accumulated stats — reigning champions defend the crown.
  console.log('');
}
appendFileSync(OUT, `${JSON.stringify({ pool, done: true })}\n`);
// The deliverable: the populated archive as a roster of named bot
// personalities — cell, genome string (parseGname-loadable), margin, the
// style descriptors that define the personality, and a difficulty tier
// cut by margin thirds (hard/med/easy — same data, different cut).
if (QD && archive.size) {
  const rows = [...archive.entries()].sort((a, b) => b[1].margin - a[1].margin);
  const tier = (i: number): string => (i < rows.length / 3 ? 'hard' : i < (2 * rows.length) / 3 ? 'med' : 'easy');
  appendFileSync(OUT, `${JSON.stringify({ roster: rows.map(([cell, r], i) => ({ cell, tier: tier(i), g: gname(r.g), margin: r.margin, desc: descMean(r) })) })}\n`);
  console.log(`roster: ${archive.size} personalities in ${OUT}`);
}
// Balance-regression signal: gene occupancy across the final pool —
// a perk/weapon that dominates every run regardless of mode is a
// balance bug report, not a meta finding.
{
  const freq: Record<string, Record<string, number>> = {};
  for (const k of GENE_KEYS) {
    if (k in { aim: 1, move: 1, react: 1, jitter: 1, temper: 1 }) {continue;} // numeric tiers, not identities
    for (const g of pool) {
      const raw = DIMS[k]![g[k]!];
      const v = String(typeof raw === 'number' ? WeaponType[raw] : raw ?? g[k]);
      (freq[k] ??= {})[v] = (freq[k]![v] ?? 0) + 1;
    }
  }
  appendFileSync(OUT, `${JSON.stringify({ freq })}\n`);
}
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)}s — pool + boards appended to ${OUT}`);
process.exit(0);
