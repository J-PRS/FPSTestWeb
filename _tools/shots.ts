// _tools/shots.ts — post-hoc best-shot scanner/extractor for .demo files.
//
//   bun _tools/shots.ts server_bun/demos/stream_gmwgr09h2_*.demo --top 15
//   bun _tools/shots.ts <files...> --sort streak|air|dist|score
//   bun _tools/shots.ts <files...> --extract 1,3 [--out clips/] [--pre 5] [--post 5]
//   bun _tools/shots.ts <files...> --player sclkibunq --extract top5
//
// Files sharing a stream_<id>_NNNN prefix are chained into one session:
// per-chunk timestamps restart at 0, so each chunk's events are offset by
// the cumulative duration of earlier chunks and roster indices are
// remapped to a unified roster. Client clip_* files score the recorder as
// the only shooter (all Fired events are theirs).
//
// Shot model: Fired → last event per projectileId. air = end−fire,
// dist = |firePos→endPos|. Outcome = player hit/kill when a KILL-lane
// targetEvent lands within a blast window of the shot's end. On server
// streams targetEvents carry victim/shooter rosterIdx (shooter in
// peakPosX = idx+1); unattributed Fired events resolve their shooter by
// muzzle proximity to a remote frame (≤6m).
//
// score = acc·dist·air·refire — the HUD formula (projectiles/index.ts
// shotScore), with acc≈10 for kills/direct, 7 for splash hits. The live
// formula also folds in per-hit accuracy the demo doesn't record, so
// treat score as a ranking estimate, not the in-game number.

import { readdirSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { deserializeDemo } from '../client/src/demo/demoReader.ts';
import { serializeDemo } from '../client/src/demo/demoWriter.ts';
import {
  ProjectileEventType, TargetEventType, TARGETTYPE_KILL,
  type DemoFile, type ProjectileEvent,
} from '../client/src/demo/types.ts';
import { WEAPONS } from '../shared/weaponRows.ts';
import { WeaponType } from '../shared/weaponTable.ts';
import { windowProjectileEvents, windowRemoteFrames, windowTargetEvents } from '../client/src/demo/demoClip.ts';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : '1') : null;
};
const files = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--sort' && argv[argv.indexOf(a) - 1] !== '--extract' && argv[argv.indexOf(a) - 1] !== '--top' && argv[argv.indexOf(a) - 1] !== '--pre' && argv[argv.indexOf(a) - 1] !== '--post' && argv[argv.indexOf(a) - 1] !== '--player' && argv[argv.indexOf(a) - 1] !== '--min-air');
const TOP = Number(flag('top') ?? 20);
const SORT = flag('sort') ?? 'score';
const EXTRACT = flag('extract');
const OUTDIR = flag('out');
const PRE = Number(flag('pre') ?? 5);
const POST = Number(flag('post') ?? 5);
const PLAYER = flag('player')?.toLowerCase();
const FULL = flag('full') !== null;
const MIN_AIR = Number(flag('min-air') ?? 0);

