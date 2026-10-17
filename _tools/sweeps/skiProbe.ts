/**
 * skiProbe.ts — "does the terrain ski?"  Drop N frictionless balls
 * (MoveSim with skiHeld — friction off above walk speed, inelastic
 * landings = 0% bounce) at uniform random spots and measure what the
 * heightfield alone produces: peak speeds, travel distance, airtime,
 * time-to-rest, and how hard the ground hits back (landingImpact >=
 * fallDamageMinSpeed = a splat a real skier would pay).
 *
 *   bun _tools/sweeps/skiProbe.ts                    # every playable map
 *   bun _tools/sweeps/skiProbe.ts --map dunes        # one map
 *   bun _tools/sweeps/skiProbe.ts --balls 500 --secs 120 --seed 7
 *
 * Read it: %>40 is the ski line (peak horizontal speed above real-ski
 * pace), still% = balls still rolling at the cap (frictionless loops —
 * good if they cross ground, bad if they're trapped oscillating in one
 * bowl), splat% = drops that hit hard enough to charge fall damage —
 * fast terrain that kills you is the katabatic failure mode.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hmParseBin, hmHeight, hmSurface } from '../../shared/heightfield.ts';
import { MoveSim, MOVEMENT_CONFIG } from '../../shared/movement.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};

const BALLS = Number(arg('balls', '256'));
const SECS = Number(arg('secs', '90'));
const SEED = Number(arg('seed', '1'));
const MAP = arg('map', '');
const REST_SPEED = 1.5;   // m/s h-speed = "stopped"
const REST_HOLD = 1.0;    // sustained seconds under REST_SPEED = rested

// Deterministic PRNG — same seed = same drop pattern across runs.
function mulberry32(a: number): () => number {
  let s = a | 0;
  return () => {
    s = (s + 0x6D_2B_79_F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAPS_DIR = resolve(import.meta.dir, '../../maps');
const names: string[] = [];
for (const f of readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json') && f !== 'rotation.json').sort()) {
  const name = f.replace('.json', '');
  if (MAP && name !== MAP) {continue;}
  const j = JSON.parse(readFileSync(resolve(MAPS_DIR, f), 'utf8')) as { _t2?: string; hidden?: boolean; terrain?: string };
  if (!j._t2 && j.hidden !== true) {names.push(name);}
}

interface Ball {
  sim: MoveSim;
  peakH: number;
  peakV: number;
  dist: number;
  air: number;
  moving: number;
  lowT: number;
  rested: boolean;
  restX: number; restZ: number;
  maxImpact: number;
  splats: number;
}

function runMap(name: string): void {
  const spec = JSON.parse(readFileSync(resolve(MAPS_DIR, `${name}.json`), 'utf8')) as {
    terrain?: string; heightScale?: number; tileSize?: number;
  };
  const field = hmParseBin(
    new Uint8Array(readFileSync(resolve(MAPS_DIR, spec.terrain ?? `${name}.bin`))),
    spec.heightScale ?? 1, spec.tileSize,
  );
  const surf = hmSurface(field);
  const span = field.worldScale ?? 1500;
  const rng = mulberry32(SEED);
  const balls: Ball[] = [];
  for (let i = 0; i < BALLS; i += 1) {
    const x = (rng() - 0.5) * span, z = (rng() - 0.5) * span;
    const sim = new MoveSim(surf, {
      pos: { x, y: hmHeight(field, x, z) + 0.4, z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, onGround: true,
    });
    sim.setInput({ skiHeld: true });            // the ice cube
    sim.eyeHeight = 0.4; sim.bodyRadius = 0.4;  // ball, not a body
    balls.push({ sim, peakH: 0, peakV: 0, dist: 0, air: 0, moving: 0, lowT: 0, rested: false, restX: 0, restZ: 0, maxImpact: 0, splats: 0 });
  }
  const dt = 1 / 30;
  for (let t = 0; t < SECS; t += dt) {
    let live = 0;
    for (const b of balls) {
      if (b.rested) {continue;}
      b.sim.update(dt);
      const s = b.sim.state;
      const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
      const hv = Math.hypot(s.vel.x, s.vel.z);
      if (!Number.isFinite(v) || !Number.isFinite(s.pos.x + s.pos.y + s.pos.z)) { b.rested = true; b.restX = s.pos.x; b.restZ = s.pos.z; continue; }
      b.peakV = Math.max(b.peakV, v);
      b.peakH = Math.max(b.peakH, hv);
      b.dist += v * dt;
      if (!s.onGround) {b.air += dt;}
      if (hv > REST_SPEED) { b.moving += dt; b.lowT = 0; }
      else { b.lowT += dt; if (b.lowT >= REST_HOLD) { b.rested = true; b.restX = s.pos.x; b.restZ = s.pos.z; continue; } }
      const imp = b.sim.landingImpact;
      if (imp > 0) {
        b.maxImpact = Math.max(b.maxImpact, imp);
        if (imp >= MOVEMENT_CONFIG.fallDamageMinSpeed) {b.splats += 1;}
      }
      live += 1;
    }
    if (live === 0) {break;}
  }
  // Basin concentration: modal rest cell at 100m grid — high share = the
  // map funnels everyone to one pocket (loot floor / death bowl).
  const cells = new Map<string, number>();
  let rested = 0, splatters = 0, airSum = 0;
  const peaks: number[] = [], dists: number[] = [], moves: number[] = [];
  for (const b of balls) {
    peaks.push(b.peakH); dists.push(b.dist); moves.push(b.moving);
    airSum += b.air;
    if (b.maxImpact >= MOVEMENT_CONFIG.fallDamageMinSpeed) {splatters += 1;}
    if (b.rested) {
      rested += 1;
      const k = `${Math.round(b.restX / 100)},${Math.round(b.restZ / 100)}`;
      cells.set(k, (cells.get(k) ?? 0) + 1);
    }
  }
  peaks.sort((a, b2) => a - b2); dists.sort((a, b2) => a - b2); moves.sort((a, b2) => a - b2);
  const med = (a: number[]): number => a[Math.floor(a.length / 2)]!;
  const p90 = (a: number[]): number => a[Math.floor(a.length * 0.9)]!;
  const pct = (n: number): string => `${Math.round((n / BALLS) * 100)}%`;
  const top = Math.max(0, ...cells.values());
  console.log(
    `${name.padEnd(22)} ` +
    `>25:${pct(peaks.filter((v) => v >= 25).length).padStart(5)} ` +
    `>40:${pct(peaks.filter((v) => v >= 40).length).padStart(5)} ` +
    `>80:${pct(peaks.filter((v) => v >= 80).length).padStart(5)} ` +
    `medPk:${med(peaks).toFixed(0).padStart(4)} p90:${p90(peaks).toFixed(0).padStart(4)} ` +
    `dist:${med(dists).toFixed(0).padStart(5)}/${p90(dists).toFixed(0).padStart(5)}m ` +
    `move:${med(moves).toFixed(0).padStart(3)}s air:${(airSum / BALLS).toFixed(1).padStart(4)}s ` +
    `still:${pct(BALLS - rested).padStart(5)} splat:${pct(splatters).padStart(5)} ` +
    `basin:${rested ? Math.round((top / rested) * 100) : 0}%`,
  );
}

console.log(`skiProbe — ${BALLS} frictionless balls, ${SECS}s cap, seed ${SEED}, dt 1/30`);
for (const n of names) {
  try { runMap(n); } catch (e) { console.log(`${n.padEnd(22)} FAILED ${(e as Error).message}`); }
}
