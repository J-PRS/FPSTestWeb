// Reproduce one sweep genome's capper run with verbose telemetry.
//   bun _tools/sweeps/repro.ts <map> <g0|...> [v1 v2 ...]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { BOT_TUNING } from '../../shared/botTuning.ts';
import { measureCap } from '../../server_bun/tests/scenarios/capMeasure.ts';

const DIMS: [string, number, number][] = [
  ['moves.jetHoldBase', 0.1, 1.5], ['moves.jetHoldRand', 0.0, 1.2], ['moves.tankedMin', 0, 45],
  ['moves.comfyEnergy', 10, 60], ['moves.runwayBase', 10, 120], ['moves.runwayDropK', 0.5, 5],
  ['moves.runwaySpeedK', 0.1, 1.5], ['moves.ceilingAgl', 12, 80], ['moves.runInSpeed', 15, 45],
  ['moves.runInGdMax', 40, 200], ['moves.hopSpeed', 2, 15], ['moves.skiVetoRise', 1, 8],
  ['moves.skiVetoSpeed', 3, 16], ['moves.climbRise', 0.5, 6], ['moves.tapEnergyMin', 4, 50],
  ['moves.diveAglMin', 4, 40], ['lines.commitS', 0.5, 6], ['lines.reach', 25, 140],
  ['lines.runnerReachK', 1, 4], ['lines.runnerConeK', 0.8, 4], ['lines.runnerDropW', 0.5, 4],
  ['lines.runnerStraightW', 0.5, 10], ['lines.apexGd', 60, 400], ['lines.apexW', 0, 2.5],
  ['lines.progressW', 0.3, 2], ['lines.earlyClimbW', 0, 60], ['steer.step', 3, 20],
  ['steer.turnRate', 1.5, 10], ['steer.slopeThresh', 0.2, 1.2], ['brain.thinkS', 0.1, 0.8],
  ['brain.heroThinkK', 0.2, 1.5], ['brain.wanderBase', 0.1, 1.5], ['brain.wanderRand', 0.1, 1.5],
  ['brain.dutyBase', 0.1, 1.5], ['brain.dutyRand', 0.1, 1.5],
];
const set = (p: string, v: number) => {
  const parts = p.split('.'); const last = parts.pop()!;
  (parts.reduce((o: any, k) => o[k], BOT_TUNING as any) as Record<string, number>)[last] = v;
};
const [map, , ...vals] = process.argv.slice(2);
vals.forEach((v, i) => set(DIMS[i]![0], Number(v)));
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${map}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };
measureCap(f, bases, { simBudgetS: 210, verbose: true, tag: `${map}:repro` });
