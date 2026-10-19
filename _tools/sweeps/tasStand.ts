// TAS stand leg — same reachability BFS as devin_scratch/.devin_tas.ts,
// pointed at real CTF legs: alpha base -> bravo stand (and back). The hit
// test IS the flag grab: planar <=6m and |y - standY| <=6, matching
// RoomFlags' touch capsule. Reports speed AT the grab instant = the
// provable grabV for that stand under the stock jet economy.
//
//   cd server_bun && bun ../_tools/sweeps/tasStand.ts --map katabatic
//   env: TAS_BEAM, TAS_SEEN, TAS_WALL (s), TAS_MAXT (s), TAS_DYAW, TAS_JETS
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, hmSurface } from '../../shared/heightfield.ts';
import { MoveSim } from '../../shared/movement.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1]! : d; };
const MAP = arg('map', 'katabatic');
const spec = JSON.parse(readFileSync(resolve(import.meta.dir, `../../maps/${MAP}.json`), 'utf8'));
const f = hmParseBin(new Uint8Array(readFileSync(resolve(import.meta.dir, `../../maps/${spec.terrain}`))));
const surface = hmSurface(f) as any;
const at = (x: number, z: number) => ({ x, y: hmHeight(f, x, z), z });
const STANDS = { alpha: at(spec.bases.alpha.x, spec.bases.alpha.z), bravo: at(spec.bases.bravo.x, spec.bases.bravo.z) };

const DRAIN = 15, REGEN = 8, EMAX = 60, ELOCK = 8;   // stock economy (see CAPPER_STRIKE physics table)
const JETS = process.env.TAS_JETS !== '0';
const STEP_S = 0.15, TICKS = 9;
const DYAW = Number(process.env.TAS_DYAW ?? 0.05);
const MAXT = Number(process.env.TAS_MAXT ?? 120);
const MAX_ALIVE = Number(process.env.TAS_BEAM ?? 3_000);
const MAX_SEEN = Number(process.env.TAS_SEEN ?? 1_500_000);

interface Node {
  sim: MoveSim | null; e: number; t: number; parent: number;
  sample: { x: number; z: number; v: number; j: number; agl: number; e: number; g: boolean; yaw: number };
}
const q = (n: number, s: number) => Math.round(n / s);
function key(n: Node): number {
  const s = n.sim!.state;
  let h = (q(s.pos.x, 4) * 73856093) ^ (q(s.pos.z, 4) * 19349663) ^ (q(s.pos.y, 4) * 83492791)
    ^ (q(s.vel.x, 4) * 297121507) ^ (q(s.vel.z, 4) * 433) ^ (q(s.vel.y, 4) * 16127)
    ^ (q(n.e, 5) * 991) ^ (q(s.yaw, 0.1) * 13) ^ (s.onGround ? 1 : 0);
  return h | 0;
}
function cloneSim(m: MoveSim): MoveSim {
  const s = new MoveSim(surface, JSON.parse(JSON.stringify(m.state)));
  (s as any).acc = 0;
  return s;
}

