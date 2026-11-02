// demoAudit — replay-independent truth check on a captured .demo file.
// A demo IS the wire stream + committed edges as the client saw them, so a
// netcode desync shows up here as internally inconsistent replay data (and
// a capture-layer bug shows as malformed structure). One file, both layers.
//
//   bun _tools/demoAudit.ts path/to/clip.demo
//
// Verdict classes, cheap to scan:
//   structural — non-finite numbers, monotonicity breaks, roster OOB
//   kinematic  — per-frame implied speed beyond the plausible envelope,
//                velocity-vs-displacement mismatch (replay divergence)
//   lifecycle  — Hit/Destroyed refs with no Fired/Spawned (truncated edge
//                streams are normal at clip edges; mid-clip orphans are not)
//   saturation — a coordinate pinned EXACTLY at a quantization bound while
//                siblings move (the i16 1310.7 clamp signature; kept as a
//               detector even post-i32 — any future bound shows the same way)
import { deserializeDemo } from '../client/src/demo/demoReader.ts';
import {
  TargetEventType, ProjectileEventType, TARGETTYPE_CREATURE_BASE,
  TARGETTYPE_DEPLOY_BASE, TARGETTYPE_KILL, TARGETTYPE_FLAG,
  TARGETTYPE_PICKUP_BASE,
} from '../client/src/demo/types.ts';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: bun _tools/demoAudit.ts <file.demo>'); process.exit(2); }
const demo = deserializeDemo(readFileSync(file).buffer);

const issues: string[] = [];
const bad = (cls: string, msg: string) => issues.push(`[${cls}] ${msg}`);
// Warnings print inline but don't count toward the FAIL total — for
// honest-data anomalies (interp catch-up) a fail would be a false flag.
const warn = (cls: string, msg: string) => { console.log(`  [${cls}] warn: ${msg}`); };

// ---- structural: finite everywhere, monotonic clocks --------------------
const fin = (...xs: number[]) => xs.every(Number.isFinite);
for (const f of demo.frames) {
  if (!fin(f.posX, f.posY, f.posZ, f.velX, f.velY, f.velZ, f.yaw, f.pitch, f.jetpackFuel)) {
    bad('structural', `frame ${f.frameNumber} non-finite`);
  }
}
for (const f of demo.remoteFrames) {
  if (!fin(f.posX, f.posY, f.posZ, f.velX, f.velY, f.velZ, f.yaw, f.pitch)) {
    bad('structural', `remoteFrame t=${f.timestamp.toFixed(2)} idx=${f.rosterIdx} non-finite`);
  }
  if (f.rosterIdx >= demo.roster.length) {
    bad('structural', `remoteFrame rosterIdx ${f.rosterIdx} OOB (roster ${demo.roster.length})`);
  }
}
const mono = (ts: number[], name: string) => {
  for (let i = 1; i < ts.length; i++) {
    if (ts[i]! < ts[i - 1]! - 1e-4) { bad('structural', `${name} timestamp rewinds at idx ${i} (${ts[i - 1]}→${ts[i]})`); break; }
  }
};
mono(demo.frames.map(f => f.timestamp), 'frames');
mono(demo.remoteFrames.map(f => f.timestamp), 'remoteFrames');
mono(demo.projectileEvents.map(e => e.timestamp), 'projectileEvents');
mono(demo.targetEvents.map(e => e.timestamp), 'targetEvents');
for (const s of [
  ...demo.frames.map(f => f.timestamp),
  ...demo.remoteFrames.map(f => f.timestamp),
  ...demo.projectileEvents.map(e => e.timestamp),
  ...demo.targetEvents.map(e => e.timestamp),
]) {
  if (s < -0.01 || s > demo.header.duration + 0.5) { bad('structural', `timestamp ${s} outside clip duration ${demo.header.duration.toFixed(1)}`); break; }
}

