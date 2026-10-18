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
  ['SOAK',   'dead p50',   (r) => r.soakDead.p50, 'm/s', 0],
  ['SOAK',   'moved',      (r) => r.soakDead.movedPct, '%', 0],
  ['SOAK',   'jet p50',    (r) => r.soakJet.p50,  'm/s', 0],
  ['SIGHT',  'LOS p50',    (r) => r.los.p50,      'm', 0],
  ['SIGHT',  'crest-basin',(r) => r.los.crest - r.los.basin, 'm', 0],
  ['TRAP',   'trapped',    (r) => r.trap.pct,     '%', 0],
];
const PCT_SCALE = { walkable: 100, moved: 100, trapped: 100 }; // fraction -> percent for display

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

  // BALL SOAK - drop N balls, ski for 10s, report speed percentiles.
  // Two passes: dead ball (gravity only) and "jetted" — a dumb thrust model
  // using the real jet numbers (shared/movement.ts: up 35, dir 10 capped at
  // 50 m/s, 15/s drain, 8/s charge, 0.5s lockout). Thrust fires while
  // airborne, while moving uphill, or below 8 m/s; the dead-vs-jet delta is
  // how much work the terrain asks of the skier.
  const SOAK_N = 500, SOAK_DT = 1/60, SOAK_T = 10, SOAK_STEPS = Math.round(SOAK_T / SOAK_DT);
  const rng2 = mulberry32(999);
  const dropSeeds = [];
  for (let k = 0; k < SOAK_N; k += 1) { dropSeeds.push([rng2() * N, rng2() * N]); }
  function runSoak(jetted) {
    const speeds = []; let moved = 0, peak = 0, thrust = 0;
    const snaps = [[120, [], [], []], [300, [], [], []], [600, [], [], []]]; // [step, speeds, paths, displacements] @2/5/10s per-ball
    for (let k = 0; k < SOAK_N; k += 1) {
      let x = Math.floor(dropSeeds[k][0]), z = Math.floor(dropSeeds[k][1]);
      const x0 = x * texel, z0 = z * texel;
      let y = H[z * N + x] + 0.7;
      let vx = 0, vy = 0, vz = 0, grounded = true;
      let energy = 100, lockout = 0, ballPeak = 0, dist = 0;
      // Wish heading — a player thrusts where they aim, not along velocity,
      // or a ball at rest could never start moving.
      const wa = (k * 2.399963) % (Math.PI * 2), wx0 = Math.cos(wa), wz0 = Math.sin(wa);
      for (let s = 0; s < SOAK_STEPS; s += 1) {
        const gh = at(H, Math.round(x), Math.round(z));
        if (y - 0.4 <= gh + 0.6) { grounded = true; y = gh + 0.4; vy = Math.max(vy, 0); } else { grounded = false; }
        const xi = Math.round(x), zi = Math.round(z);
        const gx = (at(H, xi + 1, zi) - at(H, xi - 1, zi)) / (2 * texel);
        const gz = (at(H, xi, zi + 1) - at(H, xi, zi - 1)) / (2 * texel);
        const uphill = vx * gx + vz * gz > 0;
        const sp0 = Math.hypot(vx, vz);
        const wantAir = !grounded && (vy < 0 || y - gh < 8); // jet to crest/catch a fall, not to orbit
        const thrusting = jetted && energy > 0 && lockout <= 0 && (wantAir || (grounded && (uphill || sp0 < 8)));
        // Force/mass like the sim (medium 1.15): 30.4 up, 8.7 along velocity,
        // and a held jet LIFTS off the ground — same no-dead-zone rule the
        // sim uses — so uphill thrust launches instead of just pushing.
        if (thrusting) {
          vy += 30 * SOAK_DT;
          if (grounded && vy > 0) { grounded = false; y += 0.01; }
          const tx = sp0 > 2 ? vx / sp0 : wx0, tz = sp0 > 2 ? vz / sp0 : wz0;
          const fwd = vx * tx + vz * tz;
          if (fwd < 50) { vx += tx * 9 * SOAK_DT; vz += tz * 9 * SOAK_DT; }
        }
        if (grounded) {
          const glen = Math.hypot(gx, gz);
          if (glen > 1e-4) {
            const sinT = glen / Math.sqrt(1 + glen * glen);
            const ax = -(gx / glen) * 9.81 * sinT;
            const az = -(gz / glen) * 9.81 * sinT;
            vx += ax * SOAK_DT; vz += az * SOAK_DT;
          }
        } else {
          vy -= 9.81 * SOAK_DT;
        }
        if (jetted) {
          if (thrusting) { thrust += SOAK_DT; energy -= 15 * SOAK_DT; if (energy <= 0) { energy = 0; lockout = 0.5; } }
          else { energy = Math.min(100, energy + 8 * SOAK_DT); }
          lockout = Math.max(0, lockout - SOAK_DT);
        }
        const sp = Math.hypot(vx, vz);
        if (sp > 80) { vx = vx / sp * 80; vz = vz / sp * 80; }
        dist += sp * SOAK_DT; // vx/vz are world m/s — path length in meters
        const xm = (x * texel + vx * SOAK_DT + 1500) % 1500;
        const zm = (z * texel + vz * SOAK_DT + 1500) % 1500;
        x = xm / texel; z = zm / texel;
        const gh2 = at(H, Math.round(x), Math.round(z));
        if (grounded) { y = gh2 + 0.4; } else { y += vy * SOAK_DT; if (y < gh2 + 0.4) { y = gh2 + 0.4; vy = 0; grounded = true; } }
        if (sp > ballPeak) { ballPeak = sp; }
        for (const [step, sarr, darr, parr] of snaps) {
          if (s === step - 1) {
            sarr.push(Math.hypot(vx, vy, vz));
            darr.push(dist);
            // Toroidal displacement — how far from the drop, not how far traveled.
            const dx = x * texel - x0, dz = z * texel - z0;
            const wdx = dx - Math.round(dx / tile) * tile, wdz = dz - Math.round(dz / tile) * tile;
            parr.push(Math.hypot(wdx, wdz));
          }
        }
      }
      const sp = Math.hypot(vx, vy, vz);
      speeds.push(sp);
      peak += ballPeak;
      if (sp > 5) { moved += 1; }
    }
    speeds.sort((a, b) => a - b);
    const p = (q) => speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * q))];
    const snapP50 = snaps.map(([, sarr]) => { sarr.sort((a, b) => a - b); return sarr[Math.floor(sarr.length * 0.5)]; });
    const snapDistP50 = snaps.map(([, , darr]) => { darr.sort((a, b) => a - b); return darr[Math.floor(darr.length * 0.5)]; });
    const snapDispP50 = snaps.map(([, , , parr]) => { parr.sort((a, b) => a - b); return parr[Math.floor(parr.length * 0.5)]; });
    return { p10: p(0.1), p25: p(0.25), p50: p(0.5), p75: p(0.75), p90: p(0.9), mean: speeds.reduce((a, v) => a + v, 0) / speeds.length, peakMean: peak / SOAK_N, movedPct: moved / SOAK_N, thrustPct: thrust / (SOAK_T * SOAK_N), snapP50, snapDistP50, snapDispP50 };
  }
  const soakDead = runSoak(false), soakJet = runSoak(true);
  let walk = 0, flat = 0;
  for (let i = 0; i < N * N; i += 1) { if (slope[i] < 38) { walk += 1; } if (slope[i] < 3) { flat += 1; } }
  const km2 = (tile * tile) / 1e6;

  // SIGHT — viewshed line-of-sight: from ~2000 points cast 16 rays and march
  // the horizon angle; a ray's reach is the farthest ground whose elevation
  // angle clears everything nearer (eye/target +2m). Split crest vs basin so
  // "defender sees far, attacker hides" reads as a number, not a vibe.
  const LOS_MAX = Math.min(600, tile / 2 - 2 * texel), LOS_STEP = Math.max(2 * texel, 1);
  const losAll = [], losCrest = [], losBasin = [];
  {
    const eye = 2, RAYS = 16, losRng = mulberry32(777);
    const tpi = (x, y) => smLo[y * N + x] - smHi[y * N + x];
    for (let k = 0; k < 2000; k += 1) {
      const x = Math.floor(losRng() * N), y = Math.floor(losRng() * N);
      const h0 = at(H, x, y) + eye;
      let reach = 0;
      for (let r = 0; r < RAYS; r += 1) {
        const a = (r / RAYS) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        let maxAng = -Infinity, lastVis = 0;
        for (let d = LOS_STEP; d <= LOS_MAX; d += LOS_STEP) {
          const hx = Math.round(x + ca * d / texel), hz = Math.round(y + sa * d / texel);
          const ang = (at(H, hx, hz) + eye - h0) / d;
          if (ang >= maxAng) { maxAng = ang; lastVis = d; }
        }
        reach += lastVis;
      }
      reach /= RAYS;
      losAll.push(reach);
      const t = tpi(x, y);
      if (t > TPI_T) { losCrest.push(reach); } else if (t < -TPI_T) { losBasin.push(reach); }
    }
    losAll.sort((a, b) => a - b); losCrest.sort((a, b) => a - b); losBasin.sort((a, b) => a - b);
  }
  const losP = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : NaN;

  // TRAP — depression fill (priority-flood): pour water in through the
  // global minimum; cells whose fill level exceeds their height sit inside
  // a closed basin, and depth = how deep. A ball that stalls in one can
  // only leave by jetting, so "trapped" = deeper than a jet climb (~18m).
  // Toroidal: no boundary to spill off, so the map minimum IS the sink.
  const JET_ESCAPE = 18;
  let trapArea = 0, pitCells = 0, trapDepthSum = 0, trapDepthMax = 0, trapDepths = [];
  if (N <= 1300) {
    const visited = new Uint8Array(N * N);
    // binary min-heap of [fill, idx] packed flat
    const heap = [];
    const hpush = (f, i) => { heap.push(f, i); let c = heap.length / 2 - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p * 2] <= heap[c * 2]) { break; } for (const o of [0, 1]) { const t = heap[p * 2 + o]; heap[p * 2 + o] = heap[c * 2 + o]; heap[c * 2 + o] = t; } c = p; } };
    const hpop = () => { const f = heap[0], i = heap[1]; const li = heap.pop(), lf = heap.pop(); if (heap.length) { heap[0] = lf; heap[1] = li; let p = 0; for (;;) { const l = p * 2 + 1, r = l + 1; let s = p; if (l < heap.length / 2 && heap[l * 2] < heap[s * 2]) { s = l; } if (r < heap.length / 2 && heap[r * 2] < heap[s * 2]) { s = r; } if (s === p) { break; } for (const o of [0, 1]) { const t = heap[p * 2 + o]; heap[p * 2 + o] = heap[s * 2 + o]; heap[s * 2 + o] = t; } p = s; } } return [f, i]; };
    let mini = 0;
    for (let i = 1; i < N * N; i += 1) { if (H[i] < H[mini]) { mini = i; } }
    hpush(H[mini], mini); visited[mini] = 1;
    while (heap.length) {
      const [fill, i] = hpop();
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of N8) {
        const nx = ((x + dx) % N + N) % N, ny = ((y + dy) % N + N) % N, ni = ny * N + nx;
        if (visited[ni]) { continue; }
        visited[ni] = 1;
        const nf = Math.max(H[ni], fill);
        const depth = nf - H[ni];
        if (depth > 0.5) {
          pitCells += 1;
          if (depth > JET_ESCAPE) { trapArea += 1; trapDepthSum += depth; trapDepths.push(depth); if (depth > trapDepthMax) { trapDepthMax = depth; } }
        }
        hpush(nf, ni);
      }
    }
    trapDepths.sort((a, b) => a - b);
  }
  const trapP50 = trapDepths.length ? trapDepths[Math.floor(trapDepths.length * 0.5)] : 0;

  return {
    name: path.relative(path.join(__dirname, '..', '..'), bin).replaceAll('\\', '/'),
    N, tile, texel, hs, relief, sd, hypso, meanSlope, medSlope: pctile(sorted, 0.5), p90Slope: pctile(sorted, 0.9),
    bands: BANDS.map((b, i) => [b[2], band[i] / (N * N)]),
    scale, gradeRatio, coarseSlope: coarseEntry[1], fineSlope: fineEntry[1],
    convex: convex / (N * N), concave: concave / (N * N), planar: planar / (N * N),
    chatter, ridge: ridge / (N * N), valley: valley / (N * N),
    fallDropMed: fallDrop[Math.floor(fallDrop.length * 0.5)], fallDropP90: fallDrop[Math.floor(fallDrop.length * 0.9)],
    fallLenMed: fallLen[Math.floor(fallLen.length * 0.5)], fallLenP90: fallLen[Math.floor(fallLen.length * 0.9)],
    channelTopShare, walk: walk / (N * N), flat: flat / (N * N), km2, soakDead, soakJet,
    los: { p10: losP(losAll, 0.1), p50: losP(losAll, 0.5), p90: losP(losAll, 0.9), crest: losP(losCrest, 0.5), basin: losP(losBasin, 0.5) },
    trap: { pct: N <= 1300 ? trapArea / (N * N) : -1, pitPct: N <= 1300 ? pitCells / (N * N) : -1, med: trapP50, max: trapDepthMax },
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
  console.log(`  SOAK    dead p50 @2s ${f(r.soakDead.snapP50[0])} @5s ${f(r.soakDead.snapP50[1])} @10s ${f(r.soakDead.snapP50[2])}  p90 ${f(r.soakDead.p90)}  peak ${f(r.soakDead.peakMean)}  moved ${(r.soakDead.movedPct*100).toFixed(0)}%  |  jet @2/5/10 ${r.soakJet.snapP50.map((v) => f(v)).join('/')}  burn ${(r.soakJet.thrustPct*100).toFixed(0)}%  (m/s)`);
  console.log(`  DIST    path p50 @2s ${f(r.soakDead.snapDistP50[0])}m @5s ${f(r.soakDead.snapDistP50[1])}m @10s ${f(r.soakDead.snapDistP50[2])}m  |  jet @2/5/10 ${r.soakJet.snapDistP50.map((v) => f(v)).join('/')}m`);
  console.log(`          disp p50 @2s ${f(r.soakDead.snapDispP50[0])}m @5s ${f(r.soakDead.snapDispP50[1])}m @10s ${f(r.soakDead.snapDispP50[2])}m  |  jet @2/5/10 ${r.soakJet.snapDispP50.map((v) => f(v)).join('/')}m  (disp/path = directedness)`);
  console.log(`  SIGHT   LOS p10 ${f(r.los.p10)}m  p50 ${f(r.los.p50)}m  p90 ${f(r.los.p90)}m  |  crest ${f(r.los.crest)}m  basin ${f(r.los.basin)}m`);
  console.log(`  TRAP    trapped ${r.trap.pct < 0 ? 'n/a' : f(r.trap.pct * 100) + '%'}  basins ${r.trap.pitPct < 0 ? 'n/a' : f(r.trap.pitPct * 100) + '%'}  depth med ${f(r.trap.med)}m  max ${f(r.trap.max)}m  (>18m = can't ski out)`);
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
