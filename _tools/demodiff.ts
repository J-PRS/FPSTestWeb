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

/** Server pos for seat `idx` at server-time `t` — nearest sample within
 *  1.5s, else undefined (outside the captured window is not a match). */
const srvAt = (idx: number, t: number): RemoteFrame | undefined => {
  const fs = srvByIdx.get(idx);
  if (!fs || fs.length === 0) {return undefined;}
  let lo = 0, hi = fs.length - 1;
  while (lo < hi) {const mid = (lo + hi) >> 1; if (fs[mid]!.timestamp < t) {lo = mid + 1;} else {hi = mid;}}
  const f = fs[lo]!;
  return Math.abs(f.timestamp - t) <= 1.5 ? f : undefined;
};
const d3 = (a: { posX: number; posY: number; posZ: number }, b: { posX: number; posY: number; posZ: number }): number =>
  Math.hypot(a.posX - b.posX, a.posY - b.posY, a.posZ - b.posZ);

// ---- clock alignment -----------------------------------------------------
// The client's elapsedTime accumulates WALL-CLAMPED dt — under throttle
// (headless runs) it drifts vs the server's fixed sim clock, so no single
// offset aligns the pair. Solve the offset piecewise — but a per-SEAT
// sweep aliases on periodic patrols (a bot re-running a circuit matches
// whichever lap is nearest, yielding nonsense points). The true offset
// must align EVERY seat at once: per 4s window, score each candidate
// offset by the SUM of per-seat median posΔ — one lane's alias lap can't
// repeat across seven different trajectories.
const med = (a: number[]): number => {const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0;};
// Shared seats with enough live frames to vote.
const lanes: { cli: RemoteFrame[]; sIdx: number }[] = [];
for (const [idx, fs] of cliByIdx) {
  const sIdx = srvIdxByName.get(nameA(idx));
  const live = fs.filter((f): boolean => !(f.flags & 5));
  if (sIdx !== undefined && live.length >= 40) {lanes.push({ cli: live, sIdx });}
}
if (lanes.length === 0) {console.error('no shared moving seat to align on'); process.exit(1);}
const tMin = Math.min(...lanes.map((l): number => l.cli[0]!.timestamp));
const tMax = Math.max(...lanes.map((l): number => l.cli[l.cli.length - 1]!.timestamp));
const points: { t: number; o: number }[] = [];
for (let w = tMin; w + 4 <= tMax; w += 4) {
  let bestO = 0, bestScore = Infinity;
  for (let o = 0; o <= B.header.duration; o += 0.25) {
    let score = 0, votes = 0;
    for (const l of lanes) {
      const ds: number[] = [];
      for (const f of l.cli) {
        if (f.timestamp < w || f.timestamp >= w + 4) {continue;}
        const s = srvAt(l.sIdx, f.timestamp + o);
        if (s && !(s.flags & 4)) {ds.push(d3(f, s));}
      }
      if (ds.length >= 5) {score += med(ds); votes++;}
    }
    if (votes > 0 && score / votes < bestScore) {bestScore = score / votes; bestO = o;}
  }
  // A window that never resolved = noise, not drift — don't fit to it.
  if (bestScore < 20) {points.push({ t: w + 2, o: bestO });}
}
if (points.length === 0) {console.error('clock fit found no resolvable window — captures may not overlap'); process.exit(1);}
const offAt = (t: number): number => {
  // Linear interp over the window points — within a 4s window the drift
  // alone moves ~3s of server time, so nearest-neighbor smears edges.
  if (t <= points[0]!.t) {return points[0]!.o;}
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (t <= b.t) {return a.o + (b.o - a.o) * (t - a.t) / (b.t - a.t);}
  }
  return points.at(-1)!.o;
};
const B0 = points.length >= 2 ? (points.at(-1)!.o - points[0]!.o) / (points.at(-1)!.t - points[0]!.t) : 1;
console.log(`clock fit: ${lanes.length} lanes, ${points.length} windows, offset ${points[0]!.o.toFixed(1)}→${points.at(-1)!.o.toFixed(1)} (drift rate ${B0.toFixed(2)}x)`);

// ---- per-seat remote diff -------------------------------------------------
// Every client remote frame vs server truth at its fitted offset — the
// drift is a client-clock property so one consensus line serves all lanes.
type Stat = { n: number; sum: number; max: number; over1: number; over5: number; ds: number[] };
const stats = new Map<number, Stat>();
let overN = 0;
for (const [idx, fs] of cliByIdx) {
  const sIdx = srvIdxByName.get(nameA(idx));
  if (sIdx === undefined) {continue;}
  const live = fs.filter((f): boolean => !(f.flags & 5));
  const st: Stat = { n: 0, sum: 0, max: 0, over1: 0, over5: 0, ds: [] };
  for (const f of live) {
    const s = srvAt(sIdx, f.timestamp + offAt(f.timestamp));
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
