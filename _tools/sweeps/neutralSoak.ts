/**
 * Neutral-field capper soak — runs measureCap on the default generated
 * heightfield (server_bun/heightmap.bin, 1500m wrap) with bases placed
 * on a diagonal, both diagonals x both directions = 4 combos. A field
 * with no authored terrain tricks isolates the route logic itself: any
 * stall/orbit here is the bot's fault, not a map's.
 *
 *   bun _tools/sweeps/neutralSoak.ts [--spread 283] [--budget 160]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const SPREAD = arg('spread', 566);   // half the diagonal leg — 566 => ~800m apart
const BUDGET = arg('budget', 160);
const HSCALE = arg('hscale', 1);     // vertical gain multiplier — 1.5 = noticeably hillier
const SEEDS = arg('seeds', 1);       // trajectories per combo — one seed is ONE path, not a distribution
const SEED0 = arg('seed0', 9001);
const BARE = process.argv.includes('--bare'); // no dais platform — flag on bare dirt

const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), HSCALE);
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });

// Diagonal endpoints: SW<->NE and NW<->SE, each timed in both directions.
const combos = [
  { tag: 'SW>NE', alpha: at(-SPREAD, -SPREAD), bravo: at(SPREAD, SPREAD) },
  { tag: 'NE>SW', alpha: at(SPREAD, SPREAD), bravo: at(-SPREAD, -SPREAD) },
  { tag: 'NW>SE', alpha: at(-SPREAD, SPREAD), bravo: at(SPREAD, -SPREAD) },
  { tag: 'SE>NW', alpha: at(SPREAD, -SPREAD), bravo: at(-SPREAD, SPREAD) },
];

console.log(`neutral soak: spread=${SPREAD} (~${(Math.hypot(SPREAD, SPREAD)).toFixed(0)}m flag gap) hscale=${HSCALE} bare=${BARE} seeds=${SEEDS}`);
for (const c of combos) {
  const grabs: number[] = [], carries: number[] = [], spds: number[] = [];
  let caps = 0, noGrab = 0;
  for (let s0 = 0; s0 < SEEDS; s0++) {
    const s = measureCap(f, { alpha: c.alpha, bravo: c.bravo }, { simBudgetS: BUDGET, tag: c.tag, bareFlags: BARE, seed: SEED0 + s0 });
    if (s.grabT > 0) grabs.push(s.grabT); else noGrab++;
    if (s.caps > 0) { caps++; carries.push(s.carryT); spds.push(s.avgSpeed); }
  }
  const med = (a: number[]) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!.toFixed(0) : '-';
  if (SEEDS > 1) {
    console.log(`${c.tag}  capRate=${caps}/${SEEDS} medGrab=${med(grabs)}s medCarry=${med(carries)}s medSpd=${med(spds)}m/s noGrab=${noGrab}`);
  } else {
    const s = grabs[0];
    console.log(`${c.tag}  caps=${caps} grab=${grabs.length ? s!.toFixed(0) : '-'}s carry=${med(carries)}s spd=${med(spds)} path=-`);
  }
}
