// Amplified abs-diff of two same-size shots + a bounding box of the change.
// Proves where (and how strongly) an effect actually lands on screen.
//   node diff.js a.png b.png out.png [gain]
const { PNG } = require('pngjs');
const fs = require('fs');

const [fa, fb, out, gainS = '8', thrS = '20'] = process.argv.slice(2);
const GAIN = +gainS;
const THR = +thrS;
const a = PNG.sync.read(fs.readFileSync(fa));
const b = PNG.sync.read(fs.readFileSync(fb));
const n = Math.min(a.data.length, b.data.length);
const d = new PNG({ width: a.width, height: a.height });
let sum = 0, cnt = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, strong = 0;
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const i = (y * a.width + x) * 4;
  const dr = Math.abs(a.data[i] - b.data[i]);
  const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
  const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
  const m = Math.max(dr, dg, db);
  if (m >= THR) {strong++;}
  const g = Math.min(255, m * GAIN);
  d.data[i] = g; d.data[i + 1] = g; d.data[i + 2] = g; d.data[i + 3] = 255;
  sum += m; cnt++;
  // a "changed" pixel is one the eye could plausibly catch: >=6/255 raw
  if (m >= 6) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
}
fs.writeFileSync(out, PNG.sync.write(d));
console.log(`strong(>=${THR}): ${strong}px  bbox x[${x0}..${x1}] y[${y0}..${y1}]  mean|d|=${(sum / cnt).toFixed(2)}  ->`, out);
