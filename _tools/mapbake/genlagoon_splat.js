// genlagoon_splat.js — the splat-texture case study for lagoon.
//
// Emits the full baked-material set beside the heightfield:
//   maps/lagoon/albedo.png   base colour per texel (replaces the procedural
//                            palette via the useAlbedo path)
//   maps/lagoon/tile_*.png   256px detail tiles (procedural, luminance-mod)
//   maps/lagoon/alphas.bin   grid^2 x count cell-major u8 layer weights
//   maps/lagoon/mats.json    manifest the client's loadMats() reads
//
// The rules ARE the splat weights: seabed under waterline, sand on the
// beach band, rock on steep/high ground, grass elsewhere — blended at the
// edges so layers feather instead of contour-banding.
//
//   bun _tools/mapbake/genlagoon_splat.js maps/lagoon.bin [--grid=256] [--water=2] [--hs=1.6]

const fs = await import('node:fs');
const path = await import('node:path');
const zlib = await import('node:zlib');

const [binPath, ...rest] = process.argv.slice(2);
const opt = {};
for (const a of rest) { const m = a.match(/^--([\w-]+)=?(.*)$/); if (m) {opt[m[1]] = m[2] === '' ? true : m[2];} }
if (!binPath) { console.error('usage: genlagoon_splat.js <lagoon.bin> [--grid=256] [--water=2] [--hs=1.6]'); process.exit(1); }

const bin = fs.readFileSync(binPath);
const N = bin.readUInt32LE(0);
const HS = Number(opt.hs ?? 1.6);
const FULL = 125 * HS;
const WATER = Number(opt.water ?? 2);
const GRID = Number(opt.grid ?? 256);
const TILE = 1500;
// mats.json must sit beside the terrainTex image — assets go to
// maps/lagoon/ so spec terrainTex "lagoon/albedo.png" finds them.
const OUT_DIR = opt.out ?? path.join(path.dirname(binPath), 'lagoon');

// --- PNG writer (same shape as hillshade.cjs) ------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i += 1) { c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); } return (c ^ 0xFFFFFFFF) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function writePng(file, w, h, rgb) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// --- tileable value noise --------------------------------------------------
const SEED = 41;
const lattice = (ix, iz, oct) => { const s = Math.sin(ix * 127.1 + iz * 311.7 + oct * 74.7 + SEED * 19.3) * 43758.5453; return s - Math.floor(s); };
const fade = (t) => t * t * (3 - 2 * t);
const noise2 = (x, z, oct) => { // non-tiling 2D noise for paint/detail
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = fade(x - x0), fz = fade(z - z0);
  const l = (a, b) => lattice(x0 + a, z0 + b, oct);
  return l(0, 0) * (1 - fx) * (1 - fz) + l(1, 0) * fx * (1 - fz) + l(0, 1) * (1 - fx) * fz + l(1, 1) * fx * fz;
};
const fbm2 = (x, z, octs = 4) => { let h = 0, a = 1, f = 1; for (let i = 0; i < octs; i += 1) { h += noise2(x * f, z * f, i) * a; a *= 0.55; f *= 2.13; } return h / 2.2; };
const ss = (a, b, t) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;

// --- height/slope sampling --------------------------------------------------
const hAt = (x, z) => (bin[8 + z * N + x] / 255) * FULL;
const slopeAt = (x, z) => {
  const xm = Math.max(0, x - 1), xp = Math.min(N - 1, x + 1);
  const zm = Math.max(0, z - 1), zp = Math.min(N - 1, z + 1);
  const step = TILE / N;
  const gx = (hAt(xp, z) - hAt(xm, z)) / ((xp - xm) * step);
  const gz = (hAt(x, zp) - hAt(x, zm)) / ((zp - zm) * step);
  return Math.min(1, Math.hypot(gx, gz) * 0.7); // ~1 at steep faces
};

