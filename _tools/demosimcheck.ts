// demosimcheck — offline demo-replay validator (bun, no browser, no GPU).
// demovalidate proves the bytes are well-formed; demoAudit proves the data
// is self-consistent; this proves the replay itself tracks: recorded edge
// events are checkpoints, the entity sims run free between them, and the
// gap at the next checkpoint is the replay divergence the pbTarget blend
// hides during real playback.
//
//   bun _tools/demosimcheck.ts <file.demo> [...]
//
// Exit 0 = pass. Issue classes: divergence | kinematic | lifecycle | structural.

// ---- DOM stubs — client modules touch browser globals at import time
// (mirrors client/src/__tests__/setup.ts; must precede client imports).
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
    clear: (): void => store.clear(),
    get length(): number { return store.size; },
    key: (i: number): string => [...store.keys()][i] ?? null,
  };
}
if (typeof globalThis.sessionStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string): string | null => store.get(k) ?? null,
    setItem: (k: string, v: string): void => { store.set(k, String(v)); },
    removeItem: (k: string): void => { store.delete(k); },
    clear: (): void => store.clear(),
  };
}
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    location: { search: '', href: 'http://localhost/' },
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    dispatchEvent: (): boolean => true,
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  class CustomEventStub<T> {
    type: string;
    detail: T | undefined;
    constructor(type: string, init?: { detail?: T }) { this.type = type; this.detail = init?.detail; }
  }
  (globalThis as Record<string, unknown>).CustomEvent = CustomEventStub;
}
if (typeof globalThis.document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    addEventListener: (): void => { return; },
    removeEventListener: (): void => { return; },
    getElementById: (): null => null,
    querySelector: (): null => null,
    querySelectorAll: (): never[] => [],
    createElement: (): Record<string, unknown> => ({
      style: {},
      getContext: () => ({
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => { return; },
        createRadialGradient: () => ({ addColorStop: () => { return; } }),
        createLinearGradient: () => ({ addColorStop: () => { return; } }),
        fillRect: () => { return; }, clearRect: () => { return; }, drawImage: () => { return; },
      }),
      addEventListener: () => { return; },
      appendChild: (n: unknown) => n,
    }),
    createTextNode: (s: string) => ({ textContent: s }),
    body: { append: () => { return; }, appendChild: () => { return; } },
    hidden: false,
  };
}
if (typeof globalThis.HTMLInputElement === 'undefined') {
  class HtmlStub { /* instanceof ctor only */ }
  (globalThis as Record<string, unknown>).HTMLInputElement = HtmlStub;
  (globalThis as Record<string, unknown>).HTMLTextAreaElement = HtmlStub;
  (globalThis as Record<string, unknown>).HTMLElement = HtmlStub;
}

import { readFile } from 'node:fs/promises';
// Logger's console tap (imported transitively via balls.ts) swallows
// console.log at module load � bind the original before any client import.
const say = console.log.bind(console);
import { extname } from 'node:path';

// ---- tolerances -----------------------------------------------------------
const DT = 1 / 60;                  // fixed replay step
const BALL_DIV_WARN = 1.5;          // m — per-checkpoint drift worth reporting
const BALL_DIV_MEDIAN_FAIL = 40;    // m — median of per-ball max divergences
const BALL_DIV_FRAC_FAIL = 0.6;     // fail if this fraction of balls exceed the median gate
const BALL_DIV_SINGLE_FAIL = 400;   // m — beyond even a missed teleport leg
const TELEPORT_JUMP = 40;           // m — recorded re-seat, snap don't measure
const PROJ_DIV_WARN = 15;           // m — dropped Fired records (rate-limit) make
                                    // ~10m terminal-miss baseline on honest clips
const PROJ_DIV_FAIL = 40;           // m — a miss this big is a broken trajectory
const REMOTE_SPEED_CAP = 160;       // m/s implied — beyond = wire corruption
const LOCAL_SPEED_CAP = 200;        // m/s — camera body envelope
const YAW_SPIN_DT = 0.05;           // s — |Δyaw|>π/2 inside this flags a spin
const TIMESTAMP_OVERRUN = 1;        // s — lane data past duration is a write bug
const MAX_ISSUES = 25;

