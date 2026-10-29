// gencrucible.js — Crucible: a giant volcanic crater bowl for CTF.
// Dangerous-Crossing layout: base pads on opposite rim crests (±300,0),
// the bowl is the transit — but the floor is RELIEF, not a flat pit:
// ejecta-ray ridges radiate from centre, secondary craters bite the
// floor, a scattered crag field gives cover, a broad vent plug sits at
// the heart. Outside the rim: rolling badlands.
//
//   bun _tools/mapbake/gencrucible.js maps/crucible.bin [--size=513] [--seed=21]
//
// Heights authored in METERS, quantized with the spec's heightScale
// (125 * hs meters full-scale). Dry map — no water.

const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const out = args[0];
const opt = {};
for (const a of args.slice(1)) {
  const m = a.match(/^--([\w-]+)=?(.*)$/);
  if (m) { opt[m[1]] = m[2] === '' ? true : m[2]; }
}
if (!out) {
  console.error('usage: gencrucible.js <out.bin> [--size=513] [--seed=21] [--hs=1.0]');
  process.exit(1);
}

const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 21);
const HS = Number(opt.hs ?? 1.0);
const M_PER_BYTE = (125 * HS) / 255;
const FULL = 255 * M_PER_BYTE;

// --- crater geometry (engine metres, centre = world origin) ---------
const RIM_R = 300;        // crest radius — base pads sit on the rim band
const RIM_H = 98;         // nominal crest height
const RIM_W = 95;         // rim half-width (falloff)
const BOWL_FLOOR = 16;    // bowl base
const PLUG_R = 55, PLUG_H = 30;      // central vent mound
const EXTERIOR = 62;                 // badlands base level outside rim
// Secondary pits that break up the bowl (x, z, r, depth).
const CRATERS = [
  { x: 130, z: 140, r: 72, d: 14 },
  { x: -150, z: -95, r: 58, d: 12 },
  { x: -60, z: 160, r: 44, d: 9 },
];
// Base pads + rim spawn pads — flattened discs.
const PADS = [
  { x: -300, z: 0, r: 62, h: 102 },   // alpha base
  { x: 300, z: 0, r: 62, h: 102 },    // bravo base
  { x: 0, z: 300, r: 34, h: 96 },
  { x: 0, z: -300, r: 34, h: 96 },
  { x: -212, z: 212, r: 34, h: 99 },
  { x: 212, z: 212, r: 34, h: 99 },
  { x: -212, z: -212, r: 34, h: 99 },
  { x: 212, z: -212, r: 34, h: 99 },
];

// --- tileable value noise (same machinery as genlagoon) ---------------
function lattice(ix, iz, oct) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + SEED * 19.3) * 43758.5453;
  return s - Math.floor(s);
}
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
const OCT = [3, 7, 16, 34], AMP = [1, 0.6, 0.34, 0.2];
function fbm(u, v) { let h = 0; for (let i = 0; i < 4; i += 1) { h += noise(u, v, OCT[i], i) * AMP[i]; } return h / 2.14; }
function ridged(u, v) { let h = 0, w = 1; for (let i = 0; i < 4; i += 1) { const n = 1 - Math.abs(2 * noise(u, v, OCT[i], i + 31) - 1); h += n * n * w * AMP[i]; w *= 0.85; } return h; }
const smoothstep = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };

const TILE = 1500;
const h = new Float32Array(N * N);

