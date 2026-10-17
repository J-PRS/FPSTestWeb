// landspots.js — pick per-island play anchors (bases, spawns) that are
// actually ON the land: samples the heightfield around each given centre and
// returns the flattest, comfortably-above-water spots, spread by bearing so
// they don't stack on one another.
//
//   bun _tools/mapbake/landspots.js maps/lagoon.json \
//     --at=-300,-45,90 --at=296,30,90 --water=12 --n=4 [--json]
//
// Reads the sibling <name>.json for heightScale/tileSize (like hillshade).
// Prints a ready-to-paste spawn list with heights and slopes for review.

const fs = require('node:fs');

const binPath = process.argv[2];
if (!binPath) { console.error('usage: landspots.js <map.json|bin> --at=x,z,r [--at=...] [--water=M] [--n=4]'); process.exit(1); }
const jsonPath = binPath.replace(/\.bin$/, '.json');
let spec = {};
try { spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* bare bin */ }
const binFile = binPath.endsWith('.bin') ? binPath : `${binPath.replace(/\.json$/, '')}.bin`;
const hs = spec.heightScale ?? 1;
const tile = spec.tileSize ?? 1500;
const M_PER_BYTE = (125 * hs) / 255;

const optStr = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const WATER = Number(optStr('water', 'undefined'));
const NSPOT = Number(optStr('n', '4'));
const AS_JSON = process.argv.includes('--json');
const ats = process.argv.filter((s) => s.startsWith('--at=')).map((s) => s.slice(5).split(',').map(Number));

const buf = fs.readFileSync(binFile);
const N = buf.readUInt32LE(0);
const data = buf.subarray(8);
const H = (x, z) => {
  const u = (((x / tile) % 1) + 1) % 1 * N - 0.5;
  const v = (((z / tile) % 1) + 1) % 1 * N - 0.5;
  const x0 = ((Math.floor(u) % N) + N) % N, z0 = ((Math.floor(v) % N) + N) % N;
  const x1 = (x0 + 1) % N, z1 = (z0 + 1) % N;
  const fx = u - Math.floor(u), fz = v - Math.floor(v);
  const h = data[z0 * N + x0] * (1 - fx) * (1 - fz) + data[z0 * N + x1] * fx * (1 - fz)
    + data[z1 * N + x0] * (1 - fx) * fz + data[z1 * N + x1] * fx * fz;
  return (h / 255) * 125 * hs;
};
const slopeDeg = (x, z) => {
  const e = 5;
  const sx = (H(x + e, z) - H(x - e, z)) / (2 * e);
  const sz = (H(x, z + e) - H(x, z - e)) / (2 * e);
  return Math.atan(Math.hypot(sx, sz)) * 180 / Math.PI;
};

const out = [];
for (const [ax, az, ar] of ats) {
  const cands = [];
  for (let ri = 0; ri <= 8; ri += 1) {
    for (let ai = 0; ai < 24; ai += 1) {
      const rad = (ri / 8) * ar;
      const ang = (ai / 24) * Math.PI * 2;
      const x = Math.round(ax + Math.cos(ang) * rad);
      const z = Math.round(az + Math.sin(ang) * rad);
      const h = H(x, z), sl = slopeDeg(x, z);
      if (h < WATER + 3 || sl > 16) { continue; }
      cands.push({ x, z, h, sl, ang, rad });
    }
  }
  // Greedy pick by flatness, rejecting picks closer than ar/1.8 to a kept one.
  cands.sort((a, b) => a.sl - b.sl + (Math.abs(a.rad - ar * 0.35) - Math.abs(b.rad - ar * 0.35)) * 0.2);
  const kept = [];
  const minSep = ar / 1.8;
  for (const c of cands) {
    if (kept.length >= NSPOT) { break; }
    if (kept.every((k) => Math.hypot(k.x - c.x, k.z - c.z) >= minSep)) { kept.push(c); }
  }
  out.push({ anchor: [ax, az, ar], spots: kept });
}

if (AS_JSON) {
  console.log(JSON.stringify(out.map((o) => ({ anchor: o.anchor, spots: o.spots.map((s) => ({ x: s.x, z: s.z, h: +s.h.toFixed(1), slope: +s.sl.toFixed(1) })) })), null, 2));
} else {
  for (const o of out) {
    console.log(`\nanchor ${o.anchor.join(',')}  (water ${WATER}m):`);
    for (const s of o.spots) {
      console.log(`  { "x": ${s.x}, "z": ${s.z} }   // h ${s.h.toFixed(1)}m, slope ${s.sl.toFixed(1)}°`);
    }
  }
}
