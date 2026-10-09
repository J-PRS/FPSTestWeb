// Scratch: balls-only behavior census — runs the REAL server BallSim on a
// real map heightfield with one pinned player as the spawn/rage anchor and
// reports per-variant speed + height-over-terrain stats over a sim window.
//   bun tests/scenarios/_ballstat.ts [seconds] [map]
import { mkRoom, step, pin } from './harness.ts';
import { hmParseBin, hmHeight } from '../../../shared/heightfield.ts';
import { BALL_GRAVITY } from '../../../shared/ballSim.ts';
import { join } from 'node:path';

const SECONDS = Number(process.argv[2] ?? 120);
const MAP = process.argv[3] ?? 'nugwar';

const room = mkRoom({ mode: 'dm', bots: 1, balls: { base: 40, perPlayer: 0, max: 50 } }, 'dm', 1337);
const buf = new Uint8Array(await Bun.file(join(import.meta.dir, '..', '..', '..', 'maps', `${MAP}.bin`)).arrayBuffer());
const field = hmParseBin(buf);
room.field = field;
room.ballSim.attachField(field);
const p = [...room.players.getAllPlayers().values()][0]!;
pin(room, p.id, { x: 0, y: 40, z: 0 });

// Per-variant accumulators; 'air' = above 0.5m over terrain, mirroring how
// flight reads in-game.
type Acc = { n: number; spd: number; spdMax: number; spdSum: number; hSum: number; hMax: number; airN: number; enrN: number };
const acc = new Map<number, Acc>();
const a = (v: number): Acc => {
  let r = acc.get(v);
  if (!r) { r = { n: 0, spd: 0, spdMax: 0, spdSum: 0, hSum: 0, hMax: 0, airN: 0, enrN: 0 }; acc.set(v, r); }
  return r;
};

let peakSpd = 0, peakSpdT = 0, peakH = 0, peakHT = 0;
// Teleport census: a >20m position jump in one tick is a teleport (no
// ballistic arc crosses that at 20Hz). Pre-speed vs post-speed checks
// magnitude preservation; clearance = y - radius - ground at landing.
const prev = new Map<number, { x: number; y: number; z: number; spd: number; clr: number }>();
const teles: { pre: number; post: number; clr: number; jump: number; v: number; dKE: number; kind: string }[] = [];
// Energy ledger (per unit mass): E = ½v² + g·h conserves during free
// flight. Expected discontinuities only — teleport resets PE (position
// jump, KE preserved), bounce scales KE by elasticity², enrage injects.
const G = Math.abs(BALL_GRAVITY);
const energy = (b: { vx: number; vy: number; vz: number; y: number; x: number; z: number }) =>
  0.5 * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz) + G * b.y; // PE is absolute — terrain-relative would leak g·Δground as fake drift
const prevE = new Map<number, number>();
let eDriftMax = 0; // worst free-flight drift observed
let eDriftAt = 0;
// Attribute every state change to its wire event: wrap segment() so the
// ledger can exempt event ticks instead of jump-guessing teleports.
const segTick = new Map<number, string>();
const segLog: { id: number; kind: string; t: number }[] = [];
const bs = room.ballSim as unknown as { segment(b: { id: number }, kind: string): void };
const origSeg = bs.segment.bind(room.ballSim);
bs.segment = (b, kind) => { segTick.set(b.id, kind); segLog.push({ id: b.id, kind, t }); origSeg(b, kind); };
let t = 0;
const TICKS = Math.round(SECONDS / 0.05);
for (let i = 0; i < TICKS; i++) {
  step(room, 1);
  t += 0.05;
  for (const b of room.ballSim.balls.values()) {
    const p0 = prev.get(b.id);
    const spdNow = Math.hypot(b.vx, b.vy, b.vz);
    const eNow = energy(b);
    const hNow = b.y - b.radius - hmHeight(field, b.x, b.z);
    if (p0) {
      const jump = Math.hypot(b.x - p0.x, b.y - p0.y, b.z - p0.z);
      if (jump > 20) {
        teles.push({ pre: p0.spd, post: spdNow, clr: hNow, jump, v: b.variant, dKE: 0.5 * (spdNow * spdNow - p0.spd * p0.spd), kind: segTick.get(b.id) ?? '?' });
      } else if (hNow > 0.5 && p0.clr > 0.5 && !b.enraged && !segTick.has(b.id)) {
        // True quiet flight — no event this tick. E may only drift via
        // integrator error; anything else is an untracked energy leak.
        const d = Math.abs(eNow - (prevE.get(b.id) ?? eNow));
        if (d > eDriftMax) { eDriftMax = d; eDriftAt = t; }
      }
    }
    prev.set(b.id, { x: b.x, y: b.y, z: b.z, spd: spdNow, clr: hNow });
    prevE.set(b.id, eNow);
    if (b.dead) continue;
    const r = a(b.variant);
    const spd = Math.hypot(b.vx, b.vy, b.vz);
    const h = b.y - hmHeight(field, b.x, b.z);
    r.n++; r.spdSum += spd; r.hSum += Math.max(0, h);
    if (spd > r.spdMax) r.spdMax = spd;
    if (h > r.hMax) r.hMax = h;
    if (h > 0.5) r.airN++;
    if (b.enraged) r.enrN++;
    if (spd > peakSpd) { peakSpd = spd; peakSpdT = t; }
    if (h > peakH) { peakH = h; peakHT = t; }
  }
  segTick.clear();
}

console.log(`balls=${room.ballSim.balls.size} sim=${SECONDS}s map=${MAP}`);
for (const [v, r] of [...acc.entries()].sort()) {
  console.log(`variant${v}: n=${r.n} avgSpd=${(r.spdSum / r.n).toFixed(1)} peakSpd=${r.spdMax.toFixed(1)} avgH=${(r.hSum / r.n).toFixed(1)} peakH=${r.hMax.toFixed(1)} air=${(100 * r.airN / r.n).toFixed(1)}% enraged=${(100 * r.enrN / r.n).toFixed(1)}%`);
}
console.log(`global peakSpd=${peakSpd.toFixed(1)} @t${peakSpdT.toFixed(1)} peakH=${peakH.toFixed(1)} @t${peakHT.toFixed(1)}`);
if (teles.length) {
  const drift = teles.map(e => e.post - e.pre);
  const clrs = teles.map(e => e.clr);
  const dKE = teles.map(e => e.dKE);
  console.log(`teleports=${teles.length} drift=[${Math.min(...drift).toFixed(2)}..${Math.max(...drift).toFixed(2)}] clr=[${Math.min(...clrs).toFixed(3)}..${Math.max(...clrs).toFixed(3)}] dKE=[${Math.min(...dKE).toFixed(1)}..${Math.max(...dKE).toFixed(1)}]`);
  for (const e of teles.slice(0, 8)) console.log(`  v${e.v} kind=${e.kind} jump=${e.jump.toFixed(0)}m pre=${e.pre.toFixed(1)} post=${e.post.toFixed(1)} clr=${e.clr.toFixed(3)}`);
} else {
  console.log('teleports=0 (none fired in window)');
}
const segKinds = new Map<string, number>();
for (const s of segLog) segKinds.set(s.kind, (segKinds.get(s.kind) ?? 0) + 1);
console.log(`segments=${segLog.length} byKind=${[...segKinds.entries()].map(([k, n]) => `${k}:${n}`).join(' ')}`);
console.log(`free-flight E drift max=${eDriftMax.toFixed(3)} J/kg @t${eDriftAt.toFixed(1)}`);