// --- layer rules ------------------------------------------------------------
// 0=seabed 1=sand 2=grass 3=rock
const LAYERS = 4;
function weights(hgt, slp, u, v) {
  const w = [0, 0, 0, 0];
  // jitter the thresholds so contour bands don't draw as level lines
  const jit = (fbm2(u * 14 + 3, v * 14 + 8) - 0.5) * 6;
  const sea = 1 - ss(WATER - 0.5, WATER + 0.8, hgt);
  const beach = ss(WATER + 0.4, WATER + 2.5, hgt + jit) * (1 - ss(WATER + 7, WATER + 14, hgt + jit)) * (1 - ss(0.45, 0.75, slp));
  const rock = ss(0.42, 0.72, slp) + ss(70, 105, hgt + jit * 2) * 0.6;
  const rockC = Math.min(1, rock);
  w[0] = sea;
  w[1] = beach * (1 - sea);
  w[2] = Math.max(0, 1 - sea - beach) * (1 - rockC);
  w[3] = Math.max(0, 1 - sea - beach) * rockC;
  return w;
}

// --- palettes ---------------------------------------------------------------
// Albedo colors painted per texel (sRGB-ish, matched to the coast preset's
// bright read). Seabed goes dark so depth reads through the water surface.
const C = {
  seabed: [58, 52, 40],
  sand: [196, 178, 132],
  wetSand: [148, 132, 96],
  grass: [74, 116, 52],
  grassDry: [140, 138, 74],
  rock: [112, 104, 92],
  cliff: [78, 72, 64],
};

const A = Math.round(opt.albedoRes ?? 1024); // albedo res — crisper than the 513 heightfield
const albedo = Buffer.alloc(A * A * 3);
const alphas = new Uint8Array(GRID * GRID * LAYERS);

for (let z = 0; z < A; z += 1) {
  for (let x = 0; x < A; x += 1) {
    // bilinear height + slope at albedo res
    const fx = (x / A) * N, fz = (z / A) * N;
    const x0 = Math.min(N - 2, Math.floor(fx)), z0 = Math.min(N - 2, Math.floor(fz));
    const tx = fx - x0, tz = fz - z0;
    const hgt = hAt(x0, z0) * (1 - tx) * (1 - tz) + hAt(x0 + 1, z0) * tx * (1 - tz)
      + hAt(x0, z0 + 1) * (1 - tx) * tz + hAt(x0 + 1, z0 + 1) * tx * tz;
    const slp = slopeAt(x0, z0) * (1 - tx) * (1 - tz) + slopeAt(x0 + 1, z0) * tx * (1 - tz)
      + slopeAt(x0, z0 + 1) * (1 - tx) * tz + slopeAt(x0 + 1, z0 + 1) * tx * tz;
    const u = x / A, v = z / A;
    const w = weights(hgt, slp, u, v);

    // albedo: weighted layer colors + grass hue drift + wet-sand waterline
    const gVar = fbm2(u * 9 + 1, v * 9 + 4);
    const grassC = [mix(C.grass[0], C.grassDry[0], gVar), mix(C.grass[1], C.grassDry[1], gVar), mix(C.grass[2], C.grassDry[2], gVar)];
    const sandC = hgt < WATER + 2 ? C.wetSand : C.sand;
    const rockC = slp > 0.6 ? C.cliff : C.rock;
    const cols = [C.seabed, sandC, grassC, rockC];
    let r = 0, g = 0, b = 0, ws = 0;
    for (let k = 0; k < LAYERS; k += 1) { r += cols[k][0] * w[k]; g += cols[k][1] * w[k]; b += cols[k][2] * w[k]; ws += w[k]; }
    ws = Math.max(ws, 1e-4);
    // light occlusion-ish shading from macro noise + slope so the bake
    // isn't flat poster colors
    const shade = 0.82 + 0.30 * fbm2(u * 22 + 7, v * 22 + 2) - slp * 0.18;
    const i = (z * A + x) * 3;
    albedo[i] = Math.min(255, Math.round((r / ws) * shade));
    albedo[i + 1] = Math.min(255, Math.round((g / ws) * shade));
    albedo[i + 2] = Math.min(255, Math.round((b / ws) * shade));
  }
}