for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    const wx = u * TILE, wz = v * TILE;
    // Engine frame: world origin = texel CORNER; ±750 = tile centre.
    const ex = wx > TILE / 2 ? wx - TILE : wx;
    const ez = wz > TILE / 2 ? wz - TILE : wz;
    const d = Math.hypot(ex, ez);
    const ang = Math.atan2(ez, ex); // -PI..PI

    // Rim warp so the crest meanders — the bowl isn't a circle.
    const warp = 1 + 0.16 * (fbm(u * 4 + 3.1, v * 4 + 7.7) - 0.5) + 0.07 * (fbm(u * 9 + 1.3, v * 9 + 4.4) - 0.5);
    const dr = d / warp;

    // Exterior badlands: rolling hills + ridged spines above the bowl level.
    const extH = EXTERIOR + 20 * fbm(u * 4 + 0.5, v * 4 + 1.3) + 26 * ridged(u * 3 + 2.1, v * 3 + 0.7) / 2.2 - 14;

    // Rim crest: annulus peaked at RIM_R, height modulated so the ridge
    // walks (85-112m) — never a smooth ring.
    const rimBand = 1 - smoothstep(0, RIM_W, Math.abs(dr - RIM_R));
    const rimJit = 0.87 + 0.24 * fbm(u * 5 + 6.6, v * 5 + 2.2);
    const rimH = RIM_H * rimJit;

    // Bowl floor + interior relief ------------------------------
    let bowl = BOWL_FLOOR;
    // Central vent plug: broad dome, noisied so it isn't a bullseye.
    const plug = PLUG_H * (1 - smoothstep(0, PLUG_R, dr * (0.85 + 0.3 * (fbm(u * 7 + 2.8, v * 7 + 9.1) - 0.5))));
    // Ejecta rays: ridged noise sampled in polar space (angle, radius) —
    // radial streaks breaking across the floor and over the rim slope.
    const rays = ridged(ang * 0.64 + 4.0 + 0.8 * (fbm(u * 5, v * 5) - 0.5), dr * 0.012)
      * 0.5 * smoothstep(RIM_R + 40, 60, dr);
    // Crag field: scattered cover mounds across the floor.
    const crag = Math.max(0, fbm(u * 11 + 5.1, v * 11 + 8.8) - 0.60) * 55
      * smoothstep(240, 140, dr);
    // Concentric-ish ripple on the bowl walls (terraced read under strata).
    const terr = 5.0 * Math.sin(dr * 0.11) * smoothstep(230, 90, dr);
    bowl += plug + rays * 24 + crag + terr + 9 * fbm(u * 6 + 4.4, v * 6 + 1.1);

    // Secondary craters bite the floor.
    for (const c of CRATERS) {
      const cd = Math.hypot(ex - c.x, ez - c.z) / c.r;
      bowl -= c.d * (1 - smoothstep(0.55, 1.0, cd));
    }

    // Compose: exterior vs rim crest vs bowl by radial band.
    const inBowl = 1 - smoothstep(RIM_R - 60, RIM_R, dr);
    const rimAmount = rimBand * rimJit;
    let hi = extH * (1 - inBowl) + bowl * inBowl;
    hi = Math.max(hi, hi * (1 - rimAmount) + (rimH + bowl * 0.15) * rimAmount);

    // Base/spawn pads: flatten discs (mix toward pad height inside r).
    for (const p of PADS) {
      const pd = Math.hypot(ex - p.x, ez - p.z) / p.r;
      const pad = 1 - smoothstep(0.6, 1.0, pd);
      if (pad > 0) {hi = hi * (1 - pad) + p.h * pad;}
    }

    h[z * N + x] = hi;
  }
}

const bytes = new Uint8Array(8 + N * N);
let mn = Infinity, mx = -Infinity;
for (let i = 0; i < N * N; i += 1) {
  const b = Math.round(Math.min(1, Math.max(0, h[i] / FULL)) * 255);
  bytes[8 + i] = b;
  if (h[i] < mn) { mn = h[i]; }
  if (h[i] > mx) { mx = h[i]; }
}
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(out, bytes);

console.log(`${out}: ${N}x${N} seed ${SEED} hs ${HS}`);
console.log(`  relief ${mn.toFixed(1)}..${mx.toFixed(1)}m (${FULL.toFixed(0)}m full-scale)`);
console.log(`  bowl floor ~${BOWL_FLOOR}m, rim crest ~${RIM_H}m`);
