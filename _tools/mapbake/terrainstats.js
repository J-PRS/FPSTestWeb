// terrainstats.js — relief profile of a heightfield .bin, for tuning
// generated fields against real reference maps.
//   bun _tools/mapbake/terrainstats.js <bin> [<bin> ...]
//
// Prints, per field: world span, metes-per-texel, vertical relief in METERS,
// and a scale profile (per-block averaged std in meters) so you can see how
// much energy sits at 1m vs 8m vs 64m vs 512m feature sizes. Reads the
// sibling <name>.json for heightScale/tileSize.
const fs = require('node:fs');
const path = require('node:path');

function spec(bin) {
  try { return JSON.parse(fs.readFileSync(bin.replace(/\.bin$/, '.json'), 'utf8')); }
  catch { return {}; }
}

console.log('field'.padEnd(30), 'N'.padStart(5), 'tile'.padStart(5), 'texel'.padStart(6), 'hs'.padStart(4), 'relief_m'.padStart(9), 'sd_m'.padStart(7), '  scale-profile (m sd @ feature size)');

for (const bin of process.argv.slice(2)) {
  let buf;
  try { buf = fs.readFileSync(bin); } catch { continue; }
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  if (w !== h || buf.byteLength !== 8 + w * h) { console.log(bin, 'BAD HEADER'); continue; }
  const data = buf.subarray(8);
  const s = spec(bin);
  const hs = s.heightScale ?? 1;
  const tile = s.tileSize ?? 1500;
  const texel = tile / w;
  const mPerByte = 125 * hs / 255;

  let min = 255, max = 0, sum = 0, sq = 0;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; sum += v; sq += v * v; }
  const mean = sum / data.length, sd = Math.sqrt(sq / data.length - mean * mean);

  // Skiability: local slope in degrees (center difference). Mean is the
  // "average grade you carry speed through"; steep% is the fraction above
  // 45 deg (cliff faces — you can't hold a line there).
  let slopeSum = 0, steep = 0, n = 0;
  for (let z = 1; z < w - 1; z += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const dzdx = (data[z * w + x + 1] - data[z * w + x - 1]) * mPerByte / (2 * texel);
      const dzdy = (data[(z + 1) * w + x] - data[(z - 1) * w + x]) * mPerByte / (2 * texel);
      const deg = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
      slopeSum += deg; if (deg > 45) { steep += 1; } n += 1;
    }
  }

  const parts = [];
  for (const B of [1, 2, 4, 8, 16, 32, 64]) {
    const M = Math.floor(w / B);
    let ss = 0, qq = 0, c = 0;
    for (let z = 0; z < M; z += 1) {
      for (let x = 0; x < M; x += 1) {
        let acc = 0;
        for (let dz = 0; dz < B; dz += 1) { for (let dx = 0; dx < B; dx += 1) { acc += data[(z * B + dz) * w + (x * B + dx)]; } }
        const v = acc / (B * B); ss += v; qq += v * v; c += 1;
      }
    }
    const m = ss / c;
    parts.push(`${Math.round(B * texel)}m:${(Math.sqrt(qq / c - m * m) * mPerByte).toFixed(1)}`);
  }

  const name = path.relative(path.join(__dirname, '..', '..'), bin).replaceAll('\\', '/');
  console.log(
    name.padEnd(30),
    String(w).padStart(5),
    String(tile).padStart(5),
    texel.toFixed(2).padStart(6),
    String(hs).padStart(4),
    ((max - min) * mPerByte).toFixed(1).padStart(9),
    (sd * mPerByte).toFixed(1).padStart(7),
    `slp${(slopeSum / n).toFixed(1)}°`.padStart(9),
    `steep${(100 * steep / n).toFixed(0)}%`.padStart(9),
    ' ', parts.join(' '),
  );
}
