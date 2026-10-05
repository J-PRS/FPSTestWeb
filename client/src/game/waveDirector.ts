import * as THREE from 'three';

import type { createEntities } from './entities.js';
import type { Player } from '../entities/Player.js';
import type { Terrain } from '../world/terrain.js';
import type { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';

interface DirectorDeps {
  entities: ReturnType<typeof createEntities>;
  lazyPlayer: () => Player;
  lazyTerrain: () => Terrain;
  logger: ChildLogger;
}

// ---- Credit pool: what a random spend can buy ------------------------------
// Each entry: credit cost, the earliest minute it joins the pool, weight.
// The pool grows over the run — early minutes are balls/crawlers only.
interface PoolEntry {
  cost: number;
  minT: number; // seconds — joins the pool after this
  weight: number;
  label: string;
  spawn: (e: ReturnType<typeof createEntities>) => void;
}

const POOL: PoolEntry[] = [
  { cost: 4,  minT: 0,   weight: 5, label: 'grub',       spawn: (e) => e.spawnGrub() },
  { cost: 5,  minT: 0,   weight: 5, label: 'scarab pack', spawn: (e) => e.spawnScarab() },
  { cost: 6,  minT: 15,  weight: 4, label: 'gnat cloud', spawn: (e) => e.spawnGnatCloud() },
  { cost: 6,  minT: 0,   weight: 4, label: 'ball',       spawn: (e) => e.spawnBall() },
  { cost: 10, minT: 0,   weight: 4, label: 'crawler',    spawn: (e) => e.spawnCrawler() },
  { cost: 11, minT: 30,  weight: 4, label: 'viper',      spawn: (e) => e.spawnSnake() },
  { cost: 12, minT: 40,  weight: 3, label: 'seeker',     spawn: (e) => e.spawnSeeker() },
  { cost: 14, minT: 75,  weight: 3, label: 'rakk',       spawn: (e) => e.spawnRakk() },
  { cost: 15, minT: 90,  weight: 3, label: 'boulder',     spawn: (e) => e.spawnRoller() },
  { cost: 20, minT: 120, weight: 2, label: 'turretter',  spawn: (e) => e.spawnTurretter() },
  { cost: 25, minT: 150, weight: 2, label: 'overlord',      spawn: (e) => e.spawnOverlord() },
  { cost: 28, minT: 180, weight: 2, label: 'totem',      spawn: (e) => e.spawnTotem() },
  { cost: 60, minT: 300, weight: 1, label: 'uber totem', spawn: (e) => e.spawnUberTotem() },
  { cost: 30, minT: 150, weight: 1, label: 'elite ball', spawn: (e) => e.spawnEliteBall() },
  // Ubers — rare, expensive, late. Named threats, not population filler.
  { cost: 25, minT: 200, weight: 0.8, label: 'dreadbeetle',  spawn: (e) => e.spawnScarab(undefined, true) },
  { cost: 18, minT: 150, weight: 0.8, label: 'bloatgrub',    spawn: (e) => e.spawnGrub(undefined, true) },
  { cost: 22, minT: 200, weight: 0.8, label: 'gnat queen',   spawn: (e) => e.spawnGnatCloud(true) },
  { cost: 45, minT: 300, weight: 0.7, label: 'matriarch',    spawn: (e) => e.spawnCrawler(undefined, true) },
  { cost: 28, minT: 220, weight: 0.7, label: 'king serpent', spawn: (e) => e.spawnSnake(undefined, true) },
  { cost: 32, minT: 240, weight: 0.8, label: 'avalanche',    spawn: (e) => e.spawnRoller(true) },
  { cost: 24, minT: 160, weight: 0.8, label: 'lancer',       spawn: (e) => e.spawnSeeker(true) },
  { cost: 30, minT: 220, weight: 0.7, label: 'elder rakk',   spawn: (e) => e.spawnRakk(true) },
  { cost: 42, minT: 280, weight: 0.7, label: 'siege turret', spawn: (e) => e.spawnTurretter(true) },
  { cost: 55, minT: 340, weight: 0.6, label: 'broodmother',  spawn: (e) => e.spawnOverlord(true) },
];

// ---- Scripted beats: authored moments on the clock -------------------------
// Minute marks are moments — a surge the ambient pool can't produce.
interface WaveBeat { at: number; name: string; run: (d: DirectorDeps) => void }

function ringOf(d: DirectorDeps, n: number, dist: number, fn: (pos: THREE.Vector3) => void): void {
  const p = d.lazyPlayer().pos;
  const off = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = off + (i / n) * Math.PI * 2;
    fn(new THREE.Vector3(p.x + Math.cos(a) * dist, 0, p.z + Math.sin(a) * dist));
  }
}