type V3 = { x: number; y: number; z: number };
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const issues: string[] = [];
let issueCount = 0;
const bad = (cls: string, msg: string): void => {
  issueCount += 1;
  if (issues.length < MAX_ISSUES) {issues.push(`[${cls}] ${msg}`);}
};

// Dynamic imports — the stubs above must exist before client modules load.
const { deserializeDemo } = await import('../client/src/demo/demoReader.ts');
const T = await import('../client/src/demo/types.ts');
const { getProjectileConfig } = await import('../client/src/projectiles/index.ts');
const { hmapToField } = await import('../client/src/demo/demoHmap.ts');
const { makeSimBall, stepBall } = await import('../shared/ballSim.ts');
const { GRAVITY } = await import('../shared/movement.ts');
type HeightfieldT = import('../shared/heightfield.ts').Heightfield;
type DemoFileT = import('../client/src/demo/types.ts').DemoFile;
type TargetEventT = import('../client/src/demo/types.ts').TargetEvent;

// ---- ball lane -------------------------------------------------------------
// Per-ball Quantum-checksum replay: each ball's recorded edges are replayed
// in its own harness — sim runs free between checkpoints, diverges, and the
// next recorded edge measures what the pbTarget blend would hide.
function checkBalls(demo: DemoFileT, tag: string, field: HeightfieldT | null): void {
  // Group the ball lane's events by id; Spawned order defines replay start.
  const byBall = new Map<number, TargetEventT[]>();
  const orphans = new Set<number>();
  for (const e of demo.targetEvents) {
    if (e.targetType >= T.TARGETTYPE_CREATURE_BASE) {continue;} // ball lane = 0-63
    if (e.eventType === T.TargetEventType.Spawned) {
      const l = byBall.get(e.targetId) ?? [];
      l.push(e);
      byBall.set(e.targetId, l);
      continue;
    }
    const l = byBall.get(e.targetId);
    if (!l || l.length === 0) {orphans.add(e.targetId); continue;}
    l.push(e);
  }
  if (orphans.size > 0) {
    say(`  ball lane orphans: ${orphans.size} ids with edges but no Spawned (clip-edge truncation is normal)`);
    if (orphans.size > 10) {bad('lifecycle', `${tag} ${orphans.size} ball ids have edges with no Spawned — lifecycle flood`);}
  }
  const stats: { id: number; maxDiv: number; firstDivT: number | null; teleports: number }[] = [];
  for (const [id, evs] of byBall) {
    const spawn = evs[0]!;
    // SimBall, not Ball: predictor semantics (authoritative=false) — the
    // authority's stall/teleport RNG branches don't fire here; the recorded
    // edges already carry their outcomes. The recorded vel at a checkpoint
    // is the post-impulse state, so the sim rebuilds clean each re-seat.
    const variant = Math.min(3, spawn.targetType) as 0 | 1 | 2 | 3;
    let sim = makeSimBall(id, variant, 0,
      { x: spawn.posX, y: spawn.posY, z: spawn.posZ }, { x: spawn.velX, y: spawn.velY, z: spawn.velZ });
    if (spawn.health > 0) {sim.health = spawn.health;}
    const reseat = (e: TargetEventT): void => {
      const hp = sim.health;
      sim = makeSimBall(id, variant, sim.colorIdx,
        { x: e.posX, y: e.posY, z: e.posZ }, { x: e.velX, y: e.velY, z: e.velZ });
      sim.health = hp;
    };
    let maxDiv = 0, firstDivT: number | null = null, teleports = 0;
    let last: V3 = { x: spawn.posX, y: spawn.posY, z: spawn.posZ };
    let ei = 1;
    for (let t = spawn.timestamp + DT; t <= demo.header.duration + DT && !sim.dead; t += DT) {
      let reseated = false;
      while (ei < evs.length && evs[ei]!.timestamp <= t) {
        const e = evs[ei]!; ei += 1;
        const rec = { x: e.posX, y: e.posY, z: e.posZ };
        if (e.eventType === T.TargetEventType.Spawned) {
          teleports += 1; last = rec; reseat(e); reseated = true; // id reuse — re-seat
          continue;
        }
        const jump = dist(last, rec); last = rec;
        if (jump > TELEPORT_JUMP) {teleports += 1; reseat(e); reseated = true; continue;}
        const d = dist(sim, rec);
        if (d > maxDiv) {maxDiv = d;}
        if (d > BALL_DIV_WARN && firstDivT === null) {firstDivT = e.timestamp;}
        if (e.eventType === T.TargetEventType.Hit && e.health <= 0) {sim.dead = true;}
        reseat(e); reseated = true;
      }
      if (!sim.dead && !reseated) {
        if (field) {stepBall(sim, DT, field, null, false);}
        else {sim.vy += GRAVITY * DT; sim.x += sim.vx * DT; sim.y += sim.vy * DT; sim.z += sim.vz * DT;}
      }
    }
    stats.push({ id, maxDiv, firstDivT, teleports });
  }
  if (stats.length === 0) {return;}
  const maxes = stats.map((s) => s.maxDiv).sort((a, b) => a - b);
  const median = maxes[Math.floor(maxes.length / 2)]!;
  const worst = maxes[maxes.length - 1]!;
  const mean = maxes.reduce((a, b) => a + b, 0) / maxes.length;
  const warned = stats.filter((s) => s.maxDiv > BALL_DIV_WARN).length;
  const teleports = stats.reduce((a, s) => a + s.teleports, 0);
  say(`  ball lane: ${stats.length} balls, ${teleports} teleports, maxDiv mean ${mean.toFixed(2)}m median ${median.toFixed(2)}m worst ${worst.toFixed(2)}m, ${warned} >${BALL_DIV_WARN}m`);
  for (const s of stats.filter((x) => x.maxDiv > BALL_DIV_WARN).sort((a, b) => b.maxDiv - a.maxDiv).slice(0, 5)) {
    say(`    ball ${s.id}: maxDiv ${s.maxDiv.toFixed(2)}m first @${s.firstDivT?.toFixed(2)}s teleports=${s.teleports}`);
  }
  // Format blind spot: enrage/stall legs carry their target on the wire
  // segment, not in the TargetEvent — a predictor replays them ballistically
  // and honest drift over a multi-second gap is tens of meters. Gates fire
  // on FLEET divergence, not one bad leg.
  const over = stats.filter((x) => x.maxDiv > BALL_DIV_MEDIAN_FAIL).length / stats.length;
  if (median > BALL_DIV_MEDIAN_FAIL || over > BALL_DIV_FRAC_FAIL) {
    bad('divergence', `${tag} ball replay divergence: median ${median.toFixed(1)}m, ${(over * 100).toFixed(0)}% of balls >${BALL_DIV_MEDIAN_FAIL}m`);
  }
  for (const s of stats.filter((x) => x.maxDiv > BALL_DIV_SINGLE_FAIL).slice(0, 3)) {
    bad('divergence', `${tag} ball ${s.id} maxDiv ${s.maxDiv.toFixed(1)}m > ${BALL_DIV_SINGLE_FAIL}m non-teleport — broken replay`);
  }
  void worst;
}

