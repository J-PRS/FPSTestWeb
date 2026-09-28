/**
 * Ball-replay E2E probe — joins the live server and verifies the client's
 * ball prediction scheme over the REAL wire: decodes ballSegment frames,
 * replays them through the same logic Ball.update uses (closed-form
 * ballistics for inert legs, grid-aligned 50ms stepping for enraged pulls)
 * and measures divergence at each event — the same quantity the in-game
 * rubberband warn reports.
 *
 * Usage:
 *   bun ballreplay.ts [seconds]
 *
 * Prints per-kind divergence stats and FAILs (exit 1) if non-teleport
 * divergence exceeds the in-game warn threshold.
 */
import { isWireFrame, decodeBallSegment, WIRE_BALLSEG } from '../../shared/wire.ts';
import { stepBall, makeSimBall, BALL_GRAVITY, BALL_REST_SPEED, type SimBall, type BallVariant } from '../../shared/ballSim.ts';
import { type Heightfield, hmHeight } from '../../shared/heightfield.ts';
import { readFileSync } from 'fs';
import path from 'path';

const DURATION_S = Number(process.argv[2] ?? 30);
const WS_URL = process.env.PVP_WS ?? 'ws://localhost:8000/ws';
const NAME = `REPLAY-${Math.floor(Math.random() * 1000)}`;

const hmBuf = readFileSync(path.join(__dirname, '../../server_bun/heightmap.bin'));
const hmSize = Math.round(Math.sqrt(hmBuf.byteLength));
const HM: Heightfield = { size: hmSize, data: new Uint8Array(hmBuf), stride: 1 };

// Stamped sim-clock estimate, same as netBalls' ballClock — including the
// sim→wall RATE (setInterval drift): est now = t + wallΔ·rate.
let clockT = -1, clockAt = 0, clockRate = 1;
function noteStamp(t: number): void {
  const now = performance.now() / 1000;
  if (t > clockT) {
    if (clockT >= 0) {
      const ds = t - clockT, dw = now - clockAt;
      if (ds > 0 && dw > 0.2) {
        const r = Math.min(1.2, Math.max(0.5, ds / dw));
        clockRate += (r - clockRate) * 0.2;
      }
    }
    clockT = t; clockAt = now;
  }
}
const simNow = () => clockT < 0 ? Infinity : clockT + (performance.now() / 1000 - clockAt) * clockRate;

interface Replay {
  sim: SimBall;       // last event state (grid-aligned anchor)
  simT: number;       // sim cursor on the server grid
  legT0: number;      // sim-time stamp the inert leg started at
  flightT: number;    // seconds on current inert leg (wall fallback)
  netAcc: number;     // banked time awaiting 50ms cells (enraged path)
  lastTick: number;
  pos: { x: number; y: number; z: number }; // replay's current belief
}
const replays = new Map<number, Replay>();

type Seg = NonNullable<ReturnType<typeof decodeBallSegment>>;
function makeReplay(m: Seg, age: number, variant: BallVariant = 0): Replay {
  const sim = makeSimBall(m.id, variant, 0, m.position.x, m.position.y, m.position.z,
    m.velocity.x, m.velocity.y, m.velocity.z);
  sim.enraged = m.enraged;
  sim.enrageTimer = m.et;   // wire already decodes u8 tenths → seconds
  sim.slowTimer = m.slowT;
  sim.dampNextBounce = m.damp;
  sim.targetId = m.targetId;
  if (m.tp) { sim.tx = m.tp.x; sim.ty = m.tp.y; sim.tz = m.tp.z; sim.tgtValid = true; }
  return {
    sim, simT: m.t, legT0: m.t, flightT: age, netAcc: Math.min(age, 0.5), lastTick: performance.now(),
    pos: { x: m.position.x, y: m.position.y, z: m.position.z },
  };
}

/** Advance the replay to "now" — mirrors Ball.update's netDriven branch. */
function advance(r: Replay): void {
  const now = performance.now();
  const dt = Math.min((now - r.lastTick) / 1000, 0.25);
  r.lastTick = now;
  const s = r.sim;
  if (s.enraged && s.tgtValid) {
    r.netAcc = Math.min(r.netAcc + dt, 0.5);
    const tgt = { x: s.tx, y: s.ty, z: s.tz };
    const now_ = simNow();
    while (r.netAcc >= 0.05 && r.simT + 0.05 <= now_) {
      r.netAcc -= 0.05; r.simT += 0.05;
      stepBall(s, 0.05, HM, tgt, false);
    }
    r.pos = { x: s.x, y: s.y, z: s.z };
  } else {
    const sn = simNow();
    const T = Number.isFinite(sn)
      ? Math.min(Math.max(0, sn - r.legT0), 8)
      : (r.flightT = Math.min(r.flightT + dt, 8));
    r.pos = {
      x: s.x + s.vx * T,
      y: s.y + s.vy * T + 0.5 * BALL_GRAVITY * (T * T + 0.05 * T),
      z: s.z + s.vz * T,
    };
  }
}

