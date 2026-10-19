// Grab-speed distribution over seeds — one trajectory per seed is one
// RNG draw; the question is the grabV/cap-rate spread, not a lucky run.
//   cd server_bun && bun ../_tools/sweeps/capdist.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

const parse = (name: string) => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`), 'utf8'));
  const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))), spec.heightScale ?? 1, spec.tileSize);
  const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
  return { name, f, bases: { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) } };
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
