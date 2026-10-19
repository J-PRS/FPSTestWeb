// TAS speed probe — beam search that maximizes |v|, no destination.
// The question: what does this map's terrain + the stock jet economy
// actually let a skier reach, free to carve? Scores nodes on speed
// alone and keeps position diversity in the beam so the search doesn't
// collapse into one fast corridor — a speed trap that locks early
// dominates a slow-building line otherwise.
//
//   cd server_bun && bun ../_tools/sweeps/tasSpeed.ts --map peaks
//   env: TAS_MAXT (s, default 45), TAS_BEAM (alive nodes), TAS_SEEN,
//        TAS_JETS=0 (pure gravity — no burn nodes), TAS_SPREAD (yaw fan)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, hmSurface } from '../../shared/heightfield.ts';
import { MoveSim } from '../../shared/movement.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const MAP = arg('map', 'peaks');
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))), spec.heightScale ?? 1, spec.tileSize);
const surface = hmSurface(f) as any;

// Start: highest terrain on the map (that's where the energy lives) —
// --start x,z overrides.
let sx = Number(arg('sx', 'NaN')), sz = Number(arg('sz', 'NaN'));
if (!Number.isFinite(sx)) {
  let best = -1e9;
  // Heightfield extent — scan a coarse grid for the peak.
  const ext = f.worldScale ?? 1500;
  for (let x = -ext / 2; x <= ext / 2; x += 20) {
    for (let z = -ext / 2; z <= ext / 2; z += 20) {
      const h = hmHeight(f, x, z);
      if (h > best) { best = h; sx = x; sz = z; }
    }
  }
}
const startY = hmHeight(f, sx, sz);
console.log(`${MAP}: start (${sx.toFixed(0)},${sz.toFixed(0)}) h=${startY.toFixed(0)}`);

const DRAIN = 15, REGEN = 8, EMAX = 60, ELOCK = 8;
const JETS = process.env.TAS_JETS !== '0';
const STEP_S = 0.15, TICKS = 9;
const MAXT = Number(process.env.TAS_MAXT ?? 45);
const MAX_ALIVE = Number(process.env.TAS_BEAM ?? 2_000);
const MAX_SEEN = Number(process.env.TAS_SEEN ?? 800_000);
// Yaw fan — wide: carving IS the speed mechanism (a descending traverse
// converts v down the fall line, then carves it forward).
const SPREAD = Number(process.env.TAS_SPREAD ?? 0.4);
const DYAWS = [-SPREAD, -SPREAD / 2, -SPREAD / 6, 0, SPREAD / 6, SPREAD / 2, SPREAD];

interface Node {
  sim: MoveSim | null; e: number; t: number; parent: number;
  v: number; x: number; z: number; y: number; j: number; g: boolean;
}
const q = (n: number, s: number) => Math.round(n / s);
function key(n: Node): number {
  const s = n.sim!.state;
  return ((q(s.pos.x, 6) * 73856093) ^ (q(s.pos.z, 6) * 19349663) ^ (q(s.pos.y, 6) * 83492791)
    ^ (q(s.vel.x, 5) * 297121507) ^ (q(s.vel.z, 5) * 433) ^ (q(s.vel.y, 5) * 16127)
    ^ (q(n.e, 5) * 991) ^ (s.onGround ? 1 : 0)) | 0;
}
function cloneSim(m: MoveSim): MoveSim {
  const s = new MoveSim(surface, JSON.parse(JSON.stringify(m.state)));
  (s as any).acc = 0;
  return s;
}

const arena: Node[] = [];
const root: Node = {
  sim: new MoveSim(surface, { pos: { x: sx, y: startY + 1.8, z: sz }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true }),
  e: EMAX, t: 0, parent: -1, v: 0, x: sx, z: sz, y: startY, j: 0, g: true,
};
arena.push(root);
let frontier = [0];
const seen = new Set([key(root)]);
let bestIdx = 0;

for (let step = 0; step < MAXT / STEP_S; step++) {
  if (step % 40 === 0) {
    let v = 0; for (const ni of frontier) { v = Math.max(v, arena[ni]!.v); }
    console.log(`  [t=${(step * STEP_S).toFixed(0)}s alive=${frontier.length} seen=${seen.size} frontierVmax=${v.toFixed(1)} allTimeVmax=${arena[bestIdx]!.v.toFixed(1)}]`);
  }
  const next: number[] = [];
  for (const ni of frontier) {
    const n = arena[ni]!;
    for (const dy of DYAWS) {
      for (const jet of JETS ? [0, 1] : [0]) {
        if (jet && n.e < ELOCK) { continue; }
        const sim = cloneSim(n.sim!);
        sim.state.yaw += dy;
        sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet === 1 });
        for (let t = 0; t < TICKS; t++) { sim.update(1 / 60); }
        const e = Math.min(EMAX, n.e + (jet ? -DRAIN * STEP_S : REGEN * STEP_S));
        const s = sim.state;
        const child: Node = {
          sim, e, t: n.t + STEP_S, parent: ni,
          v: Math.hypot(s.vel.x, s.vel.y, s.vel.z), x: s.pos.x, z: s.pos.z, y: s.pos.y,
          j: jet, g: s.onGround,
        };
        if (seen.size < MAX_SEEN) {
          const k = key(child);
          if (!seen.has(k)) { seen.add(k); arena.push(child); next.push(arena.length - 1); }
        }
      }
    }
    n.sim = null;
  }
  if (next.length > MAX_ALIVE) {
    // Keep the fastest quarter + position-diverse rest: sort by v, then
    // greedily prefer nodes not standing on a kept sibling.
    next.sort((a, b) => arena[b]!.v - arena[a]!.v);
    const kept = next.slice(0, MAX_ALIVE / 2);
    const cells = new Set(kept.map(i => `${q(arena[i]!.x, 40)},${q(arena[i]!.z, 40)}`));
    for (const i of next.slice(MAX_ALIVE / 2)) {
      if (kept.length >= MAX_ALIVE) {break;}
      const c = `${q(arena[i]!.x, 40)},${q(arena[i]!.z, 40)}`;
      if (!cells.has(c)) { cells.add(c); kept.push(i); }
    }
    next.length = 0;
    next.push(...kept);
  }
  for (const i of frontier.concat(next)) { if (arena[i]!.v > arena[bestIdx]!.v) {bestIdx = i;} }
  frontier = next;
  if (!frontier.length) {break;}
}

// Replay the winner's lineage.
const path: Node[] = [];
for (let cur = bestIdx; cur >= 0; cur = arena[cur]!.parent) { path.unshift(arena[cur]!); }
const best = arena[bestIdx]!;
console.log(`\nVmax ${best.v.toFixed(1)} m/s at t=${best.t.toFixed(1)}s pos=(${best.x.toFixed(0)},${best.y.toFixed(0)},${best.z.toFixed(0)})`);
console.log('trace (t, pos, v, ground, jet, E):');
for (const p of path) {
  if (Math.round(p.t * 10) % 15 !== 0) {continue;}
  console.log(`  t=${p.t.toFixed(1)} (${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) v=${p.v.toFixed(1)} ${p.g ? 'GND' : 'AIR'} j=${p.j} E=${p.e.toFixed(0)}`);
}