const WAVES: WaveBeat[] = [
  { at: 50,  name: 'Crawler surround',   run: (d) => ringOf(d, 5, 30, (p) => d.entities.spawnCrawler(p)) },
  { at: 100, name: 'Seeker pair + pack', run: (d) => { d.entities.spawnSeeker(); d.entities.spawnSeeker(); ringOf(d, 3, 35, (p) => d.entities.spawnCrawler(p)); } },
  { at: 160, name: 'Rakk flock',         run: (d) => { d.entities.spawnRakk(); d.entities.spawnRakk(); d.entities.spawnRakk(); } },
  { at: 220, name: 'Mine rain',          run: (d) => {
      const p = d.lazyPlayer().pos;
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 22;
        // One doombloom hidden in the rain — clear the field carelessly
        // and the whole garden goes up at once.
        d.entities.plantMine(new THREE.Vector3(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r), i === 0);
      }
    } },
  { at: 290, name: 'Elite + enrage storm', run: (d) => {
      d.entities.spawnEliteBall();
      for (const b of d.entities.balls) {if (!b.dead) {b.enrage();}}
    } },
  { at: 360, name: 'Siege: totem + wall', run: (d) => {
      d.entities.spawnTotem();
      ringOf(d, 4, 40, (p) => d.entities.spawnCrawler(p));
    } },
];
const WAVE_LOOP = 120; // after the last beat, loop on a 2-minute cycle at higher intensity

const SPEND_INTERVAL = 5;  // seconds between credit spends
const CREDIT_CAP = 140;      // hoard cap — prevents absurd dump-bursts
const CREDIT_BASE = 0.45;    // credits/sec at t=0 — one cheap pick every ~15s early
const CREDIT_RAMP = 0.0045;  // extra credits/sec per elapsed second (~+27/min by minute 10)

// ---- Random mode (?spawns=random) ----------------------------------------
// Testing mode: no scripted beats, no credit economy, no unlock timeline —
// EVERYTHING can spawn from t=0. Two knobs ramp slowly: total alive budget
// and spawn cadence. Per-species MAX caps inside the spawn fns still apply
// (a roll that hits a capped species just no-ops — no extra bookkeeping).
// Weights are deliberately lopsided: fodder is common, dangerous/rare
// enemies show up early but stay a small fraction of the population.
const RANDOM_MODE = urlParams.randomSpawns;
// ?mode=classic — the ball ambient timer is the whole population; the
// director still ticks `elapsed` so the HUD timer works
const CLASSIC_MODE = urlParams.isClassic;

const RANDOM_POOL: { weight: number; label: string; spawn: (e: ReturnType<typeof createEntities>) => void }[] = [
  { weight: 6, label: 'scarab pack', spawn: (e) => e.spawnScarab() },
  { weight: 6, label: 'grub',       spawn: (e) => e.spawnGrub() },
  { weight: 4, label: 'gnat cloud', spawn: (e) => e.spawnGnatCloud() },
  { weight: 5, label: 'ball',       spawn: (e) => e.spawnBall() },
  { weight: 4, label: 'crawler',    spawn: (e) => e.spawnCrawler() },
  { weight: 3, label: 'viper',      spawn: (e) => e.spawnSnake() },
  { weight: 2.5, label: 'seeker',     spawn: (e) => e.spawnSeeker() },
  { weight: 2, label: 'rakk',       spawn: (e) => e.spawnRakk() },
  { weight: 1.5, label: 'boulder',     spawn: (e) => e.spawnRoller() },
  { weight: 1, label: 'turretter',  spawn: (e) => e.spawnTurretter() },
  { weight: 0.7, label: 'overlord',   spawn: (e) => e.spawnOverlord() },
  { weight: 0.6, label: 'totem',      spawn: (e) => e.spawnTotem() },
  { weight: 0.2, label: 'uber totem', spawn: (e) => e.spawnUberTotem() },
  { weight: 0.4, label: 'elite ball', spawn: (e) => e.spawnEliteBall() },
  // Ubers — same weight tier as the named elites
  { weight: 0.3, label: 'dreadbeetle',  spawn: (e) => e.spawnScarab(undefined, true) },
  { weight: 0.3, label: 'bloatgrub',    spawn: (e) => e.spawnGrub(undefined, true) },
  { weight: 0.3, label: 'gnat queen',   spawn: (e) => e.spawnGnatCloud(true) },
  { weight: 0.25, label: 'matriarch',   spawn: (e) => e.spawnCrawler(undefined, true) },
  { weight: 0.25, label: 'king serpent', spawn: (e) => e.spawnSnake(undefined, true) },
  { weight: 0.3, label: 'avalanche',    spawn: (e) => e.spawnRoller(true) },
  { weight: 0.3, label: 'lancer',       spawn: (e) => e.spawnSeeker(true) },
  { weight: 0.25, label: 'elder rakk',  spawn: (e) => e.spawnRakk(true) },
  { weight: 0.25, label: 'siege turret', spawn: (e) => e.spawnTurretter(true) },
  { weight: 0.2, label: 'broodmother',  spawn: (e) => e.spawnOverlord(true) },
];
const RANDOM_WEIGHT_TOTAL = RANDOM_POOL.reduce((s, p) => s + p.weight, 0);

