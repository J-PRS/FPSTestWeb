/** demodiff — the desync oracle's evidence tool. Two demos of the same
 *  match: a client capture (its lens, lossy+predicted) and the server's
 *  FPS_DEMO capture (authoritative truth). Aligns their clocks on the
 *  local player's trajectory, then for every shared seat diffs what the
 *  client SAW vs what the server SAID at that instant.
 *
 *   bun _tools/demodiff.ts <client.demo> <server.demo>
 *
 *  The client remote-frame lane is what a real observer rendered — a
 *  posΔ vs server truth at the same instant is a replica divergence
 *  (interp lag, stale record, or drop). The client's OWN frames vs the
 *  server's remote lane for that player is prediction-vs-claim truth. */
import { readFileSync } from 'node:fs';
import { deserializeDemo, type DemoFile, type RemoteFrame } from '../client/src/demo/demoReader.ts';

const [clientPath, serverPath] = process.argv.slice(2);
if (!clientPath || !serverPath) { console.error('usage: bun _tools/demodiff.ts <client.demo> <server.demo>'); process.exit(1); }
const A = deserializeDemo(readFileSync(clientPath).buffer as ArrayBuffer); // client
const B = deserializeDemo(readFileSync(serverPath).buffer as ArrayBuffer); // server

const byIdx = (d: DemoFile): Map<number, RemoteFrame[]> => {
  const m = new Map<number, RemoteFrame[]>();
  for (const f of d.remoteFrames) {
    const a = m.get(f.rosterIdx);
    if (a) {a.push(f);} else {m.set(f.rosterIdx, [f]);}
  }
  return m;
};
const srvByIdx = byIdx(B);
const cliByIdx = byIdx(A);
const nameA = (i: number): string => A.roster[i]?.name ?? `?${i}`;
const srvIdxByName = new Map(B.roster.map((r, i) => [r.name, i]));

/** Server pos for seat `idx` at server-time `t` (nearest sample). */
const srvAt = (idx: number, t: number): RemoteFrame | undefined => {
  const fs = srvByIdx.get(idx);
  if (!fs || fs.length === 0) {return undefined;}
  let lo = 0, hi = fs.length - 1;
  while (lo < hi) {const mid = (lo + hi) >> 1; if (fs[mid]!.timestamp < t) {lo = mid + 1;} else {hi = mid;}}
  return fs[lo];
};
const d3 = (a: { posX: number; posY: number; posZ: number }, b: { posX: number; posY: number; posZ: number }): number =>
  Math.hypot(a.posX - b.posX, a.posY - b.posY, a.posZ - b.posZ);

// ---- clock alignment -----------------------------------------------------
// The client's elapsedTime accumulates WALL-CLAMPED dt — under throttle
// (headless runs) it drifts vs the server's fixed sim clock, so no single
// offset aligns the pair. Solve the offset piecewise: per 4s window of a
// moving shared seat, sweep for the offset minimizing median posΔ, then
// least-squares a line off(t)=a+b·t over the window solutions.
const med = (a: number[]): number => {const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0;};
let anchorIdx = -1, anchorSIdx = -1, anchorMed = Infinity;
for (const [idx, fs] of cliByIdx) {
  const sIdx = srvIdxByName.get(nameA(idx));
  if (sIdx === undefined || fs.length < 50) {continue;}
  const all = fs.filter((f): boolean => !(f.flags & 5));
  if (all.length < 40) {continue;}
  let bestMed = Infinity;
  for (let off = 0; off <= B.header.duration - A.header.duration; off += 0.5) {
    const ds: number[] = [];
    for (let i = 0; i < all.length; i += 10) {
      const s = srvAt(sIdx, all[i]!.timestamp + off);
      if (s && !(s.flags & 4)) {ds.push(d3(all[i]!, s));}
    }
    const m = med(ds);
    if (m < bestMed) {bestMed = m;}
  }
  if (bestMed < anchorMed) {anchorMed = bestMed; anchorIdx = idx; anchorSIdx = sIdx;}
}
if (anchorIdx < 0) {console.error('no shared moving seat to align on'); process.exit(1);}
// Piecewise offsets on the anchor seat → drift line.
const anchorFs = (cliByIdx.get(anchorIdx) ?? []).filter((f): boolean => !(f.flags & 5));
const tMin = anchorFs[0]?.timestamp ?? 0, tMax = anchorFs[anchorFs.length - 1]?.timestamp ?? 0;
const points: { t: number; o: number }[] = [];
for (let w = tMin; w + 4 <= tMax; w += 4) {
  const ws = anchorFs.filter((f): boolean => f.timestamp >= w && f.timestamp < w + 4);
  if (ws.length < 8) {continue;}
  let bestO = 0, bestM = Infinity;
  for (let o = 0; o <= B.header.duration; o += 0.25) {
    const ds = ws.map((f): number => {const s = srvAt(anchorSIdx, f.timestamp + o); return s && !(s.flags & 4) ? d3(f, s) : NaN;}).filter((d): boolean => !Number.isNaN(d));
    const m = med(ds);
    if (m < bestM) {bestM = m; bestO = o;}
  }
  if (bestM < 20) {points.push({ t: w + 2, o: bestO });} // a window that never resolved = noise, not drift
}
let A0 = 0, B0 = 0;
if (points.length >= 2) {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.t, 0), sy = points.reduce((s, p) => s + p.o, 0);
  const sxx = points.reduce((s, p) => s + p.t * p.t, 0), sxy = points.reduce((s, p) => s + p.t * p.o, 0);
  const d = n * sxx - sx * sx;
  if (Math.abs(d) > 1e-9) {B0 = (n * sxy - sx * sy) / d; A0 = (sy - B0 * sx) / n;}
}
const offAt = (t: number): number => A0 + B0 * t;
console.log(`clock fit on ${nameA(anchorIdx)}: offset(t)=${A0.toFixed(1)}+${B0.toFixed(3)}·t over ${points.length} windows (client-rate ${B0.toFixed(2)}x server)`);

