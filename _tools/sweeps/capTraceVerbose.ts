// Verbose single cap trace on the capRun dunes/peaks setups — approach
// telemetry per 1s beat plus the pre-grab ring, so we can see where
// grab speed dies. (capTrace.ts renders the route; this one is numbers.)
//   cd server_bun && bun ../_tools/sweeps/capTraceVerbose.ts [map] [seed]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

const MAP = process.argv[2] ?? 'dunes';
const SEED = Number(process.argv[3] ?? 9001);

const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))), spec.heightScale ?? 1, spec.tileSize);

const flat = (x: number, z: number): number => {
  const c = hmHeight(f, x, z);
  return Math.max(
    Math.abs(hmHeight(f, x + 6, z) - c), Math.abs(hmHeight(f, x - 6, z) - c),
    Math.abs(hmHeight(f, x, z + 6) - c), Math.abs(hmHeight(f, x, z - 6) - c));
};
const scale = spec.tileSize ?? 1500;
const lo = scale * 0.1, hi = scale * 0.9;
const cands: { x: number; y: number; z: number }[] = [];
for (let z = lo; z < hi; z += 40) {
  for (let x = lo; x < hi; x += 40) {
    if (flat(x, z) < 2) { cands.push({ x, y: hmHeight(f, x, z), z }); }
  }
}
const a = cands[0]!;
const b = cands.find(c => Math.hypot(c.x - a.x, c.z - a.z) >= 500) ?? cands[cands.length - 1]!;
console.log(`${MAP} stands (${a.x.toFixed(0)},${a.z.toFixed(0)}) ↔ (${b.x.toFixed(0)},${b.z.toFixed(0)}) sep=${Math.hypot(b.x - a.x, b.z - a.z).toFixed(0)}m`);
const s = measureCap(f, { alpha: a, bravo: b }, { verbose: true, tag: MAP, seed: SEED, simBudgetS: 480 });
console.log(`RESULT grab@${s.grabT.toFixed(0)}s grabV=${s.grabV.toFixed(1)} passV=${s.passV.toFixed(1)}@${s.passDy.toFixed(0)} carry=${s.carryT.toFixed(0)}s avgSpd=${s.avgSpeed.toFixed(1)} caps=${s.caps}`);
