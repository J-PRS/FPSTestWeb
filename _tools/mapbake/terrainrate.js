// terrainrate.js — a multi-axis terrain REPORT CARD for heightfields.
//
// Deliberately NOT a single score. A heightfield is good or bad only
// relative to a purpose, and one number hides the trade. This rates the
// field on independent axes so shape can be judged per use:
//
//   RELIEF  how much vertical exists, and how it is distributed (hypsometry)
//   GRADE   slope distribution in movement-meaningful bands
//   SCALE   how much grade survives at large scale (coarse/fine ratio) —
//           the axis that separates big rolling hills from a bumpy plate
//   SHAPE   convex/concave balance (launch vs catch), sub-ski chatter,
//           and closed bowls (pits) that swallow a run
//   LINE    the longest monotone fall line from a random drop (drop + length),
//           and how concentrated flow is (a few bowls vs drainage everywhere)
//   PADS    walkable / flat play-space fraction
//
//   bun _tools/mapbake/terrainrate.js maps/hills.json maps/peaks.bin --json
//
// A .json input is a map spec (resolves terrain bin + heightScale/tileSize);
// a .bin is the bare field (sibling json used if present, --hs=/--tile= override).
// The T2 ports under maps/t2/*/terrain.bin are the reference standard.
const fs = require('node:fs');
const path = require('node:path');

const WANT_JSON = process.argv.includes('--json');
const opt = (k, d) => { const a = process.argv.find((s) => s.startsWith(`--${k}=`)); return a ? Number(a.slice(k.length + 3)) : d; };

const DEG = 180 / Math.PI;
const BANDS = [[0, 5, 'flat'], [5, 20, 'cruise'], [20, 35, 'steep'], [35, 50, 'hard'], [50, 999, 'cliff']];
const SCALE_WORLD = [4, 8, 16, 32, 64, 128, 256]; // fixed world block sizes (resolution-independent)
const FINE_M = 8;         // "fine grade" reference scale
const CHATTER_M = 30;     // meters — above this, bumps stop reading as skiable grade
const SMOOTH_M = 30;      // meters — the "hillshape" the fall-line follows
const COARSE_M = 64;      // meters — the large-scale end of the coarse/fine ratio
const TPI_LOCAL_M = 50;   // TPI local window
const TPI_REGION_M = 150; // TPI regional window
const FALL_MIN_DEG = 6;   // a fall line needs at least this much grade to be worth it
const FALL_STEP_CAP = 4000;

// The reference population is every map spec whose terrain lives under
// maps/t2/ — the T2 ports ARE the "what good looks like" standard. With
// --ref each input is located inside that population per axis, so a value
// reads as a percentile, not an absolute verdict. Higher/lower is not
// good/bad by itself; the axis says WHY a field sits where it does.
const REF_METRICS = [
  ['RELIEF', 'relief',     (r) => r.relief,       'm', 1],
  ['GRADE',  'med slope',  (r) => r.medSlope,     '°', 0],
  ['GRADE',  'p90 slope',  (r) => r.p90Slope,     '°', 0],
  ['SCALE',  'coarse/fine', (r) => r.gradeRatio,  '', 2],
  ['SCALE',  'grade@64m',  (r) => r.coarseSlope,  '°', 0],
  ['SHAPE',  'chatter',    (r) => r.chatter,      'm', 1],
  ['LINE',   'fall drop p90', (r) => r.fallDropP90, 'm', 0],
  ['LINE',   'fall len p90',  (r) => r.fallLenP90,  'm', 0],
  ['PADS',   'walkable',   (r) => r.walk,         '%', 0],
];
const PCT_SCALE = { walkable: 100 }; // fraction -> percent for display

/** Fraction of ref values strictly below v (0..1), on an ascending array. */
function fracBelow(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) { lo = m + 1; } else { hi = m; } }
  return lo / sorted.length;
}
const pctlWord = (p) => (p < 0.1 ? 'floor' : p < 0.25 ? 'low' : p < 0.75 ? 'mid' : p < 0.9 ? 'high' : 'top');

