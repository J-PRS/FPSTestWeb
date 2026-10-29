// simrock.js — Phase 1 of sim-sculpted terrain: ROCKFALL + MASS WASTING.
//   bun _tools/mapbake/simrock.js <in.bin> <out.bin> [opts]
//
// Simulates dropping rocks onto a terrain and letting them carve cirques with
// talus aprons, followed by a mass-wasting pass that sheds material off any
// slope steeper than the angle of repose. This is the "simulate, don't
// sculpt" approach: the terrain emerges from physical processes, not sliders.
//
// The rock is a TOOL that disappears — only the impact scar + debris apron
// remain in the heightmap. Each rock: falls from sky, walks steepest descent
// until it settles, then carves a warped crater (lowered center + raised rim).
// After all rocks: mass-wasting iterates until stable.
//
// Reads sibling <in>.json for heightScale/tileSize; writes same .bin format.
//
// Opts:
//   --rocks=N          number of rocks to drop (default 12)
//   --radius=40        crater radius in meters (default 40)
//   --craterDepth=0.35 depth of crater well in normalized units (default 0.35)
//   --rimRaise=0.15    debris rim raise (default 0.15)
//   --angleOfRepose=33 angle of repose in degrees (default 33)
//   --massWasteIter=200 max mass-wasting iterations (default 200)
//   --massWasteRate=0.04 fraction of excess material moved per pass (default 0.04)
//   --warp=0.3         crater rim warp strength (default 0.3)
//   --seed=7           RNG seed (default 7)
//   --size=513         grid resolution (default: read from input)
const { writeFileSync, readFileSync } = await import('node:fs');
const path = await import('node:path');

const args = process.argv.slice(2);
const inBin = args[0], outBin = args[1];
const opts = {};
for (const a of args.slice(2)) {
  const m = a.match(/^--([\w-]+)=?(.*)$/);
  if (m) { opts[m[1]] = m[2] === '' ? true : m[2]; }
}
if (!inBin || !outBin) { console.error('usage: simrock.js <in.bin> <out.bin> [--rocks=12] [--radius=40] [--seed=7]'); process.exit(1); }

// --- seeded RNG (mulberry32) ---
let rngState = Number(opts.seed ?? 7) | 0;
function rng() { rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0; let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

// --- read input .bin ---
const buf = readFileSync(inBin);
const N = buf.readUInt32LE(0), Nh = buf.readUInt32LE(4);
if (N !== Nh || buf.byteLength !== 8 + N * N) { console.error(`bad input ${inBin}: ${N}x${Nh}`); process.exit(1); }
const data = buf.subarray(8);
let spec = {};
try { spec = JSON.parse(readFileSync(inBin.replace(/\.bin$/, '.json'), 'utf8')); } catch { /* no spec */ }
const hs = spec.heightScale ?? 1;
const tile = spec.tileSize ?? 1500;
const texel = tile / N;
const mPerByte = 125 * hs / 255;

// Convert bytes to normalized 0..1 field
const h = new Float32Array(N * N);
for (let i = 0; i < N * N; i += 1) { h[i] = data[i] / 255; }

// --- noise (deterministic lattice, same as genmap) ---
function lattice(ix, iz, oct) { const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + rngState * 19.3) * 43758.5453; return s - Math.floor(s); }
const fade = (t) => t * t * (3 - 2 * t);
function noise(u, v, cells, oct) {
  const x = u * cells, z = v * cells;
  const x0 = ((Math.floor(x) % cells) + cells) % cells, z0 = ((Math.floor(z) % cells) + cells) % cells;
  const x1 = (x0 + 1) % cells, z1 = (z0 + 1) % cells;
  const fx = fade(x - Math.floor(x)), fz = fade(z - Math.floor(z));
  return lattice(x0, z0, oct) * (1 - fx) * (1 - fz) +
         lattice(x1, z0, oct) * fx * (1 - fz) +
         lattice(x0, z1, oct) * (1 - fx) * fz +
         lattice(x1, z1, oct) * fx * fz;
}
const toroidal = (d, size) => Math.min(d, size - d);

// --- params ---
const numRocks = Number(opts.rocks ?? 12);
const baseRadius = Number(opts.radius ?? 40);
const craterDepth = Number(opts['craterDepth'] ?? 0.35);
const rimRaise = Number(opts['rimRaise'] ?? 0.15);
const angleOfRepose = Number(opts['angleOfRepose'] ?? 33) * Math.PI / 180;
const maxMWIter = Number(opts['massWasteIter'] ?? 200);
const mwRate = Number(opts['massWasteRate'] ?? 0.04);
const warp = Number(opts.warp ?? 0.3);

const tanRepose = Math.tan(angleOfRepose);

