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
import { stepBall, makeSimBall, BALL_GRAVITY, type SimBall, type BallVariant } from '../../shared/ballSim.ts';
import { type Heightfield } from '../../shared/heightfield.ts';
import { readFileSync } from 'fs';
import path from 'path';

const DURATION_S = Number(process.argv[2] ?? 30);
const WS_URL = process.env.PVP_WS ?? 'ws://localhost:8000/ws';
const NAME = `REPLAY-${Math.floor(Math.random() * 1000)}`;

const hmBuf = readFileSync(path.join(__dirname, '../../server_bun/heightmap.bin'));
const hmSize = Math.round(Math.sqrt(hmBuf.byteLength));
const HM: Heightfield = { size: hmSize, data: new Uint8Array(hmBuf), stride: 1 };

// Stamped sim-clock estimate, same as netBalls' ballClock.
let clockT = -1, clockAt = 0;
const simNow = () => clockT < 0 ? Infinity : clockT + (performance.now() / 1000 - clockAt);

interface Replay {
  sim: SimBall;       // last event state (grid-aligned anchor)
  simT: number;       // sim cursor on the server grid
  flightT: number;    // seconds on current inert leg
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
    sim, simT: m.t, flightT: age, netAcc: Math.min(age, 0.5), lastTick: performance.now(),
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
    r.flightT = Math.min(r.flightT + dt, 8);
    const T = r.flightT;
    r.pos = {
      x: s.x + s.vx * T,
      y: s.y + s.vy * T + 0.5 * BALL_GRAVITY * (T * T + 0.05 * T),
      z: s.z + s.vz * T,
    };
  }
}

const stats = new Map<string, { n: number; max: number; sum: number; over2: number; over4: number }>();
let events = 0;
const ws = new WebSocket(WS_URL);
ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: NAME }));
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
  if (m.t > clockT) { clockT = m.t; clockAt = now / 1000; }
  const age = clockT < 0 ? 0 : Math.max(0, Math.min(0.6, clockT + (now / 1000 - clockAt) - m.t));
  events++;

  const r = replays.get(m.id);
  if (r) {
    advance(r); // replay to now, then compare against the event's truth
    const lead = { x: r.pos.x + (r.sim.vx) * age, y: r.pos.y, z: r.pos.z }; // rough 'pred at truth time'
    void lead;
    const dx = r.pos.x - m.position.x, dy = r.pos.y - m.position.y, dz = r.pos.z - m.position.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const k = m.kind;
    const st = stats.get(k) ?? { n: 0, max: 0, sum: 0, over2: 0, over4: 0 };
    st.n++; st.max = Math.max(st.max, err); st.sum += err;
    if (err > 2) st.over2++;
    if (err > 4) st.over4++;
    stats.set(k, st);
    if (err > 4) console.log(`[replay] #${m.id} ${k} divergence ${err.toFixed(1)}m (age ${Math.round(age * 1000)}ms)`);
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
  for (const [kind, st] of [...stats.entries()].sort()) {
    const mean = st.sum / st.n;
    console.log(`  ${kind.padEnd(9)} n=${String(st.n).padStart(4)}  mean=${mean.toFixed(2)}m  max=${st.max.toFixed(1)}m  >2m:${st.over2}  >4m:${st.over4}`);
    if (kind !== 'teleport') fail += st.over4;
  }
  console.log(fail === 0 ? '[replay] PASS — no non-teleport divergence >4m' : `[replay] FAIL — ${fail} events >4m`);
  process.exit(fail === 0 ? 0 : 1);
}, DURATION_S * 1000);
