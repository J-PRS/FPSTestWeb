// genhills.js — a grassland DM heightfield with real erosion history.
//
// hills.bin was the crudest generator (3 fixed octaves, 0.38 gain, no
// normalize) => a smooth low-relief plate: 59m relief, sd 9m, 18deg mean
// slope, 0% steep, byte range 81/255. This rebuilds it with the same
// periodic fBm/ridged base the good maps use PLUS a thermal (talus) pass
// and a Beyer raindrop hydraulic pass — the two stages that make terrain
// read as terrain instead of noise. Everything stays periodic so the
// RepeatWrapping clipmap never seams.
//
//   bun _tools/mapbake/genhills.js [--out=maps/hills.bin] [--seed=7]
//                                  [--relief=150] [--particles=80000]
//                                  [--thermal=18] [--rain=1]
const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const opt = {};
for (const a of args) { const m = a.match(/^--([\w-]+)=?(.*)$/); if (m) { opt[m[1]] = m[2] === '' ? true : m[2]; } }

const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 7);
const OUT = opt.out ?? 'maps/hills.bin';
const RELIEF = Number(opt.relief ?? 150);   // target world relief in meters
const PARTS = Number(opt.particles ?? 80000);
const TPASS = Number(opt.thermal ?? 18);
const RAIN = Number(opt.rain ?? 1);
const WORLD = 1500;
const HS = 1.5;                            // hills heightScale
const FULL = 125 * HS;                     // full-scale meters (byte 255)
const TEXEL = WORLD / N;

// --- seeded PRNG (mulberry32) ---------------------------------------------
let _s = SEED >>> 0;
function rnd() { _s = (_s + 0x6D2B79F5) >>> 0; let t = _s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }

// --- tileable value noise (periodic lattice, C1) ---------------------------
function lattice(ix, iz, oct) {
  const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + SEED * 19.3) * 43758.5453;
  return s - Math.floor(s);
}
const fade = (t) => t * t * (3 - 2 * t);
function smoothstep01(v, a, b) { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); }
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
// Per-octave integer shear + per-axis cell counts: un-skewed octaves stack
// their lattices axis-aligned, so ridge directions align into a visible
// diamond grid. SHEAR[i]=(kx,kz) shifts u by kx*v and v by kz*u — integer
// shears keep the wrap periodic (u+kv at v=1 shifts by an integer), unlike
// rotation or fractional stretch which seam the clipmap tile. Per-axis
// cell counts give drift-aligned anisotropy without breaking the wrap.
const SHEAR = [[0, 0], [1, 0], [0, 2], [-2, 1], [3, -1]];
const OCTX = [3, 7, 16, 37, 79], OCTZ = [5, 11, 23, 53, 89];
// Amplitude tilts toward the big octaves: Tribes skiing wants long
// unbroken descents and launchable lips — jagged fine detail is dead
// speed. The belt path adds the ridged term for crests; the 79/89-cell
// octaves stay tiny so they texture, not chatter, the runs.
const AMP = [1, 0.62, 0.38, 0.20, 0.08];
function octUV(u, v, i) {
  const [kx, kz] = SHEAR[i];
  return [((u + kx * v) % 1 + 1) % 1, ((v + kz * u) % 1 + 1) % 1];
}
function noiseAn(u, v, i, seed) {
  const [pu, pv] = octUV(u, v, i);
  // per-axis lattice: texels px=OCTX[i], pz=OCTZ[i] — still wraps at u=1
  // because both counts are integers.
  const cx = OCTX[i], cz = OCTZ[i];
  const x = pu * cx, z = pv * cz;
  const x0 = ((Math.floor(x) % cx) + cx) % cx, z0 = ((Math.floor(z) % cz) + cz) % cz;
  const x1 = (x0 + 1) % cx, z1 = (z0 + 1) % cz;
  const fx = fade(x - Math.floor(x)), fz = fade(z - Math.floor(z));
  return lattice(x0, z0, seed) * (1 - fx) * (1 - fz) +
         lattice(x1, z0, seed) * fx * (1 - fz) +
         lattice(x0, z1, seed) * (1 - fx) * fz +
         lattice(x1, z1, seed) * fx * fz;
}
function fbm(u, v) { let h = 0; for (let i = 0; i < OCTX.length; i += 1) { h += noiseAn(u, v, i, i) * AMP[i]; } return h; }
function ridged(u, v) { let h = 0, w = 1; for (let i = 0; i < OCTX.length; i += 1) { const n = 1 - Math.abs(2 * noiseAn(u, v, i, i + 31) - 1); h += n * n * w * AMP[i]; w *= 0.85; } return h; }