// Glob args (shell may not expand on Windows): dir/*.demo → list dir
function expand(arg: string): string[] {
  if (arg.includes('*')) {
    const dir = dirname(arg) === '.' ? '.' : dirname(arg);
    const re = new RegExp('^' + basename(arg).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    try { return readdirSync(dir).filter(f => re.test(f)).map(f => join(dir, f)); } catch { return []; }
  }
  return [arg];
}

// ---------- unified session ----------
interface Ev<T> { t: number; off: number; file: number; ev: T }
interface Session {
  name: string;
  isStream: boolean;
  localOwner: number;                          // unified roster idx of the recorder, -1 streams
  rfCount: Map<number, number>;                // remote-frame samples per unified roster idx
  roster: string[];                          // unified names
  fired: Ev<ProjectileEvent & { owner: number }>[]; // owner = unified roster idx, -1 unknown
  proj: Map<number, Ev<ProjectileEvent>[]>;  // projId → events (session-wide)
  hits: Ev<{ victim: number; shooter: number; kill: boolean; kind: 'player' | 'env'; pos: [number, number, number]; weapon: number }>[];
  remote: Ev<{ rosterIdx: number; pos: [number, number, number] }>[];
  srcs: { file: string; demo: DemoFile; off: number }[];
}

async function loadSession(paths: string[]): Promise<Session> {
  paths.sort();
  const ses: Session = { name: '', isStream: false, localOwner: -1, rfCount: new Map(), roster: [], fired: [], proj: new Map(), hits: [], remote: [], srcs: [] };
  let off = 0;
  for (const p of paths) {
    const buf = await readFile(p);
    let demo: DemoFile;
    try {
      demo = deserializeDemo(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch (e) { console.error(`skip ${p}: ${(e as Error).message}`); continue; }
    const rmap = demo.roster.map(r => {
      let i = ses.roster.indexOf(r.name);
      if (i < 0) { i = ses.roster.length; ses.roster.push(r.name); }
      return i;
    });
    // Server streams are the only recordings with KILL-lane player combat;
    // detect by filename — clips carry frames AND a non-stream prefix.
    const isStream = /(^|[\\/])stream_/.test(p) || demo.frames.length === 0;
    ses.isStream ||= isStream;
    for (const e of demo.projectileEvents) {
      const ev = { t: e.timestamp + off, off, file: ses.srcs.length, ev: e };
      if (e.eventType === ProjectileEventType.Fired) {
        ses.fired.push({ ...ev, ev: { ...e, owner: isStream ? -2 : -1 } as ProjectileEvent & { owner: number } });
      }
      const list = ses.proj.get(e.projectileId) ?? [];
      list.push(ev); ses.proj.set(e.projectileId, list);
    }
    for (const e of demo.targetEvents) {
      if (e.eventType !== TargetEventType.Hit && e.eventType !== TargetEventType.Destroyed) { continue; }
      const killLane = e.targetType === TARGETTYPE_KILL;
      // Streams encode shooterIdx+1 in peakPosX (y=z=0); clips write a real
      // peak pos — near-impossible to alias, so the signature is the tell.
      const shooterCoded = killLane && e.hasPeakPosition && e.peakPosY === 0 && e.peakPosZ === 0;
      ses.hits.push({ t: e.timestamp + off, off, file: ses.srcs.length, ev: {
        victim: killLane ? (rmap[e.targetId] ?? e.targetId) : -1,
        shooter: shooterCoded ? (rmap[(e.peakPosX | 0) - 1] ?? -1) : -1,
        kill: e.eventType === TargetEventType.Destroyed,
        kind: killLane ? 'player' : 'env',
        pos: [e.posX, e.posY, e.posZ],
        weapon: e.eventType === TargetEventType.Destroyed ? e.health : -1,
      } });
    }
    // Dead-flag transitions in remote frames are the only player-kill
    // signal clips carry — the KILL lane is stream-only.
    const lastFlags = new Map<number, number>();
    for (const f of demo.remoteFrames) {
      const idx = rmap[f.rosterIdx] ?? f.rosterIdx;
      ses.remote.push({ t: f.timestamp + off, off, file: ses.srcs.length, ev: { rosterIdx: idx, pos: [f.posX, f.posY, f.posZ] } });
      ses.rfCount.set(idx, (ses.rfCount.get(idx) ?? 0) + 1);
      const was = lastFlags.get(idx) ?? 0;
      if (!isStream && (f.flags & 1) && !(was & 1)) {
        ses.hits.push({ t: f.timestamp + off, off, file: ses.srcs.length, ev: {
          victim: idx, shooter: -1, kill: true, kind: 'player',
          pos: [f.posX, f.posY, f.posZ], weapon: -1,
        } });
      }
      lastFlags.set(idx, f.flags);
    }
    ses.srcs.push({ file: p, demo, off });
    off += demo.header.duration;
    ses.name = ses.name || basename(p).replace(/_\d+\.demo$/, '').replace(/\.demo$/, '');
  }
  ses.remote.sort((a, b) => a.t - b.t);
  return ses;
}

// Muzzle-proximity owner for stream Fired events: nearest remote frame ≤6m
// within ±0.15s. Remote frames sample at ~20Hz, so time-nearest is fine.
function attribute(fired: Session['fired'], ses: Session): void {
  // index remote frames by rosterIdx for the scan
  for (const f of fired) {
    if (f.ev.owner !== -2) { continue; }
    let best = -1; let bestD = 6;
    // binary search by time then local walk
    let lo = 0; let hi = ses.remote.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ses.remote[mid]!.t < f.t) { lo = mid + 1; } else { hi = mid; } }
    for (let i = lo; i >= 0 && f.t - ses.remote[i]!.t <= 0.15; i--) {
      const r = ses.remote[i]!.ev;
      const d = Math.hypot(r.pos[0] - f.ev.posX, r.pos[1] - f.ev.posY, r.pos[2] - f.ev.posZ);
      if (d < bestD) { bestD = d; best = r.rosterIdx; }
    }
    for (let i = lo + 1; i < ses.remote.length && ses.remote[i]!.t - f.t <= 0.15; i++) {
      const r = ses.remote[i]!.ev;
      const d = Math.hypot(r.pos[0] - f.ev.posX, r.pos[1] - f.ev.posY, r.pos[2] - f.ev.posZ);
      if (d < bestD) { bestD = d; best = r.rosterIdx; }
    }
    f.ev.owner = best;
  }
}

// ---------- shot resolution ----------
interface Shot {
  owner: number; weapon: number; tFire: number; tEnd: number;
  file: number; projId: number;
  air: number; dist: number; hit: boolean; kill: boolean; direct: boolean;
  victim: number; score: number; pFire: [number, number, number]; pEnd: [number, number, number];
}

function shots(ses: Session, localOwner: number): Shot[] {
  const out: Shot[] = [];
  for (const f of ses.fired) {
    // projIds recycle — the shot's life ends at its last event before the
    // id's next Fired, else air inflates across an unrelated second shot.
    const life = ses.proj.get(f.ev.projectileId)!.filter(e => e.t >= f.t - 1e-6);
    const refire = life.findIndex((e, i) => i > 0 && e.ev.eventType === ProjectileEventType.Fired);
    const span = refire > 0 ? life.slice(0, refire) : life;
    const last = span[span.length - 1]!;
    const e = last.ev;
    const air = last.t - f.t;
    if (air < MIN_AIR || air < 0) { continue; }
    const dist = Math.hypot(e.posX - f.ev.posX, e.posY - f.ev.posY, e.posZ - f.ev.posZ);
    const direct = e.eventType === ProjectileEventType.Hit;
    // Player hits first (KILL lane on streams, Dead-flag on clips), then
    // creature/ball lanes — a credited env hit still breaks a miss streak.
    const blast = (WEAPONS[f.ev.weaponType]?.aoeRadius ?? 5) + 10;
    const near = (h: Session['hits'][number]): boolean =>
      Math.abs(h.t - last.t) <= 0.35 &&
      Math.hypot(h.ev.pos[0] - e.posX, h.ev.pos[1] - e.posY, h.ev.pos[2] - e.posZ) <= blast;
    const hit = ses.hits.find(h => h.ev.kind === 'player' && near(h))
             ?? ses.hits.find(h => h.ev.kind === 'env' && near(h));
    let owner = f.ev.owner === -2 || f.ev.owner < 0 ? (hit?.ev.shooter ?? f.ev.owner) : f.ev.owner;
    if (owner === -1) { owner = localOwner; }
    const kill = hit?.ev.kill === true && hit.ev.kind === 'player';
    const acc = kill ? 10 : hit ? (direct ? 10 : 7) : 0;
    const interval = WEAPONS[f.ev.weaponType]?.fireInterval ?? 1;
    const score = acc === 0 ? 0 : Math.round(acc * dist * air * Math.max(0.1, interval));
    out.push({ owner, weapon: f.ev.weaponType, tFire: f.t, tEnd: last.t,
      file: f.file, projId: f.ev.projectileId, air, dist,
      hit: !!hit, kill, direct, victim: hit?.ev.kind === 'player' ? hit.ev.victim : -1, score,
      pFire: [f.ev.posX, f.ev.posY, f.ev.posZ], pEnd: [e.posX, e.posY, e.posZ] });
  }
  return out;
}

const name = (ses: Session, i: number): string => i >= 0 ? ses.roster[i]! : '?';
const wname = (w: number): string => WeaponType[w] ?? `wt${w}`;

// ---------- streaks ----------
interface Streak { owner: number; count: number; shots: Shot[]; score: number }
function streaks(list: Shot[]): Streak[] {
  const byOwner = new Map<number, Shot[]>();
  for (const s of list) { const a = byOwner.get(s.owner) ?? []; a.push(s); byOwner.set(s.owner, a); }
  const out: Streak[] = [];
  for (const [owner, arr] of byOwner) {
    arr.sort((a, b) => a.tFire - b.tFire);
    let run: Shot[] = [];
    const flush = (): void => {
      if (run.length >= 2) { out.push({ owner, count: run.length, shots: [...run], score: run.reduce((a, s) => a + s.score, 0) }); }
      run = [];
    };
    for (const s of arr) { if (s.hit) { run.push(s); } else { flush(); } }
    flush();
  }
  return out.sort((a, b) => b.count - a.count || b.score - a.score);
}

// ---------- extract ----------
async function extract(ses: Session, t0: number, t1: number, desc: string, lifetime: number, outPath: string, povName?: string | null, featured?: { file: number; projId: number; hit: boolean }, recName?: string): Promise<void> {
  const start = t0 - PRE, end = t1 + POST;
  const clip: DemoFile = { header: { ...ses.srcs[0]!.demo.header }, frames: [], projectileEvents: [], targetEvents: [], roster: [], remoteFrames: [] };
  const h = clip.header;
  h.timestamp = Date.now(); h.duration = end - start; h.description = desc; h.projectileLifetime = lifetime;
  // Chunk rosters are per-chunk seat tables — the same player can sit at
  // different indices in different chunks. Dedupe by NAME so every chunk's
  // frames for one player collapse to a single roster row; per-(file,idx)
  // rows would spawn one ghost body per chunk in playback.
  // Wire projectileIds recycle constantly (u16 space) — remap each
  // (chunk, origId) life to a fresh clip-local id so a fired→hit pair can
  // never alias another projectile's events. Without this the seekbar's
  // marker pairing scrambles and every tick renders cold/grey.
  const pidOf = new Map<number, number>();
  let nextPid = 0;
  const pid = (orig: number, fresh: boolean): number => {
    if (fresh || !pidOf.has(orig)) { pidOf.set(orig, nextPid++); }
    return pidOf.get(orig)!;
  };
  const byName = new Map<string, number>();
  const byNameIdx = (n: string): number => {
    let i = byName.get(n);
    if (i === undefined) { i = clip.roster.push({ name: n }) - 1; byName.set(n, i); }
    return i;
  };
  const remap = (srcI: number, idx: number): number =>
    byNameIdx(ses.srcs[srcI]!.demo.roster[idx]?.name ?? `idx${idx}`);
  let firstF: { posX: number; posY: number; posZ: number; yaw: number; pitch: number; velX: number; velY: number; velZ: number } | null = null;
  for (const [si, s] of ses.srcs.entries()) {
    const lo = start - s.off, hi = end - s.off;
    const d = s.demo;
    // Skip chunks outside the window outright — calling a window*
    // collector with fromT > toT still injects synthetic baselines at
    // fromT, which renormalize to t=0 and spawn ghost projectiles.
    if (hi < 0 || lo > d.header.duration) { continue; }
    // Only the chunk containing clip-start injects baselines (alive
    // spawns, in-flight Fired, last-seen frames). Later chunks raw-filter
    // — a second baseline stamp would double-spawn entities mid-clip.
    const isStartChunk = lo >= 0 && lo <= d.header.duration;
    let base = 0;
    // povName set = rebuild the camera lane from the SHOOTER's remote
    // frames so playback is always shooter-POV, even when the recorder
    // was someone else. The recorder's own frames lane is dropped and the
    // shooter leaves remoteFrames — a POV player never sees themselves.
    if (!povName) {
      for (const f of d.frames) {
        if (f.timestamp < lo || f.timestamp > hi) { continue; }
        if (!firstF) { firstF = f; base = f.frameNumber; }
        clip.frames.push({ ...f, timestamp: f.timestamp + s.off - start, frameNumber: (f.frameNumber - base + 65536) % 65536 });
      }
    } else if (recName) {
      // POV rebuild drops the recorder's camera lane — but the recorder
      // is usually the VICTIM: re-mint them as a remote body (their own
      // full-rate frames are the best samples we have of them) or the
      // person who got shot has no body in the clip.
      const seat = byNameIdx(recName);
      for (const f of d.frames) {
        if (f.timestamp < lo || f.timestamp > hi) { continue; }
        clip.remoteFrames.push({
          timestamp: f.timestamp + s.off - start, rosterIdx: seat,
          posX: f.posX, posY: f.posY, posZ: f.posZ,
          velX: f.velX, velY: f.velY, velZ: f.velZ, yaw: f.yaw, pitch: f.pitch,
          flags: 0, hp: Math.min(255, f.health), wid: f.weaponType,
        });
      }
    }
    for (const e of isStartChunk
      ? windowProjectileEvents(d.projectileEvents, lo, hi, null)
      : d.projectileEvents.filter(e => e.timestamp >= lo && e.timestamp <= hi)) {
      // The featured shot may end Destroyed (detonation) — the seekbar
      // only pairs Hit events, so a confirmed hit gets the Hit lane or
      // the clip's red/blue markers never light.
      let et = e.eventType;
      if (featured?.hit && si === featured.file && e.projectileId === featured.projId
        && et === ProjectileEventType.Destroyed) { et = ProjectileEventType.Hit; }
      clip.projectileEvents.push({ ...e, eventType: et, timestamp: e.timestamp + s.off - start,
        projectileId: pid(e.projectileId, et === ProjectileEventType.Fired) });
    }
    for (const e of isStartChunk
      ? windowTargetEvents(d.targetEvents, lo, hi, null)
      : d.targetEvents.filter(e => e.timestamp >= lo && e.timestamp <= hi)) {
      const c = { ...e, timestamp: e.timestamp + s.off - start };
      if (e.targetType === TARGETTYPE_KILL) {
        c.targetId = remap(si, e.targetId);
        // peakPosX=idx+1 with 0 = no shooter — remap only real seats so a
        // zero doesn't mint an "idx-1" roster row.
        if (e.hasPeakPosition && e.peakPosX > 0) { c.peakPosX = remap(si, (e.peakPosX | 0) - 1) + 1; }
      }
      clip.targetEvents.push(c);
    }
    for (const f of isStartChunk
      ? windowRemoteFrames(d.remoteFrames, lo, hi, null)
      : d.remoteFrames.filter(f => f.timestamp >= lo && f.timestamp <= hi)) {
      const ts = f.timestamp + s.off - start;
      if (povName && d.roster[f.rosterIdx]?.name === povName) {
        // Remote → local lane: camera-relevant fields carry over, the
        // recorder-only lanes (inputs/mouse/fuel) zero out — playback
        // renders this exactly like a native first-person recording.
        if (!firstF) { firstF = { ...f, yaw: f.yaw, pitch: f.pitch }; }
        clip.frames.push({
          frameNumber: clip.frames.length & 0xFFFF,
          timestamp: ts, posX: f.posX, posY: f.posY, posZ: f.posZ,
          velX: f.velX, velY: f.velY, velZ: f.velZ, yaw: f.yaw, pitch: f.pitch,
          inputFlags: 0, mouseDeltaX: 0, mouseDeltaY: 0,
          jetpackFlags: 0, jetpackFuel: 0,
          weaponType: f.wid ?? 0, health: (f.hp ?? 0), armor: 0,
        });
        continue;
      }
      clip.remoteFrames.push({ ...f, timestamp: ts, rosterIdx: remap(si, f.rosterIdx) });
    }
    if (d.snapshots) { for (const t of d.snapshots) { const u = t + s.off; if (u >= start && u <= end) { (clip.snapshots ??= []).push(u - start); } } }
    clip.heightmap ??= d.heightmap;
    clip.atmo ??= d.atmo;
  }
  const anchor = firstF ?? clip.remoteFrames[0];
  if (anchor) {
    h.startPosX = anchor.posX; h.startPosY = anchor.posY; h.startPosZ = anchor.posZ;
    h.startYaw = 'yaw' in anchor ? (anchor as { yaw: number }).yaw : 0; h.startPitch = 'pitch' in anchor ? (anchor as { pitch: number }).pitch : 0;
    h.startVelX = anchor.velX; h.startVelY = anchor.velY; h.startVelZ = anchor.velZ;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Buffer.from(serializeDemo(clip)));
}

// ---------- main ----------
const all = files.flatMap(expand);
if (all.length === 0) { console.error('usage: bun _tools/shots.ts <files|glob> [--sort score|air|dist|streak] [--top N] [--player name] [--min-air s] [--extract idx,idx|topN] [--pre s] [--post s] [--out dir]'); process.exit(1); }

// group by stream session prefix, other files standalone
const groups = new Map<string, string[]>();
for (const p of all) {
  const m = basename(p).match(/^(stream_[a-z0-9]+)_\d+\.demo$/i);
  const key = m ? join(dirname(p), m[1]!) : p;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
}

interface Ranked extends Shot { ses: Session }
const ranked: Ranked[] = [];
const stks: { st: Streak; ses: Session }[] = [];
for (const paths of groups.values()) {
  const ses = await loadSession(paths);
  if (ses.srcs.length === 0) { continue; }
  if (FULL) {
    // Whole chained session as one playable demo, native recorder POV —
    // roster dedupe + pid remap run in extract() like any clip.
    const last = ses.srcs[ses.srcs.length - 1]!;
    const end = last.off + last.demo.header.duration;
    const out = join(OUTDIR ?? dirname(last.file), `${ses.name}_full.demo`);
    await extract(ses, -1, end + 1, `FULL ${ses.name}`, 0, out, null);
    console.log(`wrote ${out} (${end.toFixed(0)}s)`);
    continue;
  }
  attribute(ses.fired, ses);
  // Clip rosters hold only remotes — the recorder gets a synthetic entry.
  let local = ses.roster.indexOf(ses.srcs[0]!.demo.header.playerName);
  if (local < 0 && !ses.isStream) {
    local = ses.roster.push(ses.srcs[0]!.demo.header.playerName || 'local') - 1;
  }
  ses.localOwner = local;
  const list = shots(ses, local).filter(s => !PLAYER
    || (PLAYER === 'rec' ? s.owner < 0 : name(ses, s.owner).toLowerCase().includes(PLAYER)));
  ranked.push(...list.map(s => ({ ...s, ses })));
  stks.push(...streaks(list).map(st => ({ st, ses })));
}

const cmp: Record<string, (a: Shot, b: Shot) => number> = {
  score: (a, b) => b.score - a.score, air: (a, b) => b.air - a.air, dist: (a, b) => b.dist - a.dist,
};

if (SORT === 'streak') {
  const top = stks.slice(0, TOP);
  console.log(`#  owner              n   score   window`);
  top.forEach((x, i) => {
    const s = x.st;
    console.log(`${String(i + 1).padEnd(3)}${name(x.ses, s.owner).padEnd(19)}${String(s.count).padEnd(4)}${String(s.score).padEnd(8)}t=${s.shots[0]!.tFire.toFixed(1)}–${s.shots[s.shots.length - 1]!.tEnd.toFixed(1)}`);
  });
} else {
  ranked.sort(cmp[SORT] ?? cmp.score!);
  const top = ranked.slice(0, TOP);
  console.log(`#    score   air     dist    weapon            shooter             victim            outcome`);
  top.forEach((s, i) => {
    console.log(`${String(i + 1).padEnd(5)}${String(s.score).padEnd(8)}${(s.air.toFixed(2) + 's').padEnd(8)}${(s.dist.toFixed(1) + 'm').padEnd(8)}${wname(s.weapon).padEnd(18)}${name(s.ses, s.owner).padEnd(20)}${name(s.ses, s.victim).padEnd(18)}${s.kill ? 'KILL' : s.hit ? (s.direct ? 'direct' : 'splash') : 'miss'} @t=${s.tFire.toFixed(1)}`);
  });
  if (EXTRACT) {
    const idxs = EXTRACT.startsWith('top') ? top.slice(0, Number(EXTRACT.slice(3)) || 5).map((_, i) => i) : EXTRACT.split(',').map(n => Number(n) - 1);
    for (const i of idxs) {
      const s = top[i]; if (!s) { console.error(`no shot #${i + 1}`); continue; }
      const out = join(OUTDIR ?? dirname(s.ses.srcs[0]!.file), `shot_${i + 1}_${s.ses.name}_${s.air.toFixed(1)}s.demo`);
      const nick = (n: string): string => n.replace(/^player_/, '');
      // '?' owners on a client stream are the recorder — resolve to a
      // 0-remoteFrame human seat's name so the feed reads a name, not ?.
      // Reconnects seat multiple ids for one human (each 0-rf), so pick
      // the victim's own seat when it's 0-rf — a kill lands exactly at
      // the recorder's position — else the 0-rf seat dying most inside
      // the window (the reconnect-id that's active then).
      const recName = (ses: Session, t0?: number, t1?: number, victimIdx = -1): string => {
        if (ses.localOwner >= 0) { return ses.roster[ses.localOwner]!; }
        const zeros: number[] = [];
        for (let i = 0; i < ses.roster.length; i++) {
          if ((ses.rfCount.get(i) ?? 0) === 0 && !ses.roster[i]!.startsWith('bot:')) { zeros.push(i); }
        }
        if (zeros.length === 0) { return 'rec'; }
        if (zeros.includes(victimIdx)) { return ses.roster[victimIdx]!; }
        if (zeros.length > 1 && t0 !== undefined && t1 !== undefined) {
          const score = new Map<number, number>();
          for (const hh of ses.hits) {
            if (hh.t >= t0 && hh.t <= t1 && zeros.includes(hh.ev.victim)) {
              score.set(hh.ev.victim, (score.get(hh.ev.victim) ?? 0) + 1);
            }
          }
          let best = -1, bn = 0;
          for (const [i, c] of score) { if (c > bn) { bn = c; best = i; } }
          if (best >= 0) { return ses.roster[best]!; }
        }
        return ses.roster[zeros[0]!]!;
      };
      // Killfeed-style: `pov shooter [Weapon] victim · dist` — the panel
      // parses the dist tail into the foot row.
      // REC = shooter's native first-person camera (owner unattributed or
      // a roster member with zero remoteFrames — a client never frames
      // itself). POV = shooter's camera reconstructed from their remote
      // frames — the clip's frames lane is theirs, so playback still
      // watches through the shooter's eyes.
      const rec = (i: number): boolean => i < 0 || i === s.ses.localOwner || (s.ses.rfCount.get(i) ?? 0) === 0;
      const pov = rec(s.owner) ? 'REC' : 'POV';
      const shooter = s.owner < 0 ? recName(s.ses, s.tFire, s.tEnd, s.victim) : name(s.ses, s.owner);
      const desc = s.victim >= 0
        ? `${pov} ${nick(shooter)} [${wname(s.weapon)}] ${nick(name(s.ses, s.victim))} · ${Math.round(s.dist)}m${s.kill ? ' KILL' : ''}`
        : `${pov} ${nick(shooter)} [${wname(s.weapon)}] · ${Math.round(s.dist)}m`;
      // Shooter-POV rule: REC clips keep the recorder's native camera;
      // anything else rebuilds the frames lane from the shooter's remote
      // frames so the view is always the shooter, never the victim or a
      // bystander (only possible when the shooter is rostered).
      const povFor = pov === 'REC' || s.owner < 0 ? null : name(s.ses, s.owner);
      await extract(s.ses, s.tFire, s.tEnd, desc, s.air, out, povFor,
        { file: s.file, projId: s.projId, hit: s.hit }, povFor ? recName(s.ses, s.tFire, s.tEnd, s.victim) : undefined);
      console.log(`wrote ${out}`);
    }
  }
}
