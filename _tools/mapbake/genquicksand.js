// genquicksand.js - organic bowl arena: natural depression (the "fray")
// with raised rim so players ski down into the center. Domain-warped
// bowl + ridged texture, thermal erosion. No stamped geometry.
const { writeFileSync } = await import('node:fs');

const args = process.argv.slice(2);
const opt = {};
for (const a of args) { const m = a.match(/^--([\w-]+)=?(.*)$/); if (m) { opt[m[1]] = m[2] === '' ? true : m[2]; } }
const OUT = args[0] ?? 'maps/quicksand.bin';
const N = Number(opt.size ?? 513);
const SEED = Number(opt.seed ?? 7);
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
const OCT = [4, 8, 16, 32], AMP = [1, 0.6, 0.35, 0.2];
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

    // Domain warp for organic shape.
    const wobble = 1 + 0.25 * (fbm(u * 4 + 1.7, v * 4 + 9.2) - 0.5) + 0.12 * (fbm(u * 8 + 8.3, v * 8 + 2.8) - 0.5);

    // Bowl profile: low center (fray), steep inner wall (ski run), flat rim
    // (barrier), and gentle rising outer terrain (so you can't ski out).
    const rd = d * wobble;
    const rimR = 200;
    const rimHeight = 0.34;
    let bowl;
    if (rd < rimR) {
      const t = rd / rimR;
      bowl = 0.10 + (rimHeight - 0.10) * (t * t * (3 - 2 * t));
    } else {
      const t = Math.min(1, (rd - rimR) / 160);
      bowl = rimHeight + 0.50 * (t * t * (3 - 2 * t));
    }

    // Ridged texture for organic rock.
    const rid = ridged(u * 3 + 2.3, v * 3 + 0.9) / 2.2;
    let hh = bowl + 0.03 * rid + 0.015 * fbm(u * 5 + 0.7, v * 5 + 1.1);

    h[z * N + x] = Math.min(1, Math.max(0, hh));
  }
}

// Thermal (talus) erosion - smooths slopes.
const TALUS = 0.06;
for (let pass = 0; pass < 4; pass += 1) {
  const delta = new Float64Array(N * N);
  for (let z = 0; z < N; z += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = z * N + x;
      const hc = h[i];
      const neighbors = [[x, z-1], [x, z+1], [x-1, z], [x+1, z]];
      for (const [nx, nz] of neighbors) {
        const ni = ((nz % N) + N) % N * N + ((nx % N) + N) % N;
        const diff = hc - h[ni];
        if (diff > TALUS) {
          const move = (diff - TALUS) * 0.15;
          delta[i] -= move;
          delta[ni] += move;
        }
      }
    }
  }
  for (let i = 0; i < h.length; i += 1) { h[i] += delta[i]; if (h[i] < 0) h[i] = 0; }
}

// Normalize to 0..1
let mn = Infinity, mx = -Infinity;
for (let i = 0; i < h.length; i += 1) { if (h[i] < mn) mn = h[i]; if (h[i] > mx) mx = h[i]; }
const inv = 1 / Math.max(1e-9, mx - mn);
for (let i = 0; i < h.length; i += 1) { h[i] = (h[i] - mn) * inv; }

const bytes = new Uint8Array(8 + N * N);
for (let i = 0; i < N * N; i += 1) {
  bytes[8 + i] = Math.round(Math.min(1, Math.max(0, h[i])) * 255);
}
const dv = new DataView(bytes.buffer);
dv.setUint32(0, N, true); dv.setUint32(4, N, true);
writeFileSync(OUT, bytes);

let mn2 = 1, mx2 = 0;
for (let i = 0; i < N * N; i += 1) { const v = bytes[8 + i] / 255; if (v < mn2) mn2 = v; if (v > mx2) mx2 = v; }
console.log(`${OUT}: ${N}x${N} seed ${SEED}`);
console.log(`  height range ${(mn2 * 100).toFixed(1)}%..${(mx2 * 100).toFixed(1)}%`);