// --- base field ------------------------------------------------------------
const h = new Float64Array(N * N);
const WARP = 0.6, RIDGE = 0.45;
for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    let wu = u, wv = v;
    if (WARP > 0) {
      wu = u + WARP * (noise(u + 1.7, v + 9.2, 4, 11) - 0.5) * 0.25;
      wv = v + WARP * (noise(u + 8.3, v + 2.8, 4, 12) - 0.5) * 0.25;
    }
    const f = fbm(wu, wv), r = ridged(wu, wv);
    // Regional terrain classes, not amplitude scaling: the mask picks
    // between a smooth rolling plain (low fBm, damped high octaves) and
    // a ridged mountain belt — real grasslands are plains NEXT TO hill
    // country, not the same bumps louder. Escalade's "floor+peaks" shape
    // without pinning a level.
    const mask = noise(u * 0.5 + 3.1, v * 0.5 + 7.4, 3, 7);
    const belt = smoothstep01(mask, 0.35, 0.75);
    const plainH = f * 0.62;                       // rolling meadow, not flats
    const beltH = f * (1 - RIDGE) + r * (0.55 + RIDGE); // ridged ridge-country
    let hh = plainH * (1 - belt) + beltH * belt * (1.6 - 0.3 * belt);
    // gentle sinusoidal tilt for asymmetry
    hh += 0.12 * (1 - Math.cos(2 * Math.PI * u)) * 0.5;
    h[z * N + x] = hh;
  }
}
// normalize to 0..1
let mn = Infinity, mx = -Infinity;
for (let i = 0; i < h.length; i += 1) { if (h[i] < mn) mn = h[i]; if (h[i] > mx) mx = h[i]; }
const inv = 1 / Math.max(1e-9, mx - mn);
for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv; }
// Keep h in normalized 0..1 units for erosion stability (meters blow up the
// gradients). The final byte range is filled by the end-of-pipeline normalize,
// so relief is whatever the base produced, reshaped by erosion.

// --- helpers (wrapped) ----------------------------------------------------
const idx = (x, z) => {
  const xx = ((x % N) + N) % N, zz = ((z % N) + N) % N;
  return zz * N + xx;
};
function getH(x, z) { return h[idx(x, z)]; }

// --- thermal / talus erosion ---------------------------------------------
// Move material only where slope exceeds the talus angle, deposit downhill.
const TALUS = Math.tan(35 * Math.PI / 180); // dimensionless slope threshold
const DH_THR = TALUS * TEXEL / FULL;          // normalized height per cell
for (let pass = 0; pass < TPASS; pass += 1) {
  const delta = new Float64Array(N * N);
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = z * N + x;
      const hc = h[i];
      // four neighbours
      const hn = h[idx(x, z - 1)], hs_ = h[idx(x, z + 1)];
      const hw = h[idx(x - 1, z)], he = h[idx(x + 1, z)];
      // excess to each downhill neighbour
      for (const [nb, hn_] of [[idx(x, z - 1), hn], [idx(x, z + 1), hs_], [idx(x - 1, z), hw], [idx(x + 1, z), he]]) {
        const diff = hc - hn_;
        if (diff > DH_THR) {
          const move = (diff - DH_THR) * 0.25;
          delta[i] -= move;
          delta[nb] += move;
        }
      }
    }
  }
  for (let i = 0; i < h.length; i += 1) { h[i] += delta[i]; }
}
// keep non-negative
for (let i = 0; i < h.length; i += 1) { if (h[i] < 0) h[i] = 0; }