// ---- per-seat remote diff -------------------------------------------------
// Every client remote frame vs server truth — but each seat gets its own
// piecewise alignment (a shared drift line under-fits: throttle is
// bursty, and seats with dead stretches anchor poorly on one rate).
type Stat = { n: number; sum: number; max: number; over1: number; over5: number; ds: number[] };
const stats = new Map<number, Stat>();
let overN = 0;
for (const [idx, fs] of cliByIdx) {
  const sIdx = srvIdxByName.get(nameA(idx));
  if (sIdx === undefined) {continue;}
  const live = fs.filter((f): boolean => !(f.flags & 5));
  // This seat's own window offsets — the drift is a client-clock property
  // so every lane shares it, but per-seat fitting also absorbs a lane
  // that started mid-window.
  const lo = live[0]?.timestamp ?? 0, hi = live[live.length - 1]?.timestamp ?? 0;
  const pts: { t: number; o: number }[] = [];
  for (let w = lo; w + 4 <= hi; w += 4) {
    const ws = live.filter((f): boolean => f.timestamp >= w && f.timestamp < w + 4);
    if (ws.length < 8) {continue;}
    let bestO = 0, bestM = Infinity;
    for (let o = 0; o <= B.header.duration; o += 0.25) {
      const ds = ws.map((f): number => {const s = srvAt(sIdx, f.timestamp + o); return s && !(s.flags & 4) ? d3(f, s) : NaN;}).filter((d): boolean => !Number.isNaN(d));
      const m = med(ds);
      if (m < bestM) {bestM = m; bestO = o;}
    }
    if (bestM < 25) {pts.push({ t: w + 2, o: bestO });}
  }
  // Offsets by nearest fit point (drift is smooth; linear interp beats
  // least-squares on noisy windows).
  const off = (t: number): number => {
    if (pts.length === 0) {return A0 + B0 * t;}
    let p = pts[0]!;
    for (const q of pts) {if (Math.abs(q.t - t) < Math.abs(p.t - t)) {p = q;}}
    return p.o;
  };
  const st: Stat = { n: 0, sum: 0, max: 0, over1: 0, over5: 0, ds: [] };
  for (const f of live) {
    const s = srvAt(sIdx, f.timestamp + off(f.timestamp));
    if (!s || s.flags & 4) {continue;}
    const d = d3(f, s);
    st.n += 1; st.sum += d; st.max = Math.max(st.max, d); st.ds.push(d);
    if (d > 1) {st.over1 += 1; overN += 1;}
    if (d > 5) {st.over5 += 1;}
  }
  stats.set(idx, st);
}
console.log('\nseat              n      meanΔ   p95     max    >1m   >5m');
for (const [idx, st] of [...stats].sort((a, b) => b[1].max - a[1].max)) {
  const mean = st.n ? st.sum / st.n : 0;
  const p95 = st.ds.length ? [...st.ds].sort((x, y) => x - y)[Math.floor(st.ds.length * 0.95)]! : 0;
  console.log(`${nameA(idx).padEnd(16)} ${String(st.n).padStart(5)} ${mean.toFixed(2).padStart(7)} ${p95.toFixed(1).padStart(6)} ${st.max.toFixed(1).padStart(6)} ${String(st.over1).padStart(5)} ${String(st.over5).padStart(5)}`);
}
console.log(`\ntotal divergent remote samples (>1m): ${overN}`);

// ---- event census ---------------------------------------------------------
const ev = (d: DemoFile): Record<string, number> => {
  const m: Record<string, number> = {};
  for (const e of d.projectileEvents) {m[`proj:${e.eventType}`] = (m[`proj:${e.eventType}`] ?? 0) + 1;}
  for (const e of d.targetEvents) {m[`tgt:${e.targetType}:${e.eventType}`] = (m[`tgt:${e.targetType}:${e.eventType}`] ?? 0) + 1;}
  return m;
};
const ea = ev(A), eb = ev(B);
console.log('\nprojectile events — client:', JSON.stringify(ea));
console.log('projectile events — server:', JSON.stringify(eb));