function runLeg(A: { x: number; y: number; z: number }, B: { x: number; y: number; z: number }) {
  const yaw0 = Math.atan2(B.x - A.x, B.z - A.z);
  const arena: Node[] = [];
  const root: Node = {
    sim: new MoveSim(surface, { pos: { x: A.x, y: A.y + 1.8, z: A.z }, vel: { x: 0, y: 0, z: 0 }, yaw: yaw0, pitch: 0, onGround: true }),
    e: EMAX, t: 0, parent: -1,
    sample: { x: A.x, z: A.z, v: 0, j: 0, agl: 1.8, e: EMAX, g: true, yaw: yaw0 },
  };
  arena.push(root);
  let frontier = [0];
  const seen = new Set([key(root)]);
  let bestIdx = 0, bestDist = Math.hypot(B.x - A.x, B.z - A.z), bestV = 0;
  let flyV = 0, flyDy = 0;
  const t0 = Date.now();
  const wallCap = Number(process.env.TAS_WALL ?? 0) * 1000;
  for (let step = 0; step < MAXT / STEP_S; step++) {
    if (wallCap && Date.now() - t0 > wallCap) { console.log(`  [wall ${wallCap / 1000}s]`); break; }
    if (step % 40 === 0) {
      let best = 1e9;
      for (const ni of frontier) { const d = Math.hypot(B.x - arena[ni]!.sample.x, B.z - arena[ni]!.sample.z); if (d < best) { best = d; } }
      console.log(`  [t=${(step * STEP_S).toFixed(0)}s alive=${frontier.length} seen=${seen.size} goalDist=${best.toFixed(0)}m]`);
    }
    const next: number[] = [];
    for (const ni of frontier) {
      const n = arena[ni]!;
      for (const dOff of [-DYAW, 0, DYAW]) {
        for (const jet of JETS ? [0, 1] : [0]) {
          if (jet && n.e < ELOCK) { continue; }
          const sim = cloneSim(n.sim!);
          sim.state.yaw += dOff;
          sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet === 1 });
          let hitV = -1;
          for (let t = 0; t < TICKS; t++) {
            sim.update(1 / 60);
            const sp = sim.state.pos;
            // The grab capsule: planar <=6m and within 6m of stand height.
            if (Math.hypot(B.x - sp.x, B.z - sp.z) <= 6 && Math.abs(sp.y - B.y) <= 6) {
              hitV = Math.hypot(sim.state.vel.x, sim.state.vel.z);
              break;
            }
          }
          const e = Math.min(EMAX, n.e + (jet ? -DRAIN * STEP_S : REGEN * STEP_S));
          const s = sim.state;
          const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
          const child: Node = {
            sim, e, t: n.t + STEP_S, parent: ni,
            sample: { x: s.pos.x, z: s.pos.z, v, j: jet, agl: s.pos.y - hmHeight(f, s.pos.x, s.pos.z), e, g: s.onGround, yaw: s.yaw },
          };
          if (hitV >= 0) { arena.push(child); return { t: child.t, grabV: hitV, arena }; }
          const d = Math.hypot(B.x - s.pos.x, B.z - s.pos.z);
          // Near-miss telemetry: the fastest pass inside 12m planar —
          // speed through the ring even if the vertical cap missed.
          if (d <= 12) { const vh = Math.hypot(s.vel.x, s.vel.z); if (vh > flyV) { flyV = vh; flyDy = s.pos.y - B.y; } }
          if (seen.size >= MAX_SEEN) { continue; }
          const k = key(child);
          if (seen.has(k)) { continue; }
          seen.add(k);
          arena.push(child);
          next.push(arena.length - 1);
          if (d < bestDist || (Math.abs(d - bestDist) < 10 && v > bestV)) { bestDist = Math.min(d, bestDist); bestIdx = arena.length - 1; bestV = v; }
        }
      }
      n.sim = null;
    }
    if (next.length > MAX_ALIVE) {
      next.sort((a, b) => {
        const sa = arena[a]!.sample, sb = arena[b]!.sample;
        return (Math.hypot(B.x - sa.x, B.z - sa.z) - sa.v * 3) - (Math.hypot(B.x - sb.x, B.z - sb.z) - sb.v * 3);
      });
      next.length = MAX_ALIVE;
    }
    frontier = next;
    if (!frontier.length) { break; }
  }
  return { t: -1, grabV: -1, arena, bestIdx, bestDist, flyV, flyDy };
}

const report = (label: string, r: ReturnType<typeof runLeg>) => {
  if (r.grabV < 0) { console.log(`  ${label}: NO GRAB in ${MAXT}s (closest ${r.bestDist?.toFixed(0)}m; fastest flyby ${r.flyV?.toFixed(1)} m/s at dy=${r.flyDy?.toFixed(1)})`); return; }
  const path = [] as Node['sample'][];
  for (let cur = r.arena.length - 1; cur >= 0; cur = r.arena[cur]!.parent) { path.unshift(r.arena[cur]!.sample); }
  const vAvg = path.reduce((s, p) => s + p.v, 0) / path.length;
  const vMax = Math.max(...path.map(p => p.v));
  const jetPct = (path.filter(p => p.j).length / path.length) * 100;
  const skiPct = (path.filter(p => p.g).length / path.length) * 100;
  console.log(`  ${label}: grab at t=${r.t.toFixed(1)}s grabV=${r.grabV.toFixed(1)} m/s  vAvg=${vAvg.toFixed(1)} vMax=${vMax.toFixed(1)} ski%=${skiPct.toFixed(0)} jet%=${jetPct.toFixed(0)}`);
};

