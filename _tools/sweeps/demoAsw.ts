// demoAsw.ts — locomotion autopsy for a .demo file: asw buckets,
// speed/altitude percentiles, energy profile, jet-burn segmentation
// (when do burns start: grounded-launch vs airborne, duration, what
// buys altitude), and the ascend/glide cycle structure.
// Usage: bun _tools/sweeps/demoAsw.ts <file.demo>
import { readFileSync } from 'node:fs';
import { deserializeDemo } from '../../client/src/demo/demoReader.js';
import { hmapToField } from '../../client/src/demo/demoHmap.js';
import { hmHeight } from '../../shared/heightfield.ts';

const file = process.argv[2]!;
const demo = deserializeDemo(readFileSync(file).buffer as ArrayBuffer);
const field = demo.heightmap ? hmapToField(demo.heightmap) : null;
const ground = (x: number, z: number): number => (field ? hmHeight(field, x, z) : 0);

const frames = demo.frames;
const SKI = 32, JUMP = 16;
const asw = { ha: 0, a: 0, s: 0, w: 0, st: 0, i: 0 };
let skiTicks = 0;
const speeds: number[] = [], alts: number[] = [], fuels: number[] = [];
let mechSum = 0;
const G = 28;

// ---- jet-burn segmentation ----
// Jet on = fuel dropping. Segment contiguous burns; record: start alt,
// was the bot airborne at start, did a jump edge fire within 0.4s
// before start, burn duration, alt gained during burn.
interface Burn { t0: number; dur: number; alt0: number; altGain: number; grounded: boolean; jumpFirst: boolean; peak: number }
const burns: Burn[] = [];
let cur: Burn | null = null;
let lastJumpT = -9;
let lastGroundedT = -9;
let peak = 0;
// Flight-phase buckets: ascending / descending / grounded-second splits
let asc = 0, desc = 0, gnd = 0;
let descJet = 0, ascJet = 0, descNoJet = 0, ascNoJet = 0;
let launchVySum = 0, launchN = 0;

for (let i = 0; i < frames.length; i += 1) {
  const f = frames[i]!;
  const g = ground(f.posX, f.posZ);
  const alt = f.posY - g;
  const speed = Math.hypot(f.velX, f.velZ);
  const skiing = (f.inputFlags & SKI) !== 0;
  const fuelDrop = i > 0 ? fuels[i - 1]! - f.jetpackFuel : 0;
  const jetting = fuelDrop > 0.005;
  const airborne = alt > 0.8;
  if ((f.inputFlags & JUMP) !== 0) {lastJumpT = f.timestamp;}
  if (!airborne) {lastGroundedT = f.timestamp; gnd += 1;}
  else if (f.velY > 0.5) {asc += 1; if (jetting) {ascJet += 1;} else {ascNoJet += 1;}}
  else {desc += 1; if (jetting) {descJet += 1;} else {descNoJet += 1;}}

  asw[airborne ? (alt > 5 ? 'ha' : 'a') : speed < 1 ? 'i' : speed < 5 ? 'st' : skiing ? 's' : 'w'] += 1;
  if (skiing) {skiTicks += 1;}
  speeds.push(speed); alts.push(alt); fuels.push(f.jetpackFuel);
  mechSum += 0.5 * (f.velX ** 2 + f.velY ** 2 + f.velZ ** 2) + G * Math.max(0, alt);
  peak = Math.max(peak, alt);

  if (jetting && !cur) {
    cur = { t0: f.timestamp, dur: 0, alt0: alt, altGain: 0, grounded: !airborne,
      jumpFirst: f.timestamp - lastJumpT < 0.4 || f.timestamp - lastGroundedT < 0.4, peak: alt };
    if (f.velY > 2) {launchVySum += f.velY; launchN += 1;}
  } else if (jetting && cur) {
    cur.dur = f.timestamp - cur.t0;
    cur.altGain = Math.max(cur.altGain, alt - cur.alt0);
    cur.peak = Math.max(cur.peak, alt);
  } else if (!jetting && cur) {
    if (cur.dur > 0.15) {burns.push(cur);}
    cur = null;
  }
}
if (cur && cur.dur > 0.15) {burns.push(cur);}

const n = frames.length || 1;
const pct = (v: number): string => `${(v / n * 100).toFixed(1)}%`;
const q = (arr: number[], p: number): number => [...arr].toSorted((a, b) => a - b)[Math.floor(p * (arr.length - 1))]!;
console.log(`frames=${n} dur=${(frames[n - 1]?.timestamp ?? 0).toFixed(1)}s map=${demo.header?.mapName ?? '-'}`);
console.log(`asw: ha ${pct(asw.ha)} a ${pct(asw.a)} s ${pct(asw.s)} w ${pct(asw.w)} st ${pct(asw.st)} i ${pct(asw.i)}  (air ${((asw.ha + asw.a) / n * 100).toFixed(1)}%)`);
console.log(`speed m/s: p50 ${q(speeds, 0.5).toFixed(1)} p90 ${q(speeds, 0.9).toFixed(1)} max ${Math.max(...speeds).toFixed(1)}`);
console.log(`alt m:     p50 ${q(alts, 0.5).toFixed(1)} p90 ${q(alts, 0.9).toFixed(1)} max ${Math.max(...alts).toFixed(1)}`);
console.log(`fuel: mean ${(fuels.reduce((a, b) => a + b, 0) / n).toFixed(1)} ski ${(skiTicks / n * 100).toFixed(1)}%`);
console.log(`mech E: mean ${(mechSum / n).toFixed(0)} J/kg`);
console.log(`phases: asc ${(asc / n * 100).toFixed(1)}% (jet ${(ascJet / (asc || 1) * 100).toFixed(0)}%) desc ${(desc / n * 100).toFixed(1)}% (jet ${(descJet / (desc || 1) * 100).toFixed(0)}%) gnd ${(gnd / n * 100).toFixed(1)}%`);
const burnN = burns.length || 1;
console.log(`burns: ${burns.length} over ${(frames[n - 1]?.timestamp ?? 1).toFixed(0)}s = ${(burns.length / ((frames[n - 1]?.timestamp ?? 1) / 60)).toFixed(1)}/min`);
console.log(`  dur: p50 ${q(burns.map((b) => b.dur), 0.5).toFixed(2)}s p90 ${q(burns.map((b) => b.dur), 0.9).toFixed(2)}s`);
console.log(`  launch: grounded ${(burns.filter((b) => b.grounded).length / burnN * 100).toFixed(0)}% jump-first ${(burns.filter((b) => b.jumpFirst).length / burnN * 100).toFixed(0)}% startVy ${(launchVySum / (launchN || 1)).toFixed(1)} m/s`);
console.log(`  alt: start ${q(burns.map((b) => b.alt0), 0.5).toFixed(1)}m gain ${q(burns.map((b) => b.altGain), 0.5).toFixed(1)}m peak ${q(burns.map((b) => b.peak), 0.5).toFixed(1)}m`);