// Budget ramp: 14 alive at t=0, +1 per 20s, hard-capped at 40 — the world
// fills in over the first minutes instead of dumping the cap instantly.
const RANDOM_BUDGET_BASE = 14;
const RANDOM_BUDGET_RAMP_T = 20;   // s per +1
const RANDOM_BUDGET_MAX = 40;
// Cadence ramp: one roll every 3.5s at t=0, tightening to ~1.3s by minute 6.
const RANDOM_INTERVAL_BASE = 3.5;
const RANDOM_INTERVAL_MIN = 1.3;
const RANDOM_INTERVAL_RAMP = 0.006; // s shaved off per elapsed second

function aliveCount(e: ReturnType<typeof createEntities>): number {
  let n = 0;
  for (const l of [e.balls, e.crawlers, e.turrets, e.rollers, e.seekers, e.overlords, e.totems, e.rakks] as { dead: boolean }[][]) {
    for (const t of l) {if (!t.dead) {n++;}}
  }
  return n;
}

/**
 * Hybrid wave director: scripted beats on the clock (authored moments) +
 * a credit pool spent on a weighted random roster that unlocks over time.
 * Left 4 Dead / VS-style: the timeline gives pacing, the pool gives chaos.
 * ?spawns=random replaces all of it with flat weighted-random spawning.
 */
export function createWaveDirector(deps: DirectorDeps) {
  let elapsed = 0;
  let credits = 0; // empty opening bank — ambient timers carry the first minute
  let spendTimer = 12; // first spend ~12s in, not instantly
  let waveIdx = 0;
  let loopCount = 0;
  let randomT = 1.5; // first random roll lands early — populate fast for testing

  function updateRandom(dt: number): void {
    elapsed += dt;
    randomT -= dt;
    if (randomT > 0) {return;}
    randomT = Math.max(RANDOM_INTERVAL_MIN, RANDOM_INTERVAL_BASE - elapsed * RANDOM_INTERVAL_RAMP);
    const budget = Math.min(RANDOM_BUDGET_MAX, RANDOM_BUDGET_BASE + Math.floor(elapsed / RANDOM_BUDGET_RAMP_T));
    if (aliveCount(deps.entities) >= budget) {return;}
    let roll = Math.random() * RANDOM_WEIGHT_TOTAL;
    for (const p of RANDOM_POOL) {
      roll -= p.weight;
      if (roll <= 0) {
        p.spawn(deps.entities);
        deps.logger.debug(`[Director:random] ${p.label} (alive ${aliveCount(deps.entities)}/${budget})`);
        return;
      }
    }
  }

  function update(dt: number): void {
    if (RANDOM_MODE) { updateRandom(dt); return; }
    elapsed += dt;
    if (CLASSIC_MODE) {return;}
    credits = Math.min(CREDIT_CAP, credits + (CREDIT_BASE + elapsed * CREDIT_RAMP) * dt);

    // Scripted beats — after the table runs out, loop the heavy ones
    // (spaced by WAVE_LOOP, intensity unchanged — the pool escalates anyway)
    if (waveIdx < WAVES.length && elapsed >= WAVES[waveIdx].at) {
      deps.logger.info(`[Director] wave ${waveIdx + 1}: ${WAVES[waveIdx].name} @ ${elapsed.toFixed(0)}s`);
      WAVES[waveIdx].run(deps);
      waveIdx++;
    } else if (waveIdx >= WAVES.length && elapsed >= WAVES[WAVES.length - 1].at + WAVE_LOOP * (loopCount + 1)) {
      // Loop: re-fire a random late-game beat
      const late = WAVES[Math.max(0, WAVES.length - 3) + Math.floor(Math.random() * 3)];
      deps.logger.info(`[Director] loop ${loopCount + 1}: ${late.name} @ ${elapsed.toFixed(0)}s`);
      late.run(deps);
      loopCount++;
    }

    // Credit spend — weighted random affordable pick from the unlocked pool
    spendTimer -= dt;
    if (spendTimer <= 0) {
      spendTimer = SPEND_INTERVAL;
      const affordable = POOL.filter(p => p.minT <= elapsed && p.cost <= credits);
      if (affordable.length > 0) {
        let roll = Math.random() * affordable.reduce((s, p) => s + p.weight, 0);
        let pick = affordable[0];
        for (const p of affordable) { roll -= p.weight; if (roll <= 0) { pick = p; break; } }
        credits -= pick.cost;
        deps.logger.debug(`[Director] spend ${pick.cost}c → ${pick.label} (bank ${credits.toFixed(0)})`);
        pick.spawn(deps.entities);
      }
    }
  }

  return { update, get elapsed() { return elapsed; }, get credits() { return credits; } };
}