function spec(bin) { try { return JSON.parse(fs.readFileSync(bin.replace(/\.bin$/, '.json'), 'utf8')); } catch { return {}; } }

function mulberry32(a) {
  let s = a | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function boxBlur(src, w, R) {
  const tmp = new Float64Array(w * w), out = new Float64Array(w * w), win = 2 * R + 1;
  const idx = (i) => ((i % w) + w) % w;
  for (let y = 0; y < w; y += 1) {
    const row = y * w; let acc = 0;
    for (let k = -R; k <= R; k += 1) { acc += src[row + idx(k)]; }
    for (let x = 0; x < w; x += 1) { tmp[row + x] = acc / win; acc -= src[row + idx(x - R)]; acc += src[row + idx(x + R + 1)]; }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let k = -R; k <= R; k += 1) { acc += tmp[idx(k) * w + x]; }
    for (let y = 0; y < w; y += 1) { out[y * w + x] = acc / win; acc -= tmp[idx(y - R) * w + x]; acc += tmp[idx(y + R + 1) * w + x]; }
  }
  return out;
}

/** Mean slope (deg) at a given block size, from block-mean heights. */
function scaleSlope(H, N, texel, B) {
  const M = Math.floor(N / B);
  if (M < 3) { return null; }
  const bm = new Float64Array(M * M);
  for (let bz = 0; bz < M; bz += 1) for (let bx = 0; bx < M; bx += 1) {
    let acc = 0;
    for (let dz = 0; dz < B; dz += 1) for (let dx = 0; dx < B; dx += 1) { acc += H[(bz * B + dz) * N + (bx * B + dx)]; }
    bm[bz * M + bx] = acc / (B * B);
  }
  const bt = texel * B; let ss = 0, n2 = 0;
  for (let bz = 1; bz < M - 1; bz += 1) for (let bx = 1; bx < M - 1; bx += 1) {
    const ddx = (bm[bz * M + bx + 1] - bm[bz * M + bx - 1]) / (2 * bt);
    const ddy = (bm[(bz + 1) * M + bx] - bm[(bz - 1) * M + bx]) / (2 * bt);
    ss += Math.atan(Math.hypot(ddx, ddy)) * DEG; n2 += 1;
  }
  return ss / n2;
}