// --straight: no search at all — one rollout per bearing: spawn on the
// --dist ring, hold forward+ski(+jets) straight at the flag. Answers
// "what's possible without turning" in milliseconds. TAS_JETS=0 = pure
// gravity ski.
const STRAIGHT = process.argv.includes('--straight');
if (STRAIGHT) {
  const B = STANDS[arg('stand', 'bravo') as 'alpha' | 'bravo'];
  const D = Number(arg('dist', '250'));
  const N = Number(arg('sweep', '12')) || 12;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const Ax = B.x + Math.sin(th) * D, Az = B.z + Math.cos(th) * D;
    const A = at(Ax, Az);
    const yaw = Math.atan2(B.x - Ax, B.z - Az);
    const sim = new MoveSim(surface, { pos: { x: A.x, y: A.y + 1.8, z: A.z }, vel: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, onGround: true });
    let e = EMAX, grabV = -1, vMax = 0, flyV = 0, flyDy = 0, bestD = 1e9;
    for (let s = 0; s < MAXT * 60; s++) {
      const jet = JETS && e > ELOCK;
      sim.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet });
      sim.update(1 / 60);
      e = Math.min(EMAX, e + (jet ? -DRAIN : REGEN) / 60);
      const p = sim.state.pos, v = Math.hypot(sim.state.vel.x, sim.state.vel.z);
      vMax = Math.max(vMax, v);
      const d = Math.hypot(B.x - p.x, B.z - p.z);
      bestD = Math.min(bestD, d);
      if (d <= 12 && v > flyV) { flyV = v; flyDy = p.y - B.y; }
      if (d <= 6 && Math.abs(p.y - B.y) <= 6) { grabV = v; break; }
      if (d > D + 400) {break;} // blew past everything — done
    }
    const deg = (th * 180 / Math.PI).toFixed(0);
    if (grabV >= 0) {console.log(`  ${deg}°  start+${(A.y - B.y).toFixed(0)}m: GRAB at ${(sim.state ? 0 : 0)}v=${grabV.toFixed(1)} m/s (vMax=${vMax.toFixed(1)})`);}
    else {console.log(`  ${deg}°  start+${(A.y - B.y).toFixed(0)}m: miss (closest ${bestD.toFixed(0)}m, flyby ${flyV.toFixed(1)} m/s @dy=${flyDy.toFixed(0)}, vMax=${vMax.toFixed(1)})`);}
  }
} else {
const SWEEP = Number(arg('sweep', '0'));
if (SWEEP > 0) {
  const B = STANDS[arg('stand', 'bravo') as 'alpha' | 'bravo'];
  const D = Number(arg('dist', '250'));
  for (let i = 0; i < SWEEP; i++) {
    const th = (i / SWEEP) * Math.PI * 2;
    const Ax = B.x + Math.sin(th) * D, Az = B.z + Math.cos(th) * D;
    const A = at(Ax, Az);
    console.log(`bearing ${(th * 180 / Math.PI).toFixed(0)}° from (${Ax.toFixed(0)},${Az.toFixed(0)}) start h=${A.y.toFixed(0)} → stand h=${B.y.toFixed(0)} (Δ=${(A.y - B.y).toFixed(0)}m):`);
    report(`${(th * 180 / Math.PI).toFixed(0)}°`, runLeg(A, B));
  }
} else {
  for (const [a, b] of [['alpha', 'bravo'], ['bravo', 'alpha']] as const) {
    const A = STANDS[a], B = STANDS[b];
    console.log(`searching ${a}->${b} (${Math.hypot(B.x - A.x, B.z - A.z).toFixed(0)}m)...`);
    report(`${a}->${b}`, runLeg(A, B));
  }
}
}