// ---- kinematic: implied speed from frame deltas -------------------------
// Plausible envelope: skiers+jets+knockback peak ~120 m/s; a wire-side
// clamp or stale replica shows as impossible implied speed OR a frozen
// axis while the rest of the body moves.
const SPEED_CAP = 160; // generous — beyond this is a wire/replay fault, not gameplay
const byIdx = new Map<number, typeof demo.remoteFrames>();
for (const f of demo.remoteFrames) {
  let a = byIdx.get(f.rosterIdx); if (!a) { a = []; byIdx.set(f.rosterIdx, a); }
  a.push(f);
}
let speedViol = 0, stuckAxes = 0;
for (const [idx, fs] of byIdx) {
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1]!, b = fs[i]!;
    const dt = b.timestamp - a.timestamp;
    if (dt <= 0) continue;
    // Teleport bit = the recorder stamped this frame as a re-seat
    // (respawn/reclaim) — a jump IS the honest signal, skip the check.
    if (b.flags & 4) continue; // RemoteFrameFlags.Teleport
    const d = Math.hypot(b.posX - a.posX, b.posY - a.posY, b.posZ - a.posZ);
    const v = d / dt;
    if (v > SPEED_CAP && ++speedViol <= 5) {
      bad('kinematic', `roster ${idx} implied speed ${v.toFixed(0)}m/s @t=${b.timestamp.toFixed(1)} (Δ${d.toFixed(1)}m in ${dt.toFixed(2)}s — teleport or stale record)`);
    }
    // Frozen-axis probe: one coord constant ≥2s while total motion ≥5m —
    // the i16 clamp's exact signature (x,y live, z parked at the bound).
    if (i >= 3) {
      const win = fs.slice(i - 3, i + 1);
      const span = (k: 'posX' | 'posY' | 'posZ') => Math.max(...win.map(w => w[k])) - Math.min(...win.map(w => w[k]));
      const total = span('posX') + span('posY') + span('posZ');
      const windowT = win[win.length - 1]!.timestamp - win[0]!.timestamp;
      for (const k of ['posX', 'posY', 'posZ'] as const) {
        if (span(k) < 0.01 && total > 5 && windowT > 0.5) {
          const pinned = win[0]![k];
          // Pinned AT a quantization bound is the smoking gun; pinned at an
          // ordinary value is just standing still on one axis — only count
          // the bound hit.
          if (Math.abs(Math.abs(pinned) - 1310.72) < 0.5 || Math.abs(pinned) > 80000) {
            bad('saturation', `roster ${idx} ${k} pinned at ${pinned.toFixed(2)} for ${windowT.toFixed(1)}s while body moved ${total.toFixed(0)}m (wire bound signature)`);
            stuckAxes++;
          }
        }
      }
    }
  }
}

// ---- kinematic: recorded velocity vs its own displacement ---------------
// RemoteFrames carry REALIZED vel (pos delta across the trailing sample),
// so stated(a) must equal the displacement that produced it. A mismatch
// means the recorder wrote vel from the wrong source/dt — physics bursts
// (spawn pops, slams) are self-consistent in this window and stay clean.
let velMismatch = 0;
for (const [idx, fs] of byIdx) {
  for (let i = 1; i < fs.length; i++) {
    const p = fs[i - 1]!, a = fs[i]!;
    const dt = a.timestamp - p.timestamp;
    if (dt <= 0.02) continue;
    const stated = Math.hypot(a.velX, a.velY, a.velZ);
    if (stated <= 30) continue;
    // Skip dead frames and the two frames around a teleport — teleports
    // record sim vel deliberately, and a pos snap contaminates the delta.
    if ((a.flags | p.flags) & 5) continue;
    const implied = Math.hypot(a.posX - p.posX, a.posY - p.posY, a.posZ - p.posZ) / dt;
    // implied > stated = renderer catch-up (interp rubber-band toward the
    // wire target — the pos trail is honest, playback lerps it anyway).
    // implied < stated = the wire claimed speed the trail never showed —
    // actual desync between the vel claim and real displacement.
    if (implied < stated * 0.7) {
      bad('kinematic', `roster ${idx} states vel ${stated.toFixed(0)}m/s but trailed ${implied.toFixed(0)}m/s @t=${a.timestamp.toFixed(1)} (claimed speed trail never showed)`);
    } else if (implied > stated * 1.3) {
      velMismatch += 1;
      if (velMismatch <= 5) {warn('kinematic', `roster ${idx} interp catch-up: trailed ${implied.toFixed(0)}m/s vs claimed ${stated.toFixed(0)}m/s @t=${a.timestamp.toFixed(1)}`);}
    }
  }
}

// ---- lifecycle: orphans and impossible lifetimes ------------------------
const firedAt = new Map<number, number>();
for (const e of demo.projectileEvents) {
  if (e.eventType === ProjectileEventType.Fired) { firedAt.set(e.projectileId, e.timestamp); continue; }
  if (e.eventType === ProjectileEventType.Hit || e.eventType === ProjectileEventType.Destroyed) {
    const t0 = firedAt.get(e.projectileId);
    if (t0 !== undefined) {
      const life = e.timestamp - t0;
      if (life < -0.01 || life > 30) { bad('lifecycle', `proj ${e.projectileId} lifetime ${life.toFixed(2)}s outside 0–30s`); }
    }
    // Missing Fired is expected for shells in flight at clip start — only
    // flag orphans AFTER the first 1s of the clip.
    else if (e.timestamp > 1.0) {
      bad('lifecycle', `proj ${e.projectileId} ${e.eventType === 2 ? 'Hit' : 'Destroyed'} with no prior Fired mid-clip @t=${e.timestamp.toFixed(1)}`);
    }
    if (!fin(e.posX, e.posY, e.posZ, e.velX, e.velY, e.velZ)) { bad('structural', `proj ${e.projectileId} non-finite @t=${e.timestamp.toFixed(1)}`); }
  }
}
const targetTypeName = (t: number) =>
  t < TARGETTYPE_CREATURE_BASE ? `ball(${t})`
    : t < TARGETTYPE_DEPLOY_BASE ? `creature(${t - TARGETTYPE_CREATURE_BASE})`
      : t < TARGETTYPE_KILL ? `deploy(${t - TARGETTYPE_DEPLOY_BASE})`
        : t === TARGETTYPE_KILL ? 'kill'
          : t === TARGETTYPE_FLAG ? 'flag'
            : t >= TARGETTYPE_PICKUP_BASE ? `pickup(${t - TARGETTYPE_PICKUP_BASE})` : `?(${t})`;
