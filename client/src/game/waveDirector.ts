import * as THREE from 'three';

import type { createEntities } from './entities.js';
import type { Player } from '../entities/Player.js';
import type { Terrain } from '../world/terrain.js';
import type { ChildLogger } from '../core/Logger.js';

interface DirectorDeps {
  entities: ReturnType<typeof createEntities>;
  player: () => Player;
  terrain: () => Terrain;
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
  { cost: 6,  minT: 0,   weight: 4, label: 'ball',       spawn: (e) => e.spawnBall() },
  { cost: 10, minT: 0,   weight: 4, label: 'crawler',    spawn: (e) => e.spawnCrawler() },
  { cost: 12, minT: 40,  weight: 3, label: 'seeker',     spawn: (e) => e.spawnSeeker() },
  { cost: 14, minT: 75,  weight: 3, label: 'rakk',       spawn: (e) => e.spawnRakk() },
  { cost: 15, minT: 90,  weight: 3, label: 'roller',     spawn: (e) => e.spawnRoller() },
  { cost: 20, minT: 120, weight: 2, label: 'turretter',  spawn: (e) => e.spawnTurretter() },
  { cost: 25, minT: 150, weight: 2, label: 'miner',      spawn: (e) => e.spawnMiner() },
  { cost: 28, minT: 180, weight: 2, label: 'totem',      spawn: (e) => e.spawnTotem() },
  { cost: 30, minT: 150, weight: 1, label: 'elite ball', spawn: (e) => e.spawnEliteBall() },
];

// ---- Scripted beats: authored moments on the clock -------------------------
// Minute marks are moments — a surge the ambient pool can't produce.
interface WaveBeat { at: number; name: string; run: (d: DirectorDeps) => void }

function ringOf(d: DirectorDeps, n: number, dist: number, fn: (pos: THREE.Vector3) => void): void {
  const p = d.player().pos;
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
      const p = d.player().pos;
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 22;
        d.entities.plantMine(new THREE.Vector3(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r));
      }
    } },
  { at: 290, name: 'Elite + enrage storm', run: (d) => {
      d.entities.spawnEliteBall();
      for (const b of d.entities.balls) if (!b.dead) b.enrage();
    } },
  { at: 360, name: 'Siege: totem + wall', run: (d) => {
      d.entities.spawnTotem();
      ringOf(d, 4, 40, (p) => d.entities.spawnCrawler(p));
    } },
];
const WAVE_LOOP = 120; // after the last beat, loop on a 2-minute cycle at higher intensity

const SPEND_INTERVAL = 5.0;  // seconds between credit spends
const CREDIT_CAP = 140;      // hoard cap — prevents absurd dump-bursts
const CREDIT_BASE = 0.45;    // credits/sec at t=0 — one cheap pick every ~15s early
const CREDIT_RAMP = 0.0045;  // extra credits/sec per elapsed second (~+27/min by minute 10)

/**
 * Hybrid wave director: scripted beats on the clock (authored moments) +
 * a credit pool spent on a weighted random roster that unlocks over time.
 * Left 4 Dead / VS-style: the timeline gives pacing, the pool gives chaos.
 */
export function createWaveDirector(deps: DirectorDeps) {
  let elapsed = 0;
  let credits = 0; // empty opening bank — ambient timers carry the first minute
  let spendTimer = 12; // first spend ~12s in, not instantly
  let waveIdx = 0;
  let loopCount = 0;

  function update(dt: number): void {
    elapsed += dt;
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
      if (affordable.length) {
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