// ---- projectile lane -------------------------------------------------------
interface ProjSim { pos: V3; vel: V3; dead: boolean }
function checkProjectiles(demo: DemoFileT, tag: string): Promise<void> {
  // Ballistic replica of each Fired shell: spawn on recorded pos+vel,
  // integrate at fixed dt, diff at each recorded edge. The real Projectile
  // class pulls scene/VFX deps — trajectory truth here is speed+gravity,
  // which is all an edge-vs-arc diff needs.
  const shells = new Map<number, { sim: ProjSim; firedT: number; gravity: boolean; maxDiv: number; terminalMiss: boolean; edges: number }>();
  const orphans = new Set<number>();
  for (const e of demo.projectileEvents) {
    if (e.eventType === T.ProjectileEventType.Fired) {
      const cfg = getProjectileConfig(e.weaponType);
      if (!cfg || cfg.speed <= 0) {continue;} // beams have no trajectory
      shells.set(e.projectileId, {
        sim: { pos: { x: e.posX, y: e.posY, z: e.posZ }, vel: { x: e.velX, y: e.velY, z: e.velZ }, dead: false },
        firedT: e.timestamp, gravity: cfg.gravity, maxDiv: 0, terminalMiss: false, edges: 0,
      });
      continue;
    }
    const sh = shells.get(e.projectileId);
    if (!sh) {orphans.add(e.projectileId); continue;}
    // advance replica to edge time, tracking min distance to the recorded
    // point — a terminal edge sits ON the arc, not at its extrapolated end,
    // so endpoint compare alone would flag every faithful shell.
    const dt = e.timestamp - sh.firedT;
    if (dt < 0) {continue;}
    const rec = { x: e.posX, y: e.posY, z: e.posZ };
    const n = Math.max(1, Math.round(dt / DT));
    const step = dt / n;
    let minD = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (sh.gravity) {sh.sim.vel.y += GRAVITY * step;}
      sh.sim.pos.x += sh.sim.vel.x * step;
      sh.sim.pos.y += sh.sim.vel.y * step;
      sh.sim.pos.z += sh.sim.vel.z * step;
      const dd = dist(sh.sim.pos, rec);
      if (dd < minD) {minD = dd;}
    }
    sh.firedT = e.timestamp;
    const d = e.eventType === T.ProjectileEventType.Bounce ? dist(sh.sim.pos, rec) : minD;
    sh.edges += 1;
    if (d > sh.maxDiv) {sh.maxDiv = d;}
    if (e.eventType === T.ProjectileEventType.Bounce) {
      // checkpoint: re-seat on recorded state
      sh.sim.pos = rec;
      sh.sim.vel = { x: e.velX, y: e.velY, z: e.velZ };
    } else {
      // Hit/Destroyed — terminal edge
      if (d > PROJ_DIV_WARN) {sh.terminalMiss = true;}
      sh.sim.dead = true;
    }
  }
  if (orphans.size > 0) {
    say(`  proj lane orphans: ${orphans.size} ids with edges but no Fired (rate-limited/clip-edge spawns)`);
    if (orphans.size > 10) {bad('lifecycle', `${tag} ${orphans.size} projectiles have edges with no Fired — lifecycle flood`);}
  }
  const live = [...shells.values()].filter((s) => s.edges > 0);
  if (live.length === 0) {say('  proj lane: no tracked shells'); return;}
  const maxes = live.map((s) => s.maxDiv);
  const worst = Math.max(...maxes);
  const mean = maxes.reduce((a, b) => a + b, 0) / maxes.length;
  const missed = live.filter((s) => s.terminalMiss).length;
  say(`  proj lane: ${live.length} shells w/edges, maxDiv mean ${mean.toFixed(2)}m worst ${worst.toFixed(2)}m, ${missed} missed terminal`);
  for (const s of live.filter((x) => x.maxDiv > PROJ_DIV_FAIL).slice(0, 5)) {
    bad('divergence', `${tag} shell missed recorded terminal by ${s.maxDiv.toFixed(1)}m`);
  }
  if (missed / live.length > 0.75) {
    bad('divergence', `${tag} ${missed}/${live.length} shells missed their recorded terminal >${PROJ_DIV_WARN}m — lane-wide replay failure`);
  }
}