// Per-kind divergence thresholds, mirroring the client's warn ladder:
// lunge/teleport/spawn are unpredictable-by-design (server RNG), bounce
// carries one tick of approach overshoot, only heartbeat/segment >4m is
// a real desync.
const KIND_LIMIT: Record<string, number> = { lunge: 40, teleport: 40, spawn: 40, bounce: 12, stall: 12 };
const limitFor = (k: string) => KIND_LIMIT[k] ?? 4;
const stats = new Map<string, { n: number; max: number; sum: number; over: number }>();
// Resting detection: a ball whose events ALL report |v| < 5 (the stall
// threshold) for the whole window never got launched — the breaker's
// target gate is suspect.
const speeds = new Map<number, { n: number; slow: number; first: number; last: number }>();
let events = 0;
const ws = new WebSocket(WS_URL);
ws.binaryType = 'arraybuffer';
const ROOM = process.env.PVP_ROOM;
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: NAME, ...(ROOM ? { room: ROOM } : {}) }));
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'gameState') console.log(`[replay] joined as ${NAME}`);
      if (m.type === 'ballDie') replays.delete(m.id);
    } catch { /* partial frames etc */ }
    return;
  }
  const u8 = new Uint8Array(ev.data as ArrayBuffer);
  if (!isWireFrame(u8) || u8[1] !== WIRE_BALLSEG) return;
  const m = decodeBallSegment(u8);
  if (!m) return;
  const now = performance.now();
  noteStamp(m.t);
  const age = clockT < 0 ? 0 : Math.max(0, Math.min(0.6, simNow() - m.t));
  events++;
  {
    const sp = Math.hypot(m.velocity.x, m.velocity.y, m.velocity.z);
    const rec = speeds.get(m.id) ?? { n: 0, slow: 0, first: now, last: now };
    rec.n++; if (sp < 5) rec.slow++; rec.last = now;
    speeds.set(m.id, rec);
  }

  const r = replays.get(m.id);
  if (r) {
    advance(r); // replay to now, then compare against the event's truth
    const lead = { x: r.pos.x + (r.sim.vx) * age, y: r.pos.y, z: r.pos.z }; // rough 'pred at truth time'
    void lead;
    // Honest divergence: evaluate the previous leg's prediction AT the
    // event's stamped sim time — isolates sim-vs-sim from clock skew.
    // Enraged legs stepped so we can only compare pos-now for those.
    let px = r.pos.x, py = r.pos.y, pz = r.pos.z;
    if (!r.sim.enraged && r.legT0 >= 0) {
      const s = r.sim;
      let T = Math.min(Math.max(0, m.t - r.legT0), 8);
      px = s.x + s.vx * T;
      py = s.y + s.vy * T + 0.5 * BALL_GRAVITY * (T * T + 0.05 * T);
      pz = s.z + s.vz * T;
      // Same settle prediction as the client: sub-REST contacts park
      // silently (no segment), so predict parked at first contact.
      if (py - s.radius <= hmHeight(HM, px, pz)) {
        let tc = T;
        while (tc > 0.05) {
          const tt = tc - 0.05;
          const yy = s.y + s.vy * tt + 0.5 * BALL_GRAVITY * (tt * tt + 0.05 * tt);
          if (yy > hmHeight(HM, s.x + s.vx * tt, s.z + s.vz * tt) + s.radius) break;
          tc = tt;
        }
        const spd = Math.hypot(s.vx, s.vy + BALL_GRAVITY * tc, s.vz);
        if (spd < BALL_REST_SPEED) {
          px = s.x + s.vx * tc; pz = s.z + s.vz * tc;
          py = hmHeight(HM, px, pz) + s.radius;
        } else {
          py = hmHeight(HM, px, pz) + s.radius;
        }
      }
    }
    const dx = px - m.position.x, dy = py - m.position.y, dz = pz - m.position.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = m.kind;
    const st = stats.get(k) ?? { n: 0, max: 0, sum: 0, over: 0 };
    st.n++; st.max = Math.max(st.max, err); st.sum += err;
    if (err > limitFor(k)) st.over++;
    stats.set(k, st);
    if (err > limitFor(k)) console.log(`[replay] #${m.id} ${k} divergence ${err.toFixed(1)}m (age ${Math.round(age * 1000)}ms)`);
  }
  replays.set(m.id, makeReplay(m, age));
};

// Idle tick so replays advance between events
const tick = setInterval(() => replays.forEach(advance), 16);

setTimeout(() => {
  clearInterval(tick);
  ws.close();
  console.log(`\n[replay] ${events} segment events over ${DURATION_S}s, ${replays.size} live balls`);
  let fail = 0;
  // Stall breaker should fire within ~2s of sub-5m/s movement — a ball
  // slow across >3s of events is resting, breaker never launched it.
  const resting = [...speeds.entries()].filter(([, s]) => s.last - s.first > 3000 && s.slow === s.n);
  const partial = [...speeds.entries()].filter(([, s]) => s.last - s.first > 3000 && s.slow > s.n * 0.5 && s.slow < s.n);
  console.log(`  resting balls (|v|<5 for >3s of events): ${resting.length ? resting.map(([id]) => '#' + id).join(',') : 'none'}`);
  if (partial.length) console.log(`  mostly-slow: ${partial.map(([id, s]) => `#${id}(${s.slow}/${s.n})`).join(',')}`);
  for (const [kind, st] of [...stats.entries()].sort()) {
    const mean = st.sum / st.n;
    console.log(`  ${kind.padEnd(9)} n=${String(st.n).padStart(4)}  mean=${mean.toFixed(2)}m  max=${st.max.toFixed(1)}m  >${limitFor(kind)}m:${st.over}`);
    fail += st.over;
  }
  console.log(fail === 0 ? '[replay] PASS — no divergence past per-kind thresholds' : `[replay] FAIL — ${fail} events past thresholds`);
  process.exit(fail === 0 ? 0 : 1);
}, DURATION_S * 1000);
