// Drift-corrected effect strength in a window around the plume.
//   node analyze.js base effect post [cx cy w h]
// Reports mean|base-effect| (effect+drift) and mean|base-post| (drift only)
// over the window, their difference (the effect's own contribution), and the
// peak per-pixel delta. Same run => sky drift is comparable in both.
const { PNG } = require('pngjs');
const fs = require('fs');

const [fa, fb, fc, cxS = '400', cyS = '380', wS = '300', hS = '260'] = process.argv.slice(2);
const CX = +cxS, CY = +cyS, W = +wS, H = +hS;

function load(f) { return PNG.sync.read(fs.readFileSync(f)); }
const [A, B, C] = [load(fa), load(fb), load(fc)];

function over(P, Q) {
  const x0 = Math.max(0, Math.round(CX - W / 2)), y0 = Math.max(0, Math.round(CY - H / 2));
  const x1 = Math.min(P.width, x0 + W), y1 = Math.min(P.height, y0 + H);
  let sum = 0, n = 0, peak = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * P.width + x) * 4;
    const d = Math.max(Math.abs(P.data[i] - Q.data[i]), Math.abs(P.data[i + 1] - Q.data[i + 1]), Math.abs(P.data[i + 2] - Q.data[i + 2]));
    sum += d; n++; if (d > peak) peak = d;
  }
  return { mean: +(sum / n).toFixed(2), peak };
}

const eff = over(A, B), drift = over(A, C);
console.log(`window ${W}x${H}@${CX},${CY}  effect|drift: mean ${eff.mean} (peak ${eff.peak}) | drift-only: mean ${drift.mean} (peak ${drift.peak}) | NET ${(eff.mean - drift.mean).toFixed(2)}`);