for (let z = 0; z < GRID; z += 1) {
  for (let x = 0; x < GRID; x += 1) {
    const tx = Math.min(N - 1, Math.round((x / GRID) * N)), tz = Math.min(N - 1, Math.round((z / GRID) * N));
    const w = weights(hAt(tx, tz), slopeAt(tx, tz), x / GRID, z / GRID);
    const i = (z * GRID + x) * LAYERS;
    let ws = w[0] + w[1] + w[2] + w[3] || 1;
    for (let k = 0; k < LAYERS; k += 1) {alphas[i + k] = Math.round((w[k] / ws) * 255);}
  }
}

// --- 256px detail tiles (mean ~0.5 luminance, tiling) -----------------------
const tiles = ['seabed', 'sand', 'grass', 'rock'];
const tileFn = {
  seabed: (x, z) => 0.42 + 0.18 * fbm2(x * 5, z * 5) + 0.10 * fbm2(x * 17, z * 17),
  sand: (x, z) => 0.55 + 0.14 * fbm2(x * 7, z * 7) + 0.16 * fbm2(x * 23, z * 23) + 0.05 * fbm2(x * 61, z * 61),
  grass: (x, z) => 0.46 + 0.20 * fbm2(x * 4, z * 4) + 0.14 * fbm2(x * 13, z * 13) + 0.08 * fbm2(x * 41, z * 41),
  rock: (x, z) => 0.50 + 0.24 * Math.abs(2 * fbm2(x * 3, z * 3) - 1) + 0.16 * fbm2(x * 11, z * 11) + 0.07 * fbm2(x * 37, z * 37),
};
// per-layer tint so the detail modulation still reads as its material
const tileTint = { seabed: [0.75, 0.72, 0.62], sand: [1.0, 0.94, 0.78], grass: [0.72, 0.85, 0.55], rock: [0.82, 0.80, 0.76] };
for (const [k, tname] of tiles.entries()) {
  const px = Buffer.alloc(256 * 256 * 3);
  for (let z = 0; z < 256; z += 1) {
    for (let x = 0; x < 256; x += 1) {
      // wrap-aware sampling: the noise must tile or the atlas seams
      const u = x / 256, v = z / 256;
      const cx = Math.cos(u * Math.PI * 2) * 0.5 + 0.5, sx = Math.sin(u * Math.PI * 2) * 0.5 + 0.5;
      const cy = Math.cos(v * Math.PI * 2) * 0.5 + 0.5, sy = Math.sin(v * Math.PI * 2) * 0.5 + 0.5;
      const lum = tileFn[tname](cx + cy * 3.1, sx + sy * 3.7);
      const i = (z * 256 + x) * 3;
      const t = tileTint[tname];
      px[i] = Math.min(255, Math.round(lum * 255 * t[0]));
      px[i + 1] = Math.min(255, Math.round(lum * 255 * t[1]));
      px[i + 2] = Math.min(255, Math.round(lum * 255 * t[2]));
    }
  }
  writePng(path.join(OUT_DIR, `tile_${tname}.png`), 256, 256, px);
}

writePng(path.join(OUT_DIR, 'albedo.png'), A, A, albedo);
fs.writeFileSync(path.join(OUT_DIR, 'alphas.bin'), Buffer.from(alphas.buffer, alphas.byteOffset, alphas.byteLength));
fs.writeFileSync(path.join(OUT_DIR, 'mats.json'), JSON.stringify({
  grid: GRID, count: LAYERS, tiles: tiles.map((t) => `tile_${t}.png`),
  alphas: 'alphas.bin', tileMeters: TILE / GRID,
}, null, 2) + '\n');

console.log(`${OUT_DIR}: albedo.png ${A}x${A}, ${tiles.length} tiles, alphas.bin ${GRID}x${GRID}x${LAYERS}, tileMeters ${(TILE / GRID).toFixed(2)}`);
