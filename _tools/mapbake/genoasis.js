// genoasis.js — native (non-T2) oasis: sandy dunes around scattered water
// pools. Coast palette (preset 6) bands. Smoothed to reduce jaggedness.
const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const opt = {};
for (const a of args) { const m = a.match(/^--([\w-]+)=?(.*)$/); if (m) { opt[m[1]] = m[2] === '' ? true : m[2]; } }
const OUT = args[0] ?? 'maps/mirage.bin';
const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 23);
const HS = Number(opt.hs ?? 5.2);
const TILE = 1500;

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
const OCT = [6, 12, 24, 48], AMP = [1, 0.5, 0.25, 0.12];
function fbm(u, v) { let h = 0; for (let i = 0; i < 4; i += 1) { h += noise(u, v, OCT[i], i) * AMP[i]; } return h / 2.14; }
function ridged(u, v) { let h = 0, w = 1; for (let i = 0; i < 4; i += 1) { const n = 1 - Math.abs(2 * noise(u, v, OCT[i], i + 31) - 1); h += n * n * w * AMP[i]; w *= 0.85; } return h; }
const smoothstep = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const wrapSigned = (a) => { const m = ((a % TILE) + TILE) % TILE; return m > TILE / 2 ? m - TILE : m; };

const h = new Float64Array(N * N);
for (let z = 0; z < N; z += 1) {
  for (let x = 0; x < N; x += 1) {
    const u = x / N, v = z / N;
    const wx = u * TILE, wz = v * TILE;
    const d = Math.hypot(wrapSigned(wx), wrapSigned(wz));

    const wobble = 1 + 0.18 * (fbm(u * 5 + 3.1, v * 5 + 7.4) - 0.5) + 0.08 * (fbm(u * 9 + 1.7, v * 9 + 9.2) - 0.5);

    const ridBroad = ridged(u * 0.8 + 0.7, v * 0.8 + 1.1) / 2.2;
    const rollMid = fbm(u * 2.5 + 0.7, v * 2.5 + 1.1);
    const rid = ridged(u * 2.5 + 2.3, v * 2.5 + 0.9) / 2.2;
    let hh = Math.max(0.075, 0.072 + 0.160 * ridBroad + 0.040 * rollMid + 0.090 * rid);

    // Oasis vegetation ring near water
    const vegRing = (1 - smoothstep(100, 240, d)) * smoothstep(40, 90, d);
    hh = Math.max(hh, 0.10 + 0.05 * fbm(u * 6 + 2.1, v * 6 + 5.3) * vegRing);

    // Shallow organic pools: radial base + strong domain warp for organic
    // shape, wide gentle shore ramp for shallowness (not crater-like).
    const POOLS = [[-380, 290, 45], [420, -340, 40], [120, 160, 35], [-200, -480, 42], [300, 80, 30]];
    for (const [px, pz, pr] of POOLS) {
      const pw = wrapSigned(wx - px), pz_ = wrapSigned(wz - pz);
      // Strong multi-octave domain warp for organic, bayed shoreline.
      const pwarp = 1 + 0.6 * (fbm(u * 4 + px * 0.01, v * 4 + pz * 0.01) - 0.5) + 0.3 * (fbm(u * 9 + px * 0.02, v * 9 + pz * 0.02) - 0.5) + 0.15 * (fbm(u * 16 + px * 0.03, v * 16 + pz * 0.03) - 0.5);
      const pdist = Math.hypot(pw, pz_) * pwarp;
      // Wide, gentle shore ramp (120m) for shallowness.
      if (pdist < pr + 120) {
        const pool = smoothstep(pr - 20, pr + 120, pdist); // 0 in pool, 1 on land
        const floor = 0.007; // shallow floor (water band is <0.010)
        const target = floor + (hh - floor) * pool;
        hh = Math.min(hh, target);
      }
    }

    h[z * N + x] = Math.min(0.32, Math.max(0, hh));
  }
}

// Thermal (talus) erosion: move material where slope exceeds talus angle.
{
  const TEXEL = TILE / N;
  const FULL = 125 * HS;
  const TALUS = Math.tan(25 * Math.PI / 180);
  const DH_THR = TALUS * TEXEL / FULL;
  const TPASS = 120;
  const idx = (x, z) => {
    const xx = ((x % N) + N) % N, zz = ((z % N) + N) % N;
    return zz * N + xx;
  };
  for (let pass = 0; pass < TPASS; pass += 1) {
    const delta = new Float64Array(N * N);
    for (let z = 0; z < N; z += 1) {
      for (let x = 0; x < N; x += 1) {
        const i = z * N + x;
        const hc = h[i];
        const hn = h[idx(x, z - 1)], hs_ = h[idx(x, z + 1)];
        const hw = h[idx(x - 1, z)], he = h[idx(x + 1, z)];
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
    for (let i = 0; i < h.length; i += 1) { h[i] += delta[i]; if (h[i] < 0) h[i] = 0; }
  }
}

// Light smoothing - 1 pass, reduce chatter.
const _tmp = new Float64Array(N * N);
{
  for (let z = 0; z < N; z += 1) for (let x = 0; x < N; x += 1) {
    let acc = 0, n = 0;
    for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const xi = (x + dx + N) % N, zi = (z + dz + N) % N;
      acc += h[zi * N + xi]; n += 1;
    }
    _tmp[z * N + x] = acc / n;
  }
  for (let i = 0; i < N * N; i += 1) { h[i] = _tmp[i]; }
}
const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) {
  bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i])) * 255);
}
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(OUT, bytes);

let water = 0;
for (let i = 0; i < N * N; i += 1) { if (bytes[8 + i] / 255 <= 0.01) water += 1; }
console.log(`${OUT}: ${N}x${N} seed ${SEED}`);
console.log(`  height range ${(Math.min(...bytes.subarray(8)) / 255 * 100).toFixed(1)}%..${(Math.max(...bytes.subarray(8)) / 255 * 100).toFixed(1)}%  water ${(100 * water / (N * N)).toFixed(1)}% of tile`);