// ---- remote lane (pure data) ----------------------------------------------
function checkRemotes(demo: DemoFileT, tag: string): void {
  const bySeat = new Map<number, { last: import('../client/src/demo/types.ts').RemoteFrame; speeds: number[]; viol: number }>();
  for (const f of demo.remoteFrames) {
    if (f.rosterIdx >= demo.roster.length) {
      bad('structural', `${tag} remoteFrame rosterIdx ${f.rosterIdx} >= roster ${demo.roster.length}`);
      continue;
    }
    if (!Number.isFinite(f.posX + f.posY + f.posZ + f.yaw + f.pitch + f.timestamp)) {
      bad('structural', `${tag} remoteFrame t=${f.timestamp} idx=${f.rosterIdx} non-finite`);
      continue;
    }
    if (f.timestamp > demo.header.duration + TIMESTAMP_OVERRUN) {
      bad('structural', `${tag} remoteFrame t=${f.timestamp.toFixed(1)}s past duration ${demo.header.duration.toFixed(1)}s (idx ${f.rosterIdx}) — shifted lane`);
      continue;
    }
    const s = bySeat.get(f.rosterIdx) ?? { last: null as never, speeds: [], viol: 0 };
    if (s.last) {
      const dt = f.timestamp - s.last.timestamp;
      if (dt < -1e-4) {
        bad('kinematic', `${tag} remote idx ${f.rosterIdx} timestamp rewinds ${s.last.timestamp.toFixed(2)}→${f.timestamp.toFixed(2)}`);
      } else if (dt > 1e-6) {
        const d = Math.hypot(f.posX - s.last.posX, f.posY - s.last.posY, f.posZ - s.last.posZ);
        const v = d / dt;
        s.speeds.push(v);
        if (!(f.flags & T.RemoteFrameFlags.Teleport) && v > REMOTE_SPEED_CAP) {
          s.viol += 1;
          if (s.viol <= 2) {bad('kinematic', `${tag} remote idx ${f.rosterIdx} implied speed ${v.toFixed(0)} m/s @${f.timestamp.toFixed(2)}s`);}
        }
      }
    }
    s.last = f;
    bySeat.set(f.rosterIdx, s);
  }
  const seats = [...bySeat.entries()].filter(([, s]) => s.speeds.length > 0);
  if (seats.length) {
    const mean = seats.reduce((a, [, s]) => a + s.speeds.reduce((x, y) => x + y, 0) / s.speeds.length, 0) / seats.length;
    say(`  remote lane: ${demo.remoteFrames.length} frames across ${seats.length} seats, mean implied speed ${mean.toFixed(1)} m/s`);
  }
}

