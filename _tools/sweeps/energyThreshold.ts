/**
 * 1-dim threshold sweep on moves.skiVetoSpeed — the param that actually
 * flips the capper from slow (grabV~10) to fast (grabV~17+).
 * eScoreW alone is flat; skiVetoSpeed is the interaction lever.
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

const OUT_DIR = resolve(import.meta.dir, 'out');
mkdirSync(OUT_DIR, { recursive: true });

const name = 'katabatic';
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${name}.json`)).toString('utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

const get = (path: string): number =>
  path.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)[k], BOT_TUNING as unknown) as number;
const set = (path: string, v: number): void => {
  const parts = path.split('.');
  const last = parts.pop()!;
  const obj = parts.reduce((o: unknown, k) => (o as Record<string, unknown>)[k], BOT_TUNING as unknown) as Record<string, number>;
  obj[last] = v;
};

const csvPath = resolve(OUT_DIR, 'energy_threshold_skiVetoSpeed.csv');
if (!existsSync(csvPath)) {
  appendFileSync(csvPath, 'skiVetoSpeed,caps,grabT,carryT,avgSpeed,grabV,approachE,peakE\n');
}

const values = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
for (const v of values) {
  set('moves.skiVetoSpeed', v);
  const stat = measureCap(f, bases, { simBudgetS: 300, tag: `skiVetoSpeed=${v}` });
  appendFileSync(csvPath, `${v},${stat.caps},${stat.grabT.toFixed(1)},${stat.carryT.toFixed(1)},${stat.avgSpeed.toFixed(1)},${stat.grabV.toFixed(1)},${stat.approachE.toFixed(0)},${stat.peakE.toFixed(0)}\n`);
  console.log(`skiVetoSpeed=${v}: caps=${stat.caps} grab=${stat.grabT.toFixed(0)}s carry=${stat.carryT.toFixed(0)}s spd=${stat.avgSpeed.toFixed(1)} grabV=${stat.grabV.toFixed(1)} apprE=${stat.approachE.toFixed(0)} peakE=${stat.peakE.toFixed(0)}`);
}
set('moves.skiVetoSpeed', 7);
console.log(`\nCSV → ${csvPath}`);