// --- hydraulic raindrop erosion (Beyer) -----------------------------------
if (RAIN) {
  const ER = 0.3, DEP = 0.3, EVAP = 0.01, MINCAP = 0.01, K = 4;
  const MAXSTEPS = 32, DT = 1;
  function brushAdd(cx, cz, amount, radius) {
    const r = radius | 0;
    const ix = Math.floor(cx), iz = Math.floor(cz);
    let wsum = 0;
    const cells = [];
    for (let dz = -r; dz <= r; dz += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r) { continue; }
        const w = 1 - Math.sqrt(d2) / (r + 1e-6);
        cells.push([idx(ix + dx, iz + dz), w]);
        wsum += w;
      }
    }
    if (wsum <= 0) { return; }
    for (const [i, w] of cells) { h[i] += amount * (w / wsum); }
  }
  for (let p = 0; p < PARTS; p += 1) {
    let x = rnd() * N, z = rnd() * N;
    let speed = 0, water = 1, sediment = 0;
    for (let step = 0; step < MAXSTEPS; step += 1) {
      const ix = Math.floor(x), iz = Math.floor(z);
      // gradient (height per cell)
      const hL = getH(ix - 1, iz), hR = getH(ix + 1, iz);
      const hU = getH(ix, iz - 1), hD = getH(ix, iz + 1);
      const gx = (hR - hL) * 0.5, gz = (hD - hU) * 0.5;
      const glen = Math.hypot(gx, gz);
      if (glen < 1e-6) { break; }
      // downhill direction
      const dx = -gx / glen, dz = -gz / glen;
      speed = speed + glen * DT * 0.1;
      if (speed < 0) { speed = 0; }
      water = Math.max(0, water - EVAP);
      if (water <= 0) { break; }
      const cap = Math.max(MINCAP, glen * K) * speed * water;
      if (cap > sediment) {
        const amt = (cap - sediment) * ER;
        brushAdd(x, z, -amt, 2);
        sediment += amt;
      } else {
        const amt = (sediment - cap) * DEP;
        brushAdd(x, z, amt, 2);
        sediment -= amt;
      }
      x = (x + dx * speed * DT + N) % N;
      z = (z + dz * speed * DT + N) % N;
      if (speed < 0.01) { break; }
    }
    // deposit remaining sediment at the last spot
    if (sediment > 0) { brushAdd(x, z, sediment, 2); }
  }
  // keep non-negative
  for (let i = 0; i < h.length; i += 1) { if (h[i] < 0) h[i] = 0; }
}

// --- normalize to full range + quantize -----------------------------------
mn = Infinity; mx = -Infinity;
for (let i = 0; i < h.length; i += 1) { if (h[i] < mn) mn = h[i]; if (h[i] > mx) mx = h[i]; }
const inv2 = 1 / Math.max(1e-9, mx - mn);
for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv2; }

const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) { bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i])) * 255); }
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(OUT, bytes);

// stats
let s = 0, sq = 0;
for (let i = 0; i < N * N; i += 1) { const v = bytes[8 + i]; s += v; sq += v * v; }
const mean = s / (N * N), sd = Math.sqrt(sq / (N * N) - mean * mean);
const mPerByte = FULL / 255;
let bmin = 255, bmax = 0;
for (let i = 8; i < bytes.length; i += 1) { if (bytes[i] < bmin) bmin = bytes[i]; if (bytes[i] > bmax) bmax = bytes[i]; }
console.log(`${OUT}: ${N}x${N} seed ${SEED} pre-norm range ${(mx - mn).toFixed(3)} -> byte range ${bmin}..${bmax}`);
console.log(`  (run terrainstats.js for the full profile)`);