// ---- camera lane -----------------------------------------------------------
function checkCamera(demo: DemoFileT, tag: string): void {
  let prev: import('../client/src/demo/types.ts').DemoFrame | null = null;
  let spins = 0, localJumps = 0;
  for (const f of demo.frames) {
    if (!Number.isFinite(f.posX + f.posY + f.posZ + f.velX + f.velY + f.velZ + f.yaw + f.pitch + f.timestamp)) {
      bad('structural', `${tag} frame ${f.frameNumber} non-finite`);
      continue;
    }
    if (f.timestamp > demo.header.duration + TIMESTAMP_OVERRUN) {
      bad('structural', `${tag} frame t=${f.timestamp.toFixed(1)}s past duration`);
    }
    if (prev) {
      const dt = f.timestamp - prev.timestamp;
      if (dt < -1e-4) {bad('structural', `${tag} frame timestamp rewinds @${f.frameNumber}`);}
      else if (dt > 1e-6) {
        const v = Math.hypot(f.posX - prev.posX, f.posY - prev.posY, f.posZ - prev.posZ) / dt;
        if (v > LOCAL_SPEED_CAP) {
          // a lone clip-boundary re-seat is noise; a pattern is corruption
          localJumps += 1;
          if (localJumps > 2) {bad('kinematic', `${tag} local implied speed ${v.toFixed(0)} m/s @${f.timestamp.toFixed(2)}s`);}
        }
        // wrapped Δyaw — a ±π boundary hop is legit, continuous growth isn't
        let dy = f.yaw - prev.yaw;
        while (dy > Math.PI) {dy -= 2 * Math.PI;}
        while (dy < -Math.PI) {dy += 2 * Math.PI;}
        if (Math.abs(dy) > Math.PI / 2 && dt < YAW_SPIN_DT) {
          spins += 1;
          if (spins <= 3) {bad('kinematic', `${tag} yaw spin Δ${dy.toFixed(2)}rad in ${(dt * 1000).toFixed(0)}ms @${f.timestamp.toFixed(2)}s`);}
        }
      }
    }
    prev = f;
  }
}

