// genlagoon.js — an ARCHIPELAGO heightfield for the Lagoon rework.
//
// Four islands on a diamond ring, a shallow SHELF joining them (wadeable,
// ~2m under the surface), a DEEP central lagoon, and DEEP ocean beyond the
// ring. genmap.js can sink a bowl and stamp plateaus but can't express the
// annulus shelf that makes a lagoon read as a lagoon, so this is purpose
// built. Output format is identical to genmap.js / genfield.js:
// 8-byte LE w,h + uint8 grid, so hmParseBin and every downstream tool
// (terrainrate, hillshade, the mapshot e2e) read it unchanged.
//
//   bun _tools/mapbake/genlagoon.js maps/lagoon.bin [--size=513] [--seed=13]
//
// Heights are authored in METERS and quantized with the map's heightScale
// (125 * hs meters full-scale), so the byte grid and the spec agree by
// construction. WATER must be mirrored by the map spec's `water.level`.

const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const out = args[0];
const opt = {};
for (const a of args.slice(1)) {
  const m = a.match(/^--([\w-]+)=?(.*)$/);
  if (m) { opt[m[1]] = m[2] === '' ? true : m[2]; }
}
if (!out) {
  console.error('usage: genlagoon.js <out.bin> [--size=513] [--seed=13] [--hs=1.6] [--water=12]');
  process.exit(1);
}

const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 13);
const HS = Number(opt.hs ?? 1.6);          // must match the map's heightScale
const M_PER_BYTE = (125 * HS) / 255;       // meters per byte in the field
const FULL = 255 * M_PER_BYTE;             // field's full vertical range, meters
const WATER = Number(opt.water ?? 12);     // sea level in world meters

// Layout (world meters, tile centered on 0,0).
const RING = 300;      // island-ring radius (to each island's centre)
const ISLAND_R = 160;  // island footprint radius
const DEEP = 1.0;      // open-ocean / lagoon floor
const SHELF = 10.0;    // shallow shelf between the islands (~2m under water)

// One island per cardinal step, deliberately off the perfect diamond so the
// ring doesn't read as machined. Each carries its own peak height, ridge
// weight, footprint stretch and rotation so the four are distinct landmasses.
const ISLANDS = [
  { x: -300, z: -45, peak: 84, ridge: 1.05, sx: 1.15, sz: 0.92, rot: 0.35, seed: 0.11 },
  { x: 296, z: 30, peak: 66, ridge: 0.70, sx: 1.00, sz: 1.22, rot: -0.7, seed: 1.37 },
  { x: -35, z: -296, peak: 104, ridge: 1.35, sx: 1.22, sz: 0.95, rot: 1.15, seed: 2.61 },
  { x: 46, z: 288, peak: 78, ridge: 0.92, sx: 0.95, sz: 1.10, rot: 2.05, seed: 3.83 },
];
// Base pads (flat buildable ground) on the two CTF islands.
const FLATS = [{ x: -300, z: -45, r: 46 }, { x: 296, z: 30, r: 46 }];

// --- tileable value noise (period 1 in u,v) ------------------------------
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

// Tile span — one place. Authored frame is ENGINE world: the terrain shader
// samples fract(worldXZ / worldScale), so world (0,0) is the heightmap seam
// and the CENTRE texel sits at world (TILE/2, TILE/2). genmap authors around
// the centre texel, which silently offsets every feature by half a tile; here
// a feature placed at world X lands at X. wrapSigned folds across the seam.
const TILE = 1500;
const wrapSigned = (a) => { const m = ((a % TILE) + TILE) % TILE; return m > TILE / 2 ? m - TILE : m; };

const h = new Float32Array(N * N);
let aboveWater = 0;
for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    const wx = u * TILE, wz = v * TILE;
    const d = Math.hypot(wrapSigned(wx), wrapSigned(wz));

    // Sea floor: deep in the centre and beyond the ring, a shallow shelf
    // between the islands. The inner/outer ramps are the lagoon's walls.
    const ring = smoothstep(120, 185, d) * (1 - smoothstep(500, 615, d));
    const floorN = (fbm(u, v) - 0.5) * 1.8;
    let hh = DEEP + (SHELF - DEEP) * ring + floorN * (0.45 + 0.55 * ring);

    // Islands. Each is a stretched, rotated dome carrying a ridged spine;
    // the coastline is domain-warped by noise so it reads as eroded, not a
    // machined circle. Per-island peak/ridge tune gives the four distinct
    // silhouettes (a tall spine, a low rounded one, ...).
    for (const isl of ISLANDS) {
      const dx = wrapSigned(wx - isl.x), dz = wrapSigned(wz - isl.z);
      const ca = Math.cos(isl.rot), sa = Math.sin(isl.rot);
      const rx = (dx * ca - dz * sa) / isl.sx;
      const rz = (dx * sa + dz * ca) / isl.sz;
      const s = isl.seed;
      // Fractal coastline: two noise octaves push the effective distance in
      // and out so the shore is craggy, not a machined ellipse. Integer
      // frequency multipliers keep the field tileable at the tile edge.
      let dc = Math.hypot(rx, rz) / ISLAND_R;
      dc *= 1 + 1.05 * (fbm(u * 4 + s, v * 4 + s) - 0.5) + 0.42 * (fbm(u * 8 + s * 2, v * 8 + s) - 0.5);
      if (dc > 1.35) { continue; }
      const coast = 1 - smoothstep(0.58, 1.0, dc);
      if (coast <= 0) { continue; }
      // Interior relief: rolling fBm + a ridged spine network, so the shape
      // is multi-scale and never a smooth cone. The coast ramps it to the sea.
      const roll = fbm(u * 4 + s * 2, v * 4 + s * 3);
      const rid = ridged(u * 3 + s * 3, v * 3 + s * 5) / 2.2;
      const land = isl.peak * (0.10 + 0.42 * roll + 0.40 * rid * isl.ridge) + 3.5;
      const dome = land * coast;
      if (dome > hh) { hh = dome; }
    }

    h[z * N + x] = hh;
  }
}

// Base pads: blend each CTF island's core toward its own centre height so a
// base sits on flat, buildable ground — never a pit, never a slope.
for (const pad of FLATS) {
  const cx = Math.round((((pad.x / TILE) % 1) + 1) % 1 * N), cz = Math.round((((pad.z / TILE) % 1) + 1) % 1 * N);
  const ci = (cz % N) * N + (cx % N);
  const target = h[ci];
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const wx = (x / N) * TILE, wz = (z / N) * TILE;
      const dd = Math.hypot(wrapSigned(wx - pad.x), wrapSigned(wz - pad.z));
      if (dd > pad.r) { continue; }
      const t = 1 - dd / pad.r;
      const w = t * t * (3 - 2 * t);
      const i = z * N + x;
      h[i] = h[i] * (1 - w) + target * w;
    }
  }
}

for (let i = 0; i < N * N; i += 1) { if (h[i] > WATER) { aboveWater += 1; } }

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

const pctLand = (100 * aboveWater) / (N * N);
const waterByte = Math.round((WATER / FULL) * 255);
console.log(`${out}: ${N}x${N} seed ${SEED} hs ${HS}`);
console.log(`  relief ${mn.toFixed(1)}..${mx.toFixed(1)}m (${FULL.toFixed(0)}m full-scale)`);
console.log(`  sea level ${WATER}m = byte ${waterByte}; land ${pctLand.toFixed(1)}% of tile`);
console.log(`  island peaks ~${mx.toFixed(0)}m, shelf ${SHELF}m, ocean floor ${DEEP}m`);