function rate(argPath, forced) {
  // A .json input is a map spec: resolve its terrain bin + gain/tile so the
  // report reflects the map as played, not the bare field.
  let bin = argPath, s = {};
  if (argPath.endsWith('.json')) {
    s = JSON.parse(fs.readFileSync(argPath, 'utf8'));
    bin = path.join(path.dirname(argPath), s.terrain ?? path.basename(argPath, '.json') + '.bin');
  } else { s = spec(argPath); }
  const buf = fs.readFileSync(bin);
  const w = buf.readUInt32LE(0), hh = buf.readUInt32LE(4);
  if (w !== hh || buf.byteLength !== 8 + w * hh) { return null; }
  const hs = forced.hs ?? s.heightScale ?? 1;
  const tile = forced.tile ?? (s.tileSize ?? (s.worldScale ?? 1500));
  const texel = tile / w;
  const mPerByte = 125 * hs / 255;
  const raw = buf.subarray(8);
  const N = w;

  const H = new Float64Array(N * N);
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < N * N; i += 1) { const v = raw[i] * mPerByte; H[i] = v; if (v < mn) { mn = v; } if (v > mx) { mx = v; } sum += v; }
  const mean = sum / (N * N), relief = mx - mn, sd = Math.sqrt(H.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (N * N));
  const hypso = relief > 0 ? (mean - mn) / relief : 0.5;

  const at = (F, x, y) => F[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const slope = new Float32Array(N * N);
  let convex = 0, concave = 0, planar = 0;
  const band = new Float64Array(BANDS.length);
  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      const i = y * N + x, c = H[i];
      const hl = at(H, x - 1, y), hr = at(H, x + 1, y), hu = at(H, x, y - 1), hd = at(H, x, y + 1);
      const d = Math.atan(Math.hypot((hr - hl) / (2 * texel), (hd - hu) / (2 * texel))) * DEG;
      slope[i] = d;
      const lap = hl + hr + hu + hd - 4 * c;
      if (lap < -1e-6) { convex += 1; } else if (lap > 1e-6) { concave += 1; } else { planar += 1; }
      for (let b = 0; b < BANDS.length; b += 1) { if (d >= BANDS[b][0] && d < BANDS[b][1]) { band[b] += 1; break; } }
    }
  }
  const sorted = Float32Array.from(slope).sort();
  const pctile = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const meanSlope = slope.reduce((a, v) => a + v, 0) / (N * N);

  // SCALE — grade at fixed WORLD block sizes so maps of different texel
  // resolution compare fairly. coarse/fine = grade@64m / grade@8m: high means
  // big coherent hills carry the grade, low means it lives in fine bumps.
  const scale = [];
  for (const m of SCALE_WORLD) { const B = Math.max(1, Math.round(m / texel)); if (N / B < 3) { break; } scale.push([B * texel, scaleSlope(H, N, texel, B)]); }
  const near = (m) => scale.reduce((b, e) => (Math.abs(e[0] - m) < Math.abs(b[0] - m) ? e : b), scale[0]);
  const fineEntry = near(FINE_M), coarseEntry = near(COARSE_M);
  const gradeRatio = fineEntry[1] > 1e-6 ? coarseEntry[1] / fineEntry[1] : 0;

  // SHAPE — chatter above the ski scale, and ridge/valley structure (TPI).
  const Rc = Math.max(1, Math.round(SMOOTH_M / texel));
  const sm = boxBlur(H, N, Rc);
  let rs = 0, rq = 0;
  for (let i = 0; i < N * N; i += 1) { const r = H[i] - sm[i]; rs += r; rq += r * r; }
  const chatter = Math.sqrt(Math.max(0, rq / (N * N) - (rs / (N * N)) ** 2));
  const smLo = boxBlur(H, N, Math.max(1, Math.round(TPI_LOCAL_M / texel)));
  const smHi = boxBlur(H, N, Math.max(1, Math.round(TPI_REGION_M / texel)));
  let ridge = 0, valley = 0;
  const TPI_T = 2; // meters
  for (let i = 0; i < N * N; i += 1) { const t = smLo[i] - smHi[i]; if (t > TPI_T) { ridge += 1; } else if (t < -TPI_T) { valley += 1; } }

  // smoothed gradient, for fall lines (follows the hillshape, not texel noise)
  const gxs = new Float32Array(N * N), gys = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
    gxs[y * N + x] = (at(sm, x + 1, y) - at(sm, x - 1, y)) / (2 * texel);
    gys[y * N + x] = (at(sm, x, y + 1) - at(sm, x, y - 1)) / (2 * texel);
  }
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // LINE — monotone fall line from sampled drops: how much drop a descent can
  // hold before the hillshape flattens (strictly descending on the 30m surface).
  const rng = mulberry32(12345);
  const SAMP = Math.min(16000, N * N);
  const fallDrop = [], fallLen = [];
  const thr = Math.tan(FALL_MIN_DEG / DEG);
  for (let k = 0; k < SAMP; k += 1) {
    let x = Math.floor(rng() * N), y = Math.floor(rng() * N);
    let len = 0, h0 = sm[y * N + x], hlo = h0, steps = 0;
    while (steps < FALL_STEP_CAP) {
      if (Math.hypot(gxs[y * N + x], gys[y * N + x]) < thr) { break; }
      let bx = x, by = y, bc = sm[y * N + x];
      for (const [dx, dy] of N8) { const v = at(sm, x + dx, y + dy); if (v < bc) { bc = v; bx = ((x + dx) % N + N) % N; by = ((y + dy) % N + N) % N; } }
      if (bx === x && by === y) { break; }
      len += (bx !== x && by !== y) ? texel * 1.4142 : texel;
      if (bc < hlo) { hlo = bc; }
      x = bx; y = by; steps += 1;
    }
    fallDrop.push(h0 - hlo); fallLen.push(len);
  }
  fallDrop.sort((a, b) => a - b); fallLen.sort((a, b) => a - b);

  // channelisation — D8 accumulation share held by the top 1% of cells.
  let channelTopShare = -1;
  if (N <= 1300) {
    const recv = new Int32Array(N * N).fill(-1);
    const order = Array.from({ length: N * N }, (_, i) => i).sort((a, b) => H[b] - H[a]);
    for (let i = 0; i < N * N; i += 1) {
      const x = i % N, y = (i / N) | 0; let bc = H[i], bi = -1;
      for (const [dx, dy] of N8) { const v = at(H, x + dx, y + dy); if (v < bc) { bc = v; bi = (((y + dy) % N + N) % N) * N + (((x + dx) % N + N) % N); } }
      recv[i] = bi;
    }
    const acc = new Float64Array(N * N).fill(1);
    for (const i of order) { const r = recv[i]; if (r >= 0) { acc[r] += acc[i]; } }
    const top = Float64Array.from(acc).sort();
    const cut = top[Math.floor(top.length * 0.99)];
    let big = 0, tot = 0;
    for (let i = 0; i < acc.length; i += 1) { tot += acc[i]; if (acc[i] >= cut) { big += acc[i]; } }
    channelTopShare = big / tot;
  }

  let walk = 0, flat = 0;
  for (let i = 0; i < N * N; i += 1) { if (slope[i] < 38) { walk += 1; } if (slope[i] < 3) { flat += 1; } }
  const km2 = (tile * tile) / 1e6;

  return {
    name: path.relative(path.join(__dirname, '..', '..'), bin).replaceAll('\\', '/'),
    N, tile, texel, hs, relief, sd, hypso, meanSlope, medSlope: pctile(sorted, 0.5), p90Slope: pctile(sorted, 0.9),
    bands: BANDS.map((b, i) => [b[2], band[i] / (N * N)]),
    scale, gradeRatio, coarseSlope: coarseEntry[1], fineSlope: fineEntry[1],
    convex: convex / (N * N), concave: concave / (N * N), planar: planar / (N * N),
    chatter, ridge: ridge / (N * N), valley: valley / (N * N),
    fallDropMed: fallDrop[Math.floor(fallDrop.length * 0.5)], fallDropP90: fallDrop[Math.floor(fallDrop.length * 0.9)],
    fallLenMed: fallLen[Math.floor(fallLen.length * 0.5)], fallLenP90: fallLen[Math.floor(fallLen.length * 0.9)],
    channelTopShare, walk: walk / (N * N), flat: flat / (N * N), km2,
  };
}

