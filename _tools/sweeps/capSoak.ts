/**
 * Capacity soak — ramp live entities until the room's sim step blows a
 * per-tick budget, so "how many bots/creatures can a room hold" is a
 * measured number, not a guess.
 *
 *   bun _tools/sweeps/capSoak.ts --kind bots|creatures [--map katabatic | --field default]
 *                              [--start 20] [--incr 10] [--max 200]
 *                              [--secs 10] [--budget 12] [--seed 1337]
 *
 * bots: populate() in --incr chunks (each a real roster bot with a live
 * brain); creatures: raises creatureSim.pops so the sim back-fills.
 * Each level warms 2 sim-s then measures --secs sim-s of step() with the
 * room's per-sim-phase profiler — the knee row says which phase cracked.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight } from '../../shared/heightfield.ts';
import { mkRoom, step } from '../../server_bun/tests/scenarios/harness.ts';
import { simNow } from '../../server_bun/src/simClock.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const KIND = arg('kind', 'bots');           // bots | creatures
const MAP = arg('map', 'katabatic');
const FIELD = arg('field', '');
const START = Number(arg('start', 20));
const INCR = Number(arg('incr', 10));
const MAX = Number(arg('max', 200));
const SECS = Number(arg('secs', 10));       // measurement window per level (sim seconds)
const BUDGET = Number(arg('budget', 12));   // p95 sim-step ms that trips the alarm
const SEED = Number(arg('seed', 1337));
const CREATURE_KIND = arg('creature', 'crawler');
const dt = 0.05;

let spec: Record<string, unknown> = {};
let f;
if (FIELD === 'default') {
  f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, '../../server_bun/heightmap.bin'))), 1);
} else {
  spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
  f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${(spec as { terrain: string }).terrain}`))), 1);
}
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const bases = FIELD === 'default'
  ? { alpha: at(566, -566), bravo: at(-566, 566) }
  : { alpha: at((spec as { bases: { alpha: { x: number; z: number } } }).bases.alpha.x, (spec as never as { bases: { alpha: { z: number } } }).bases.alpha.z),
      bravo: at((spec as never as { bases: { bravo: { x: number; z: number } } }).bases.bravo.x, (spec as never as { bases: { bravo: { z: number } } }).bases.bravo.z) };

const room = mkRoom({ ...spec, mode: 'ctf', bots: KIND === 'bots' ? 0 : 4, bases }, 'ctf', SEED, false, f);
// The soak drives the roster itself — an honored botFill would cull every
// populate() back to the map's fill count once a second.
room.spec.botFill = 0;
if (KIND === 'creatures') room.creatureSim.pops = { [CREATURE_KIND]: 0 };

const percentile = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
};

const measure = (simSecs: number) => {
  const profile = new Map<string, number>();
  const totals: number[] = [];
  const ticks = Math.round(simSecs / dt);
  for (let i = 0; i < ticks; i++) {
    profile.clear();
    step(room, 1, dt, profile);
    room.messages.respawnTick(simNow());
    let tot = 0;
    for (const v of profile.values()) tot += v;
    totals.push(tot);
  }
  return { median: percentile(totals, 50), p95: percentile(totals, 95), max: Math.max(...totals) };
};

// Cumulative phase breakdown over the measured window — which stage
// owns the knee (bots think/drive, crawl brains, move integration...).
const phaseProfile = (simSecs: number) => {
  const profile = new Map<string, number>();
  const ticks = Math.round(simSecs / dt);
  const sums = new Map<string, number>();
  for (let i = 0; i < ticks; i++) {
    profile.clear();
    step(room, 1, dt, profile);
    for (const [k, v] of profile) sums.set(k, (sums.get(k) ?? 0) + v);
    room.messages.respawnTick(simNow());
  }
  return [...sums.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${(v / ticks).toFixed(2)}`).join(' ');
};

let n = START;
let firstBust = -1;
console.log(`kind=${KIND} map=${FIELD || MAP} budget(p95)=${BUDGET}ms window=${SECS}s sim`);
console.log('count  med(ms)  p95(ms)  max(ms)  topPhases(ms/tick)');
for (;;) {
  if (KIND === 'bots') room.bots.populate(n === START ? START : INCR);
  else room.creatureSim.pops = { [CREATURE_KIND]: n };
  measure(2); // warm: brains settle, spawns land
  const m = measure(SECS);
  const phases = phaseProfile(Math.min(SECS, 4));
  const count = KIND === 'bots' ? room.bots.count : n;
  console.log(`${String(count).padStart(5)}  ${m.median.toFixed(2).padStart(7)}  ${m.p95.toFixed(2).padStart(7)}  ${m.max.toFixed(2).padStart(7)}  ${phases}`);
  if (m.p95 > BUDGET) { firstBust = count; break; }
  if (count >= MAX) break;
  n += INCR;
}
console.log(firstBust > 0
  ? `knee: p95>${BUDGET}ms at ${firstBust} ${KIND} — last good level is one step below`
  : `no knee: ${KIND} held under ${BUDGET}ms through ${MAX}`);