// --- helper: height at grid cell (toroidal) ---
function H(x, z) {
  x = ((x % N) + N) % N; z = ((z % N) + N) % N;
  return h[z * N + x];
}
function setH(x, z, val) {
  x = ((x % N) + N) % N; z = ((z % N) + N) % N;
  h[z * N + x] = val;
}

// --- steepest descent: walk downhill until slope < angle of repose ---
function settle(x0, z0) {
  let x = x0, z = z0;
  for (let step = 0; step < 60; step += 1) {
    let bestSlope = 0, bestDx = 0, bestDz = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) { continue; }
        const dist = Math.hypot(dx, dz) * texel;
        const slope = (H(x, z) - H(x + dx, z + dz)) / dist;
        if (slope > bestSlope) { bestSlope = slope; bestDx = dx; bestDz = dz; }
      }
    }
    if (bestSlope <= tanRepose) { break; } // settled
    x += bestDx; z += bestDz;
  }
  return { x: ((x % N) + N) % N, z: ((z % N) + N) % N };
}

// --- carve a crater at (cx, cz) with radius r ---
function carveCrater(cx, cz, r) {
  const rCells = Math.max(2, Math.round(r / texel));
  const sigma = r * 0.35; // debris ring width
  for (let dz = -rCells; dz <= rCells; dz += 1) {
    for (let dx = -rCells; dx <= rCells; dx += 1) {
      const d = Math.hypot(dx, dz) * texel;
      if (d > r * 1.8) { continue; }
      // warp the rim by noise
      const u = (cx + dx) / N, v = (cz + dz) / N;
      const rimWarp = 1 + warp * (noise(u + 1.7, v + 9.2, 3, 7) - 0.5) * 2;
      const rW = r * rimWarp;
      const t = d / rW;
      // smoothstep well
      const wellT = Math.min(1, Math.max(0, 1 - t));
      const well = craterDepth * wellT * wellT * (3 - 2 * wellT);
      // debris ring
      const ringT = Math.min(1, Math.max(0, 1 - Math.abs(d - rW) / (sigma * 2)));
      const ring = rimRaise * ringT * ringT * (3 - 2 * ringT);
      const i = ((cz + dz) % N + N) % N * N + (((cx + dx) % N) + N) % N;
      h[i] = Math.max(0, Math.min(1, h[i] - well + ring));
    }
  }
}

// --- drop rocks ---
console.log(`simrock: dropping ${numRocks} rocks (radius ~${baseRadius}m, seed ${opts.seed ?? 7})`);
for (let i = 0; i < numRocks; i += 1) {
  const rx = Math.floor(rng() * N);
  const rz = Math.floor(rng() * N);
  const r = baseRadius * (0.6 + rng() * 0.8); // 60-140% of base radius
  const depth = craterDepth * (0.7 + rng() * 0.6);
  const rim = rimRaise * (0.7 + rng() * 0.6);
  const settled = settle(rx, rz);
  carveCrater(settled.x, settled.z, r);
  // update the params for the next rock (vary them)
  // (already baked into r/depth/rim above)
}

// --- mass-wasting pass (thermal erosion) ---
console.log(`simrock: mass-wasting (angle of repose ${opts['angleOfRepose'] ?? 33}deg, max ${maxMWIter} iter)`);
let mwIter = 0;
for (let iter = 0; iter < maxMWIter; iter += 1) {
  let changed = false;
  const dh = new Float32Array(N * N); // material moved this pass
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      let bestSlope = 0, bestDx = 0, bestDz = 0;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) { continue; }
          const dist = Math.hypot(dx, dz) * texel;
          const slope = (h[z * N + x] - H(x + dx, z + dz)) / dist;
          if (slope > bestSlope) { bestSlope = slope; bestDx = dx; bestDz = dz; }
        }
      }
      if (bestSlope > tanRepose) {
        const excess = bestSlope - tanRepose;
        const amount = Math.min(mwRate * excess, h[z * N + x] * 0.3);
        if (amount > 1e-6) {
          dh[z * N + x] -= amount;
          dh[((z + bestDz) % N + N) % N * N + (((x + bestDx) % N) + N) % N] += amount;
          changed = true;
        }
      }
    }
  }
  for (let i = 0; i < N * N; i += 1) { h[i] = Math.max(0, Math.min(1, h[i] + dh[i])); }
  mwIter = iter + 1;
  if (!changed) { break; }
}
console.log(`simrock: mass-wasting settled after ${mwIter} passes`);

// --- normalize to full 0..1 range ---
let mn = Infinity, mx = -Infinity;
for (const v of h) { if (v < mn) { mn = v; } if (v > mx) { mx = v; } }
const inv = 1 / Math.max(1e-6, mx - mn);
for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv; }

// --- write output ---
const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i])) * 255); }
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(outBin, bytes);
console.log(`simrock: wrote ${outBin} (${N}x${N}, ${numRocks} rocks, ${mwIter} mw passes)`);