/** Rate every T2-port spec (maps/*.json whose terrain lives under t2/). */
function referenceResults() {
  const mapsDir = path.join(__dirname, '..', '..', 'maps');
  const refs = [];
  for (const file of fs.readdirSync(mapsDir)) {
    if (!file.endsWith('.json')) { continue; }
    const full = path.join(mapsDir, file);
    let s; try { s = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const t = (s.terrain ?? '').replaceAll('\\', '/');
    if (!t.startsWith('t2/')) { continue; }
    try { const r = rate(full, {}); if (r) { r.name = path.basename(file, '.json'); refs.push(r); } } catch { /* skip unreadable */ }
  }
  return refs;
}

/** Per-metric distributions (ascending) + a median/IQR summary. */
function refIndex(refs) {
  const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const idx = {};
  for (const [axis, label, get, unit, dp] of REF_METRICS) {
    const vals = refs.map(get).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length === 0) { continue; }
    idx[label] = { axis, label, get, unit, dp, vals, med: q(vals, 0.5), q1: q(vals, 0.25), q3: q(vals, 0.75) };
  }
  return idx;
}

const dispVal = (label, v) => v * (PCT_SCALE[label] ?? 1);

const bins = process.argv.slice(2).filter((a) => a.endsWith('.bin') || a.endsWith('.json'));
const out = [];
for (const bin of bins) {
  try { const r = rate(bin, { hs: opt('hs'), tile: opt('tile') }); if (r) { r.name = bin.endsWith('.json') ? path.basename(bin, '.json') : r.name; out.push(r); } } catch (e) { console.error(bin, 'FAILED', e.message); }
}