// ---- per-file driver --------------------------------------------------------
async function checkFile(path: string): Promise<void> {
  const tag = `[${path}]`;
  const data = await readFile(path);
  const demo = deserializeDemo(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const lanes: Record<string, number> = { ball: 0, creature: 0, deploy: 0, kill: 0, flag: 0, pickup: 0 };
  for (const e of demo.targetEvents) {
    const tt = e.targetType;
    lanes[tt === T.TARGETTYPE_KILL ? 'kill' : tt === T.TARGETTYPE_FLAG ? 'flag'
      : tt >= T.TARGETTYPE_PICKUP_BASE ? 'pickup' : tt >= T.TARGETTYPE_DEPLOY_BASE ? 'deploy'
      : tt >= T.TARGETTYPE_CREATURE_BASE ? 'creature' : 'ball']!++;
  }
  const projFired = demo.projectileEvents.filter((e) => e.eventType === T.ProjectileEventType.Fired).length;
  say(`${path}: v${demo.header.formatVersion} ${demo.header.mode}/${demo.header.room}, ` +
    `${demo.frames.length} local + ${demo.remoteFrames.length} remote frames, ` +
    `proj fired=${projFired} evts=${demo.projectileEvents.length}, ` +
    `targets: ${Object.entries(lanes).map(([k, v]) => `${k}=${v}`).join(' ')}, ` +
    `roster ${demo.roster.length}, ${demo.header.duration.toFixed(1)}s${demo.heightmap ? '' : ' (no hmap)'}`);
  for (const [lane, n] of Object.entries(lanes)) {
    if (n === 0 && lane === 'ball') {say(`    note: zero ${lane} events — lane absent in this recording`);}
  }
  // Embedded HMAP = the clip's real battlefield — bounce replays land on
  // the recorded terrain instead of a flat fallback's gravity-only arcs.
  const field = demo.heightmap ? hmapToField(demo.heightmap) : null;
  if (field) {say(`  terrain: embedded hmap ${field.size}^2 bound`);}
  // Lane-span alignment: a shifted lane (capture writing remote/proj on a
  // different epoch) leaves the whole lane outside the local span.
  const span = (a: { timestamp: number }[]): [number, number] | null =>
    a.length ? [a[0]!.timestamp, a[a.length - 1]!.timestamp] : null;
  const local = span(demo.frames);
  for (const [name, lane] of [['remoteFrames', span(demo.remoteFrames)], ['projectileEvents', span(demo.projectileEvents)]] as const) {
    if (!local || !lane) {continue;}
    if (lane[0] > local[1] + 3 || lane[1] < local[0] - 3 || Math.abs(lane[0] - local[0]) > 10) {
      bad('structural', `${tag} ${name} span ${lane[0].toFixed(1)}..${lane[1].toFixed(1)}s vs local ${local[0].toFixed(1)}..${local[1].toFixed(1)}s — shifted lane epoch`);
    }
  }
  checkCamera(demo, tag);
  checkRemotes(demo, tag);
  checkBalls(demo, tag, field);
  checkProjectiles(demo, tag);
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  say('usage: bun _tools/demosimcheck.ts <file.demo> [...]');
  process.exit(2);
}
for (const path of inputs) {
  if (extname(path) !== '.demo') {continue;}
  try {
    await checkFile(path);
  } catch (e) {
    bad('structural', `[${path}] ${(e as Error).message}`);
  }
}
for (const i of issues) {say(`  ${i}`);}
if (issueCount > issues.length) {say(`  ... +${issueCount - issues.length} more`);}
say(issueCount === 0 ? 'SIMCHECK PASS' : `SIMCHECK FAIL — ${issueCount} issues`);
process.exit(issueCount === 0 ? 0 : 1);
