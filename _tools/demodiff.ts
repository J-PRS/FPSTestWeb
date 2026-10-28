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
import { TargetEventType, ProjectileEventType, TARGETTYPE_KILL, TARGETTYPE_FLAG } from '../client/src/demo/types.ts';

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
  // o may go negative: the client's wire-clock stamps remote frames at
  // server-uptime (room-shared), while the server demo's this.t counts
  // from room mint — a client in a room minted seconds into server life
  // leads the demo clock by that margin. Sweep both directions.
  for (let o = -B.header.duration; o <= B.header.duration; o += 0.25) {
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
const BYTIME = process.argv.includes('--bytime');
const timeBins = new Map<number, { n: number; sum: number; max: number; over1: number }>();
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
    // --bytime: where does divergence LIVE — join-window or steady drift.
    if (BYTIME) {
      const b = Math.floor(f.timestamp / 5) * 5;
      const e = timeBins.get(b) ?? { n: 0, sum: 0, max: 0, over1: 0 };
      e.n += 1; e.sum += d; e.max = Math.max(e.max, d); if (d > 1) {e.over1 += 1;}
      timeBins.set(b, e);
    }
  }
  stats.set(idx, st);
}
if (BYTIME) {
  console.log('\ntime   n    meanΔ   max   >1m');
  for (const [b, e] of [...timeBins].sort((a, c) => a[0] - c[0])) {
    console.log(`${String(b).padStart(4)}s ${String(e.n).padStart(5)} ${(e.sum / e.n).toFixed(2).padStart(7)} ${e.max.toFixed(1).padStart(6)} ${String(e.over1).padStart(5)}`);
  }
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

// ---- paired event truth --------------------------------------------------
// The census only balances COUNTS — a client that dropped one edge and
// fabricated another still balances. Pair each server-side edge to the
// client event it must have produced: same (type, id, eventType) and the
// nearest timestamp inside tolerance of the fitted clock offset. A server
// event with no client match = the wire dropped it; a client event with
// no server match = the client fabricated it. This is the damage-truth
// pass — kills, spawns and despawns are edges, not positions.
const EV_TOL = 0.75;
type Ev = { t: number; key: string; aux: string; x: number; y: number; z: number };

// Roster idxs differ across the two tapes — KILL ids (victim + the
// peakPosX shooter slot) must ride the name map, not the raw number.
const cliIdxToSrv = new Map<number, number>();
for (let i = 0; i < A.roster.length; i += 1) {
  const s = srvIdxByName.get(A.roster[i]!.name);
  if (s !== undefined) {cliIdxToSrv.set(i, s);}
}

const tgtKey = (e: { targetType: number; targetId: number; eventType: number; hasPeakPosition: boolean; peakPosX: number; health: number }, idxMap?: Map<number, number>): string => {
  const kill = e.targetType === TARGETTYPE_KILL;
  const id = kill && idxMap ? (idxMap.get(e.targetId) ?? -1) : e.targetId;
  const shooter = kill && e.hasPeakPosition
    ? (idxMap ? (idxMap.get(e.peakPosX - 1) ?? -2) + 1 : e.peakPosX)
    : e.peakPosX;
  // The two tapes name kills differently — client recordKill writes
  // StateChanged, server roomDemo writes Destroyed. Same edge, one code.
  const et = kill && e.eventType === TargetEventType.StateChanged ? TargetEventType.Destroyed : e.eventType;
  return `${e.targetType}:${id}:${et}${kill ? `:w${e.health}s${shooter}` : ''}`;
};
// Only event types the server emits can pair — client-only lanes
// (Bounce/Peak, deploy-derivative Hit) would all read as fabrications.
// Hit pairs ONLY on the KILL lane (playerHit edges ride both tapes).
// Spawned is excluded from the FLAG lane: the client emits a baseline
// flag spawn at join, the server only emits StateChanged edges.
const PAIRED_TGT = new Set<number>([TargetEventType.Spawned, TargetEventType.Destroyed, TargetEventType.StateChanged, TargetEventType.Hit]);
const tgtPairable = (e: { targetType: number; eventType: number }): boolean =>
  PAIRED_TGT.has(e.eventType)
  && (e.eventType !== TargetEventType.Hit || e.targetType === TARGETTYPE_KILL)
  && !(e.eventType === TargetEventType.Spawned && e.targetType === TARGETTYPE_FLAG);
const PAIRED_PROJ = new Set<number>([ProjectileEventType.Fired, ProjectileEventType.Destroyed]);

const mkTgt = (d: DemoFile, idxMap?: Map<number, number>): Ev[] =>
  d.targetEvents.filter(tgtPairable)
    .map((e): Ev => ({ t: e.timestamp, key: tgtKey(e, idxMap), aux: `h${e.health}`, x: e.posX, y: e.posY, z: e.posZ }));
const mkProj = (d: DemoFile): Ev[] =>
  d.projectileEvents.filter((e): boolean => PAIRED_PROJ.has(e.eventType))
    .map((e): Ev => ({ t: e.timestamp, key: `${e.eventType}:${e.weaponType}`, aux: '', x: e.posX, y: e.posY, z: e.posZ }));

let evMissed = 0, evMissedGated = 0, evFabricated = 0, evKillFab = 0;
/** Greedy nearest-time pairing per key. Server timestamps are truth-domain;
 *  client events come in through offAt() to land on it. */
const pairLane = (cli: Ev[], srv: Ev[], label: string, gating: boolean): void => {
  const cliPool = new Map<string, Ev[]>();
  // Spawned dedupe: the client snapshot lane re-emits Spawned as a
  // "still alive" heartbeat. A spawn is once-only per id UNTIL a Destroyed
  // intervenes — dedupe only Spawned that follows a live spawn (a
  // respawn after death is a real edge both tapes must carry).
  // Heartbeat lanes: Spawned (':0') and StateChanged (':4') re-emit the
  // same edge as a "still here / still this state" assertion — dedupe a
  // heartbeat when it repeats the SAME edge for the same id. A respawn
  // after Destroyed or a real state transition has a different signature
  // and always survives.
  const isHb = (k: string): boolean => k.endsWith(':0') || k.endsWith(':4');
  const idOf = (k: string): string => k.slice(0, k.lastIndexOf(':'));
  const mkDedupe = (): ((k: string, aux: string) => boolean) => {
    const lastEv = new Map<string, string>();
    return (k: string, aux: string): boolean => {
      const id = idOf(k), sig = `${k}|${aux}`;
      if (isHb(k) && lastEv.get(id) === sig) {return true;}
      lastEv.set(id, sig);
      return false;
    };
  };
  const dedupeCli = mkDedupe(), dedupeSrv = mkDedupe();
  const cliDeduped = cli.filter((e): boolean => !dedupeCli(e.key, e.aux));
  const srvDeduped = srv.filter((e): boolean => !dedupeSrv(e.key, e.aux));
  for (const e of cliDeduped) {
    const t = e.t + offAt(e.t);
    const a = cliPool.get(e.key); if (a) {a.push({ ...e, t });} else {cliPool.set(e.key, [{ ...e, t }]);}
  }
  for (const a of cliPool.values()) {a.sort((p, q): number => p.t - q.t);}
  const cliStart = tMin + offAt(tMin);
  // Join backpressure: durable events (hits, kills, spawns — ~3s journal)
  // re-sent at connect get stamped when the client DISPATCHES them, and
  // veil/boot starvation can queue that seconds late — timestamps in the
  // first REPLAY_S of a capture are unreliable, so a client event there
  // pairs with any same-key server event in the window, regardless of Δt.
  const REPLAY_S = 8;
  // srvWin: events sent before the client's socket existed can't have
  // reached it (journal replay only rides RECLAIM, not first join), so
  // only a small pre-window margin applies — not the replay horizon.
  const srvWin = srvDeduped.filter((e): boolean =>
    e.t >= cliStart - 1.5 && e.t <= tMax + offAt(tMax) + 1);
  // Two passes: strict EV_TOL first, then a drift pass — the piecewise
  // fit's residual error grows ~0.1s/s from its anchors, so mid-clip
  // copies can sit ~2s off their server truth and still be the same edge.
  for (const tol of [EV_TOL, 3]) {
    for (let i = srvWin.length - 1; i >= 0; i -= 1) {
      const s = srvWin[i]!;
      const pool = cliPool.get(s.key);
      if (!pool || pool.length === 0) {continue;}
      let bi = 0;
      for (let j = 1; j < pool.length; j += 1) {if (Math.abs(pool[j]!.t - s.t) < Math.abs(pool[bi]!.t - s.t)) {bi = j;}}
      const c = pool[bi]!;
      const d = Math.abs(c.t - s.t);
      // KILL-lane pos is the victim's position at credit time — the
      // server credits at the rewound ghost (the 'gd' mechanism), the
      // client records its interpolated view, so >25m divergence is
      // legitimate there. Spawn/destroy lanes keep the check — entity
      // placement IS part of their identity.
      const killLane = s.key.startsWith(`${TARGETTYPE_KILL}:`);
      const posd = killLane ? 0 : Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
      const replay = c.t < cliStart + REPLAY_S && d <= REPLAY_S;
      if ((d <= tol || replay) && (posd < 25 || replay)) {
        pool.splice(bi, 1);
        srvWin.splice(i, 1);
      }
    }
  }
  for (const s of srvWin) {
    evMissed += 1;
    if (gating) {evMissedGated += 1;}
    if (evMissed <= 15) {console.log(`  [missed] ${label} ${s.key} @${s.t.toFixed(1)}`);}
  }
  for (const [key, pool] of cliPool) {
    for (const e of pool) {
      evFabricated += 1;
      // A fabricated event on the KILL lane is a hit/kill the client
      // claims the server never sent — a real anomaly. Other lanes'
      // client-only records are expected artifacts (predicted shells,
      // heartbeat spawns, local flag edges) — counted, not fatal.
      if (key.startsWith(`${TARGETTYPE_KILL}:`)) {
        evKillFab += 1;
        if (evKillFab <= 15) {console.log(`  [fabricated] ${label} ${key} @${e.t.toFixed(1)}`);}
      }
    }
  }
};
pairLane(mkTgt(A, cliIdxToSrv), mkTgt(B), 'tgt', true);
// Proj lane is informational: projectileCreated excludes the shooter, so
// the recording client's own shells are server-only by design — plus the
// client records locally-predicted shells the server never echoes.
pairLane(mkProj(A), mkProj(B), 'proj', false);
console.log(`\nevent truth: missed=${evMissed} (gated=${evMissedGated}) fabricated=${evFabricated} (kill-lane fabricated=${evKillFab})`);
process.exitCode = evMissedGated + evKillFab > 0 ? 1 : 0;