// --ref: locate each result inside the T2-port population, per axis.
let REF = null, REF_IDX = null;
if (process.argv.includes('--ref')) {
  REF = referenceResults();
  REF_IDX = refIndex(REF);
  for (const r of out) {
    r.percentiles = {};
    for (const label of Object.keys(REF_IDX)) {
      const m = REF_IDX[label];
      const v = m.get(r);
      if (!Number.isFinite(v)) { continue; }
      r.percentiles[label] = { value: v, pctl: fracBelow(m.vals, v) };
    }
  }
}

if (WANT_JSON) { console.log(JSON.stringify(REF ? { refN: REF.length, maps: out } : out, null, 2)); process.exit(0); }

const f = (v, d = 0) => v.toFixed(d);
for (const r of out) {
  const bd = r.bands.map(([n, v]) => `${n} ${f(v * 100)}%`).join('  ');
  const sc = r.scale.map(([m, v]) => `${m >= 1000 ? f(m / 1000, 1) + 'k' : f(m)}m:${f(v)}`).join(' ');
  console.log(`${r.name}  ${r.N}²@${f(r.texel, 2)}m/t  ${r.tile}m  hs${r.hs}`);
  console.log(`  RELIEF  relief ${f(r.relief)}m  sd ${f(r.sd)}m  hyps ${f(r.hypso, 2)}`);
  console.log(`  GRADE   mean ${f(r.meanSlope)}°  med ${f(r.medSlope)}°  p90 ${f(r.p90Slope)}°  |  ${bd}`);
  console.log(`  SCALE   coarse/fine ${f(r.gradeRatio, 2)}  (fine@${FINE_M}m ${f(r.fineSlope)}° -> ${COARSE_M}m ${f(r.coarseSlope)}°)  |  ${sc}`);
  console.log(`  SHAPE   convex ${f(r.convex * 100)}%  concave ${f(r.concave * 100)}%  planar ${f(r.planar * 100)}%  ridge ${f(r.ridge * 100)}%  valley ${f(r.valley * 100)}%  chatter ${f(r.chatter, 1)}m`);
  console.log(`  LINE    fall-line drop med ${f(r.fallDropMed)}m / p90 ${f(r.fallDropP90)}m  len med ${f(r.fallLenMed)}m / p90 ${f(r.fallLenP90)}m  flow-top1% ${r.channelTopShare < 0 ? 'n/a' : f(r.channelTopShare * 100) + '%'}`);
  console.log(`  PADS    walkable(<38°) ${f(r.walk * 100)}%  flat(<3°) ${f(r.flat * 100)}%  area ${f(r.km2, 2)}km²`);
  if (REF_IDX) {
    console.log(`  ── vs ${REF ? REF.length : 0} T2 ports ────────────────────────────────`);
    for (const label of Object.keys(REF_IDX)) {
      const m = REF_IDX[label], p = r.percentiles[label];
      if (!p) { continue; }
      const val = f(dispVal(label, p.value), m.dp) + m.unit;
      const refMed = f(dispVal(label, m.med), m.dp) + m.unit;
      const refIqr = `${f(dispVal(label, m.q1), m.dp)}–${f(dispVal(label, m.q3), m.dp)}${m.unit}`;
      const bar = '█'.repeat(Math.max(0, Math.round(p.pctl * 10))).padEnd(10, '·');
      console.log(`  ${m.axis.padEnd(6)} ${label.padEnd(13)} ${val.padStart(7)}  P${String(Math.round(p.pctl * 100)).padStart(2, '0')} ${bar} ${pctlWord(p.pctl).padEnd(5)}  ref med ${refMed} (IQR ${refIqr})`);
    }
    console.log('');
  }
  console.log('');
}
