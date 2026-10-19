// Grab-speed distribution over seeds — one trajectory per seed is one
// RNG draw; the question is the grabV/cap-rate spread, not a lucky run.
//   cd server_bun && bun ../_tools/sweeps/capdist.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

// Same flat-stand picker capRun uses — spec bases on some maps sit too
// far apart to ever resolve inside the budget.
const pickStands = (f: ReturnType<typeof hmParseBin>, scale: number, minSep: number) => {
  const flat = (x: number, z: number): number => {
    const c = hmHeight(f, x, z);
    return Math.max(
      Math.abs(hmHeight(f, x + 6, z) - c), Math.abs(hmHeight(f, x - 6, z) - c),
      Math.abs(hmHeight(f, x, z + 6) - c), Math.abs(hmHeight(f, x, z - 6) - c));
  };
  const cands: { x: number; y: number; z: number }[] = [];
  for (let z = scale * 0.1; z < scale * 0.9; z += 40) {
    for (let x = scale * 0.1; x < scale * 0.9; x += 40) {
      if (flat(x, z) < 2) { cands.push({ x, y: hmHeight(f, x, z), z }); }
    }
  }
  const a = cands[0]!;
  const b = cands.find(c => Math.hypot(c.x - a.x, c.z - a.z) >= minSep) ?? cands[cands.length - 1]!;
  return { alpha: a, bravo: b };
};

const parse = (name: string) => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))), spec.heightScale ?? 1, spec.tileSize);
  // Same stand choice capRun makes: peaks runs its ±150 authored pair,
  // dunes probes flat cells 500m apart.
  const bases = name === 'peaks'
    ? { alpha: { x: -150, y: hmHeight(f, -150, 0), z: 0 }, bravo: { x: 150, y: hmHeight(f, 150, 0), z: 0 } }
    : pickStands(f, spec.tileSize ?? 1500, 500);
  return { name, f, bases };
};

const MAPS = ['peaks', 'dunes'].map(parse);
const SEEDS = [9001, 9002, 9003, 9004, 9005];

for (const m of MAPS) {
  const rows = SEEDS.map((seed) => {
    const s = measureCap(m.f, m.bases, { seed, simBudgetS: 300 });
    return { seed, grabT: s.grabT, grabV: s.grabV, carryT: s.carryT, avgSpeed: s.avgSpeed, caps: s.caps };
  });
  console.log(`${m.name}:`);
  for (const r of rows) {
    console.log(`  seed ${r.seed}: grab@${r.grabT.toFixed(0)}s grabV=${r.grabV.toFixed(1)} carry=${r.carryT.toFixed(0)}s avgSpd=${r.avgSpeed.toFixed(1)} caps=${r.caps}`);
  }
  const grabs = rows.filter(r => r.grabT > 0);
  console.log(`  → grabV mean=${(grabs.reduce((a, r) => a + r.grabV, 0) / Math.max(1, grabs.length)).toFixed(1)} capRate=${rows.filter(r => r.caps > 0).length}/${rows.length}`);
}