// ---- kinematic: teleport-class displacement on continuous edges ---------
// Bounce/StateChanged keyframes claim the body kept simulating — a >40m
// jump between them means a re-seat (respawn/id-reuse) was flattened into
// a motion edge, which playback renders as a midair streak, not a pop.
const byTarget = new Map<string, typeof demo.targetEvents>();
for (const e of demo.targetEvents) {
  if (e.targetType === TARGETTYPE_KILL) continue;
  const k = `${e.targetType}:${e.targetId}`;
  let a = byTarget.get(k); if (!a) { a = []; byTarget.set(k, a); }
  a.push(e);
}
let teleportEdges = 0;
for (const [k, es] of byTarget) {
  for (let i = 1; i < es.length; i++) {
    const a = es[i - 1]!, b = es[i]!;
    if (b.eventType !== TargetEventType.Bounce && b.eventType !== TargetEventType.StateChanged) continue;
    if (a.eventType === TargetEventType.Destroyed) continue;
    const d = Math.hypot(b.posX - a.posX, b.posY - a.posY, b.posZ - a.posZ);
    if (d > 40 && ++teleportEdges <= 5) {
      bad('kinematic', `target ${k} ${b.eventType === 1 ? 'Bounce' : 'StateChanged'} jumped ${d.toFixed(0)}m @t=${b.timestamp.toFixed(1)} (re-seat recorded as motion edge — plays back as a streak)`);
    }
  }
}

const spawned = new Set<string>();
let midClipOrphans = 0;
for (const e of demo.targetEvents) {
  if (!fin(e.posX, e.posY, e.posZ, e.velX, e.velY, e.velZ, e.health)) {
    bad('structural', `target ${e.targetId} type ${targetTypeName(e.targetType)} non-finite @t=${e.timestamp.toFixed(1)}`);
  }
  if (e.health < 0 || e.health > 100000) { bad('structural', `target ${e.targetId} health ${e.health} out of sane range @t=${e.timestamp.toFixed(1)}`); }
  // KILL-lane entries are markers (victimIdx + weapon), not bodies —
  // they never Spawn, so the orphan rule doesn't apply.
  if (e.targetType === TARGETTYPE_KILL) {continue;}
  const key = `${e.targetType}:${e.targetId}`;
  if (e.eventType === TargetEventType.Spawned) { spawned.add(key); continue; }
  if (e.eventType === TargetEventType.Destroyed && !spawned.has(key) && e.timestamp > 1.0) {
    if (++midClipOrphans <= 5) { bad('lifecycle', `target ${e.targetId} ${targetTypeName(e.targetType)} Destroyed with no Spawned mid-clip @t=${e.timestamp.toFixed(1)}`); }
  }
}

// ---- world-bounds sanity -------------------------------------------------
// Nothing interactive should read coordinates beyond the world's reach —
// the i16 bug hid inside |x|<20000, so bound at the terrain scale, not the
// old clamp value.
const WORLD_EDGE = 25000;
for (const f of demo.remoteFrames) {
  if (Math.max(Math.abs(f.posX), Math.abs(f.posZ)) > WORLD_EDGE) {
    bad('structural', `roster ${f.rosterIdx} out of world @(${f.posX.toFixed(0)},${f.posZ.toFixed(0)})`); break;
  }
}

// ---- report --------------------------------------------------------------
console.log(`demoAudit ${file}`);
console.log(`  fmt v${demo.header.formatVersion} dur=${demo.header.duration.toFixed(1)}s room=${demo.header.room || '?'} mode=${demo.header.mode || '?'}`);
console.log(`  frames=${demo.frames.length} remotes=${demo.remoteFrames.length} projs=${demo.projectileEvents.length} targets=${demo.targetEvents.length} roster=${demo.roster.length}`);
console.log(`  kinematic: speedViolations=${speedViol} velMismatch=${velMismatch} pinnedAxis=${stuckAxes} teleportEdges=${teleportEdges} targetOrphans=${midClipOrphans}`);
if (issues.length === 0) {
  console.log('AUDIT PASS — no structural/kinematic/lifecycle violations');
  process.exit(0);
}
const uniq = [...new Set(issues)];
for (const i of uniq.slice(0, 25)) { console.log(`  ${i}`); }
if (uniq.length > 25) { console.log(`  … +${uniq.length - 25} more`); }
console.log(`AUDIT FAIL — ${uniq.length} distinct issues`);
process.exit(1);
