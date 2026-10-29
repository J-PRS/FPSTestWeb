// genlagoon.js - a SINGLE MEDIUM ISLAND heightfield for the Lagoon rework.
//
// One contiguous landmass: a broad, rolling island with a ridged spine and
// organic coastline. No deep lagoon, no forced water crossings - everything
// is navigable on foot. Water level is set very low so the island is the
// whole playable surface.
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
  console.error('usage: genlagoon.js <out.bin> [--size=513] [--seed=13] [--hs=1.6] [--water=2]');
  process.exit(1);
}

const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 13);
const HS = Number(opt.hs ?? 1.6);          // must match the map's heightScale
const M_PER_BYTE = (125 * HS) / 255;       // meters per byte in the field
const FULL = 255 * M_PER_BYTE;             // field's full vertical range, meters
const WATER = Number(opt.water ?? 2);       // sea level in world meters (very low)

// Layout: a main mass + a smaller off-centre mass — the two-part silhouette
// reads as a natural island group, not a radial dome.
const MASSES = [
  { x: -60, z: -20, r: 540, peak: 118 },
  { x: 280, z: 170, r: 330, peak: 58 },
];
const RIDGE = 1.6;      // ridged spine weight

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

const TILE = 1500;

const h = new Float32Array(N * N);
let aboveWater = 0;
for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    const wx = u * TILE, wz = v * TILE;

    // Coastline domain warp for organic shape — stronger than v1 so the
    // shore meanders instead of tracing a circle.
    const warp = 1 + 0.8 * (fbm(u * 3 + 1.7, v * 3 + 9.2) - 0.5) + 0.35 * (fbm(u * 6 + 8.3, v * 6 + 2.8) - 0.5);

    const seafloor = WATER - 12 + 4 * fbm(u * 4, v * 4);
    // Interior relief terms shared by both masses.
    const roll = fbm(u * 4 + 0.5, v * 4 + 1.3);
    const rid = ridged(u * 3 + 2.1, v * 3 + 0.7) / 2.2;
    const pBump = 0.7 + 0.3 * fbm(u * 6 + 3.1, v * 6 + 7.9);

    // Engine frame: texel wx∈[0,1500) is world coords wrapped — the world
    // ORIGIN is the texel corner, ±750 the centre. Masses live in engine
    // coords, so unwrap before measuring (v2's 750+off put the island on
    // the wrap seam — every gameplay coordinate read ocean).
    const ex = wx > TILE / 2 ? wx - TILE : wx;
    const ez = wz > TILE / 2 ? wz - TILE : wz;

    // Each mass contributes a full seafloor->land surface; the MAX keeps
    // the union continuous — the domes meet in a ridge, not a seam (a
    // winner-take-all distance switch left a visible arc).
    let hi = seafloor;
    for (const m of MASSES) {
      const cDist = Math.hypot(ex - m.x, ez - m.z) / m.r;
      const dc = cDist * warp;
      const coast = 1 - smoothstep(0.75, 1.0, dc);
      if (coast <= 0) {continue;}
      // The lerp seafloor<->land keeps the descent through the waterline
      // monotonic — the old land*coast+clamp collapsed the ~coast<0.1
      // band to just-below-sea, painting pond pits around the island.
      const peakBoost = (1 - cDist * cDist) * 0.40 * pBump;
      const land = m.peak * (0.12 + 0.30 * roll + 0.35 * rid * RIDGE + peakBoost) + 4.0;
      const s = seafloor + (land - seafloor) * coast;
      if (s > hi) {hi = s;}
    }
    h[z * N + x] = hi;
  }
}

// Pond fill: a below-water texel ringed by land is a speckled pit, not a
// lake — raise it just above the waterline (the old field's "weird holes").
// Filled pits can ring NEW pits, so loop to convergence.
let filled = 0;
for (let pass = 0; pass < 8; pass += 1) {
  let n = 0;
  for (let z = 1; z < N - 1; z += 1) {
    for (let x = 1; x < N - 1; x += 1) {
      const i = z * N + x;
      if (h[i] > WATER) {continue;}
      let la = 0;
      for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) { if (h[i + dz * N + dx] > WATER) {la += 1;} }
      if (la >= 5) { h[i] = WATER + 1; n += 1; }
    }
  }
  filled += n;
  if (!n) {break;}
}
if (filled) {console.log(`  pond fill: ${filled} speckle pits raised above waterline`);}

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
console.log(`  island peak ~${mx.toFixed(0)}m`);