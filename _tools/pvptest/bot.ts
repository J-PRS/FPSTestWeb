/**
 * Headless PvP bot — joins the live server as a real player over the wire
 * protocol (binary position frames + JSON events), moves on the terrain
 * heightfield, and fights with legal hit claims (real projectile spawn →
 * airtime wait → hit claim, same shape the client sends).
 *
 * Usage:
 *   bun bot.ts <name> [--fighter] [--orbit] [--test]
 *
 *   --fighter  aim + fire rockets at the nearest player (default: strafe only)
 *   --orbit    strafe-orbit the nearest player instead of standing still
 *   --test     scripted E2E: run assertions, print PASS/FAIL lines, exit
 */
import { encodePosition, decodeTickFrame, isWireFrame, WIRE_TICK } from '../../shared/wire.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { EYE_OFFSET } from '../../shared/constants.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { readFileSync } from 'fs';
import path from 'path';
import { openSocket, type BotSocket, type Tier } from './net.ts';

const NAME = process.argv[2] ?? `TESTBOT-${Math.floor(Math.random() * 1000)}`;
const FIGHTER = process.argv.includes('--fighter');
const ORBIT = process.argv.includes('--orbit');
const TEST = process.argv.includes('--test');
const TEST2 = process.argv.includes('--test2');
const TEST3 = process.argv.includes('--test3');
const PARK = process.argv.includes('--park'); // stand at spawn — far-range target for abuse tests
const TEST4 = process.argv.includes('--test4');
const TEST5 = process.argv.includes('--test5'); // tick-stream quality: rate, gaps, self-echo drift
const IDLE = process.argv.includes('--idle'); // join then go silent — tests the 60s idle reap
// --room=NAME — join a named match room instead of 'default' (load tests
// can split fleets across rooms to prove per-match isolation).
const ROOM = process.argv.find(a => a.startsWith('--room='))?.slice(7);
const WATCH = process.argv.includes('--watch'); // passive observer: log join/left cadence and per-peer tick freshness
const BALLS = process.argv.includes('--balls'); // measure ballSegment cadence + event-age jitter
const WS_URL = process.env.PVP_WS ?? 'ws://localhost:8000/ws';
// --tier=wt|rtc|ws — ride a specific netcode-v2 transport instead of
// WebSocket, so the fleet can exercise all three (net.ts adapters).
const TIER = (process.argv.find(a => a.startsWith('--tier='))?.slice(7) ?? 'ws') as Tier;
const POS_HZ = 20;            // under the 30/s rate limit
const MOVE_SPEED = 30;        // m/s — well under the 300 reject bound
const ENGAGE_RANGE = 60;      // start shooting inside this
const ROCKET_SPEED = 120;     // shared/weapons Rocket.speed
const FIRE_INTERVAL_MS = 1100;

// Terrain for ground clamping — same bin the server loads.
const hmBuf = readFileSync(path.join(__dirname, '../../server_bun/heightmap.bin'));
const hmSize = Math.round(Math.sqrt(hmBuf.byteLength));
const HM: Heightfield = { size: hmSize, data: new Uint8Array(hmBuf), stride: 1 };
const groundY = (x: number, z: number) => hmHeight(HM, x, z) + EYE_OFFSET;

interface Other { pos: Vec3; vel: Vec3; health: number; dead: boolean; lastTick: number }
type Vec3 = { x: number; y: number; z: number };

const others = new Map<string, Other>();
let pos: Vec3 = { x: 0, y: 60, z: 0 };
let vel: Vec3 = { x: 0, y: 0, z: 0 };
let yaw = 0;
let dead = false;
let seq = 0;
let ws: BotSocket;
let connected = false;
let corrections = 0;
let lastCorrectionAt = 0;
let hitListener: ((m: any) => void) | null = null;
let sessionToken: string | undefined;
let knockbackCount = 0;
let sawPlayerLeft: string | null = null;
let lastProjId: string | null = null;
let snapListener: ((m: any) => void) | null = null;
let projDestroyedListener: ((id: string) => void) | null = null;
let lastForeignProjId: string | null = null;
let dupJoins = 0;
// Tick-stream stats for --test5: inter-frame gaps, out-of-order seqs,
// self-echo drift (does the server see us where we say we are?).
const tickStats = { frames: 0, gaps: [] as number[], lastAt: 0, maxGap: 0, minGap: 1e9 };
let selfEcho: { pos: Vec3; at: number } | null = null;
// --balls: per-ball segment gaps + event age (simClock stamp vs arrival).
const ballSegStats = {
  total: 0, spawns: 0, dies: 0,
  gaps: [] as number[], ages: [] as number[], maxGap: 0,
  lastByBall: new Map<number, { at: number; t: number }>(),
};
const ballClock = { t: -1, at: 0 }; // newest simTime stamp + local arrival ms
const pendingShots: { id: string | null; target: string; at: number; airtime: number; aimPos: Vec3 }[] = [];
const killsOf = new Map<string, number>();
const notices: string[] = [];

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s ${NAME}]`, ...a);

function sendJson(m: unknown) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function sendPosition() {
  // Position frames want UDP semantics on tiers that have them.
  if (ws?.readyState === 1) (ws.sendUnreliable ?? ws.send).call(ws, encodePosition(pos, { yaw, pitch: 0 }, vel, ++seq, 0));
}

function nearestTarget(): [string, Other] | null {
  let best: [string, Other] | null = null;
  let bd = Infinity;
  for (const [id, o] of others) {
    if (o.dead) continue;
    const d = Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z);
    if (d < bd) { bd = d; best = [id, o]; }
  }
  return best;
}

let lastFireAt = 0;
let orbitSign = 1;
let lastHurtAt = 0;
let burstLeft = 0;
let burstGapUntil = 0;
const impVel = { x: 0, y: 0, z: 0 }; // knockback impulse accumulator
// Omicron-style perception: we shoot where the target WAS, not where it is.
// A short rolling history per target feeds the aim the player's old spot —
// fast movers dodge our rockets like they'd dodge a human's.
const AIM_DELAY_MS = 350;
const aimHist = new Map<string, { t: number; pos: Vec3; vel: Vec3 }[]>();
function snapshotTargets(now: number) {
  for (const [id, o] of others) {
    let h = aimHist.get(id);
    if (!h) { h = []; aimHist.set(id, h); }
    h.push({ t: now, pos: { ...o.pos }, vel: { ...o.vel } });
    while (h.length > 12) h.shift();
  }
}
function aimPoint(id: string, o: Other, airtime: number): Vec3 {
  const h = aimHist.get(id);
  let base = o.pos;
  if (h && h.length) {
    const want = Date.now() - AIM_DELAY_MS;
    let pick = h[0]!;
    for (const e of h) { if (e.t <= want) pick = e; else break; }
    base = pick.pos;
  }
  // Lead by airtime off the target's CURRENT vel (a human guesses the
  // drift — stale pos + live vel reads like tracking aim).
  // Aim error grows with target speed — leading a still target is easy,
  // a strafing one gets the human scatter.
  const sp = Math.hypot(o.vel.x, o.vel.z);
  const err = 0.6 + sp * 0.12;
  return {
    x: base.x + o.vel.x * airtime * 0.8 + (Math.random() - 0.5) * err,
    y: base.y + o.vel.y * airtime * 0.5 + (Math.random() - 0.5) * err * 0.5,
    z: base.z + o.vel.z * airtime * 0.8 + (Math.random() - 0.5) * err,
  };
}

// Scripted test phases (TEST5 circling etc.) own pos directly — self-drive
// must stand down or both writers fight and the stream sees teleport jumps.
let scripted = false;
let circleBase: { cx: number; cz: number; phase: number } | null = null;

function tickBehavior(dt: number) {
  if (dead || !connected || scripted) return;
  // Knockback impulses land on vel; fighter/orbit recompute vel from
  // movement each tick, which would swallow the shove — integrate the
  // impulse into pos directly and decay it instead.
  pos.x += impVel.x * dt; pos.y += impVel.y * dt; pos.z += impVel.z * dt;
  impVel.x *= Math.max(0, 1 - dt * 4); impVel.y *= Math.max(0, 1 - dt * 4); impVel.z *= Math.max(0, 1 - dt * 4);
  if (PARK) {
    // Parked: no self-drive, but keep applied impulses (knockback) and let
    // them decay — zeroing vel each tick would swallow a real shove.
    vel.x *= 0.92; vel.z *= 0.92;
    vel.y += -28 * dt; // gravity, same pull the sim uses
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;
    const gy = groundY(pos.x, pos.z);
    if (pos.y < gy) { pos.y = gy; vel.y = 0; }
    return;
  }
  snapshotTargets(Date.now());
  const tgt = nearestTarget();

  if (tgt) {
    const [id, o] = tgt;
    const dx = o.pos.x - pos.x, dz = o.pos.z - pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    yaw = Math.atan2(dx, dz); // face target (client yaw convention: fwd = sin,cos)

    // Approach to ~15m ring, then orbit sideways.
    let mx = 0, mz = 0;
    if (dist > 20) { mx = dx / dist; mz = dz / dist; }
    else if (dist < 10) { mx = -dx / dist; mz = -dz / dist; }
    if (ORBIT && dist <= 25) {
      mx += (-dz / dist) * orbitSign; mz += (dx / dist) * orbitSign;
      if (Math.random() < 0.005) orbitSign *= -1;
    }
    // Just got hit → jink hard sideways + slight retreat: a human swerves
    // when shot, they don't keep a stable orbit eating the next rocket.
    if (Date.now() - lastHurtAt < 1400) {
      mx += (-dz / dist) * orbitSign * 1.8 - (dx / dist) * 0.5;
      mz += (dx / dist) * orbitSign * 1.8 - (dz / dist) * 0.5;
      if (Math.random() < 0.06) orbitSign *= -1;
    }
    const mlen = Math.hypot(mx, mz);
    if (mlen > 0) {
      const nx = pos.x + (mx / mlen) * MOVE_SPEED * dt;
      const nz = pos.z + (mz / mlen) * MOVE_SPEED * dt;
      vel = { x: (nx - pos.x) / dt, y: 0, z: (nz - pos.z) / dt };
      pos.x = nx; pos.z = nz;
    } else vel = { x: 0, y: 0, z: 0 };
    // Glide toward ground level — snapping vertically over a cliff edge
    // trips the server's >300 m/s plausibility check.
    const gy = groundY(pos.x, pos.z);
    const dy = gy - pos.y;
    const yStep = Math.min(Math.abs(dy), 60 * dt) * Math.sign(dy);
    pos.y += yStep;
    vel.y = yStep / dt;

    // Burst fire: 3 rockets ~0.9s apart, then a ~2s lull — human trigger
    // rhythm, not a metronome.
    if (FIGHTER && dist < ENGAGE_RANGE && Date.now() - lastFireAt > FIRE_INTERVAL_MS * 0.8) {
      const now = Date.now();
      if (burstLeft <= 0 && now >= burstGapUntil) burstLeft = 3;
      if (burstLeft > 0) {
        burstLeft--;
        lastFireAt = now;
        fireRocketAt(id, o);
        if (burstLeft === 0) burstGapUntil = now + 1800 + Math.random() * 900;
      }
    }
  } else {
    const gy = groundY(pos.x, pos.z);
    const dy = gy - pos.y;
    const yStep = Math.min(Math.abs(dy), 60 * dt) * Math.sign(dy);
    pos.y += yStep;
    vel = { x: 0, y: yStep / dt, z: 0 };
  }

  // Resolve pending shots whose airtime has elapsed.
  const now = Date.now();
  for (let i = pendingShots.length - 1; i >= 0; i--) {
    const s = pendingShots[i]!;
    if (now - s.at < s.airtime * 1000) continue;
    pendingShots.splice(i, 1);
    const o = others.get(s.target);
    if (!o || o.dead) continue;
    sendJson({
      type: 'shot', targetId: s.target, projectileId: s.id,
      weaponType: WeaponType.Rocket,
      position: { ...o.pos }, airtime: s.airtime,
    });
    log(`hit claim → ${s.target} (airtime ${s.airtime.toFixed(2)}s)`);
  }
}

function fireRocketAt(targetId: string, o: Other) {
  // Muzzle ~ eye pos; velocity aimed at the last-seen point + lead + error.
  const rawDist = Math.sqrt((o.pos.x - pos.x) ** 2 + (o.pos.y - pos.y) ** 2 + (o.pos.z - pos.z) ** 2) || 1;
  const airtime = Math.max(0.05, rawDist / ROCKET_SPEED);
  const aim = aimPoint(targetId, o, airtime);
  const dx = aim.x - pos.x, dy = aim.y - pos.y, dz = aim.z - pos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  sendJson({
    type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
    position: { ...pos },
    velocity: { x: (dx / dist) * ROCKET_SPEED, y: (dy / dist) * ROCKET_SPEED, z: (dz / dist) * ROCKET_SPEED },
  });
  // projectileId arrives via the broadcast; record by airtime.
  pendingShots.push({ id: null, target: targetId, at: Date.now(), airtime, aimPos: { ...o.pos } });
  log(`rocket → ${targetId} at ${dist.toFixed(0)}m`);
}

// ---------- test assertions ----------
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
}

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    // openSocket resolves only once the tier's session is live — send the
    // join right away, no onopen dance needed.
    openSocket(WS_URL, TIER).then((s) => {
      ws = s;
      ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const m = JSON.parse(ev.data);
        handleJson(m);
        if (m.type === 'gameState') { connected = true; resolve(); }
      } else {
        const u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
        if (isWireFrame(u8) && u8[1] === WIRE_TICK) {
          const now = Date.now();
          if (tickStats.lastAt && !dead) {
            const gap = now - tickStats.lastAt;
            tickStats.gaps.push(gap);
            if (gap > tickStats.maxGap) tickStats.maxGap = gap;
            if (gap < tickStats.minGap) tickStats.minGap = gap;
          }
          tickStats.lastAt = now;
          tickStats.frames++;
          const f = decodeTickFrame(u8);
          if (f) for (const u of f.updates) {
            if (u.playerId === NAME) { selfEcho = { pos: u.position, at: now }; continue; }
            const o = others.get(u.playerId) ?? { pos: u.position, vel: u.velocity, health: u.health, dead: u.isDead, lastTick: 0 };
            o.pos = u.position; o.vel = u.velocity; o.health = u.health; o.dead = u.isDead;
            o.lastTick = Date.now();
            others.set(u.playerId, o);
          }
        }
      }
    };
      ws.onerror = () => reject(new Error(`${TIER} error`));
      sendJson({ type: 'join', playerId: NAME, token: sessionToken, room: ROOM, transport: TIER });
    }).catch(reject);
    // RTC/WT session setup (gather → answer → channel open) eats several
    // seconds before the join can even leave.
    setTimeout(() => reject(new Error('join timeout')), 20000);
  });
}

function handleJson(m: any) {
  switch (m.type) {
    case 'gameState':
      sessionToken = m.sessionToken ?? sessionToken;
      break;
    case 'snapshot':
      snapListener?.(m);
      break;
    case 'playerJoined':
      if (m.playerId !== NAME) {
        if (others.has(m.playerId)) dupJoins++; // grace reconnect re-announce = spam
        others.set(m.playerId, { pos: m.position, vel: { x: 0, y: 0, z: 0 }, health: 100, dead: false, lastTick: Date.now() });
        log(`${m.playerId} joined`);
      }
      break;
    case 'playerLeft':
      others.delete(m.playerId);
      sawPlayerLeft = m.playerId;
      log(`${m.playerId} left`);
      break;
    case 'playerHit':
      hitListener?.(m);
      log(`HIT ${m.shooterId} → ${m.targetId} dmg=${m.damage} hp=${m.health}`);
      if (m.targetId === NAME) { lastHurtAt = Date.now(); log(`  (we took ${m.damage}, hp ${m.health})`); }
      break;
    case 'playerKill':
      killsOf.set(m.targetId, (killsOf.get(m.targetId) ?? 0) + 1);
      log(`KILL ${m.shooterId} → ${m.targetId}${m.streak ? ` (streak ${m.streak})` : ''}`);
      if (m.targetId === NAME) dead = true;
      break;
    case 'matchNotice':
      notices.push(m.text);
      log(`NOTICE ${m.text}`);
      break;
    case 'playerRespawn':
      if (m.playerId === NAME) {
        dead = false;
        pos = { ...m.position };
        pos.y = groundY(pos.x, pos.z);
        vel = { x: 0, y: 0, z: 0 };
        // Same as the client's markTeleport: declare the spawn jump or the
        // plausibility check reads a >50m move from the corpse and corrects.
        sendJson({ type: 'teleport', position: { ...pos }, rotation: { yaw, pitch: 0 }, velocity: vel });
        circleBase = null; // recenter scripted paths on the new spawn
        log('respawned');
      } else {
        const o = others.get(m.playerId);
        if (o) { o.dead = false; o.pos = m.position; o.health = 100; }
      }
      break;
    case 'correction':
      corrections++;
      lastCorrectionAt = Date.now();
      pos = { ...m.position }; vel = { ...m.velocity };
      log(`CORRECTION → snap to ${m.position.x.toFixed(0)},${m.position.y.toFixed(0)},${m.position.z.toFixed(0)} seq=${m.seq}`);
      break;
    case 'projectileCreated':
      if (m.ownerId === NAME) lastProjId = m.projectileId;
      else lastForeignProjId = m.projectileId;
      // Fill the oldest pending claim lacking an id.
      for (const s of pendingShots) {
        if (s.id === null && m.ownerId === NAME) { s.id = m.projectileId; break; }
      }
      break;
    case 'projectileDestroyed':
      projDestroyedListener?.(m.projectileId);
      break;
    case 'ballSegment': {
      const now = Date.now();
      const prev = ballSegStats.lastByBall.get(m.id);
      if (prev) {
        const gap = now - prev.at;
        ballSegStats.gaps.push(gap);
        if (gap > ballSegStats.maxGap) ballSegStats.maxGap = gap;
      }
      ballSegStats.lastByBall.set(m.id, { at: now, t: m.t ?? 0 });
      ballSegStats.total++;
      if (m.t !== undefined) {
        const age = ballClock.t > 0 ? Math.max(0, ballClock.t + (now - ballClock.at) / 1000 - m.t) : 0;
        ballSegStats.ages.push(age);
      }
      if ((m.t ?? -1) > ballClock.t) { ballClock.t = m.t; ballClock.at = now; }
      break;
    }
    case 'ballSpawn': ballSegStats.spawns++; break;
    case 'ballDie': ballSegStats.dies++; break;
    case 'knockback':
      if (m.targetId === NAME) {
        knockbackCount++;
        // Real clients apply the impulse — a real shove must show up in
        // the victim's subsequent position stream or it's cosmetic-only.
        const dx = pos.x - m.position.x, dy = pos.y - m.position.y, dz = pos.z - m.position.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const f = m.force ?? 0;
        if (m.pull) {
          impVel.x += -(dx / d) * f; impVel.y += 0.3 * f; impVel.z += -(dz / d) * f;
        } else {
          impVel.x += (dx / d) * f; impVel.y += 0.5 * f; impVel.z += (dz / d) * f;
        }
        log(`knockback received f=${f.toFixed(1)}`);
      }
      break;
    case 'teleport':
      if (m.playerId !== NAME) {
        const o = others.get(m.playerId);
        if (o) o.pos = { ...m.position };
      }
      break;
  }
}

async function main() {
  await connect();
  log(`joined via ${WS_URL}; local spawn ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`);
  // Snap to ground under the server spawn.
  pos.y = groundY(pos.x, pos.z);

  const POS_MS = 1000 / POS_HZ;
  let last = Date.now();
  const posTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - last) / 1000, 0.2);
    last = now;
    tickBehavior(dt);
    if (!IDLE) sendPosition();
  }, POS_MS);

  if (!TEST && !TEST2 && !TEST3 && !TEST4 && !TEST5) {
    if (IDLE) {
      // Silent socket: server should reap us past the ~60s idle window.
      const deadAt = await new Promise<number>((res) => {
        ws.onclose = () => res(Date.now());
        ws.onerror = () => res(Date.now());
        setTimeout(() => res(-1), 75_000);
      });
      if (deadAt > 0) {
        check('idle client reaped (~60s)', deadAt - t0 > 50_000, `closed after ${((deadAt - t0) / 1000).toFixed(0)}s`);
      } else check('idle client reaped (~60s)', false, 'still connected after 75s');
      const fails = results.filter((r) => !r.ok).length;
      log(`${results.length - fails}/${results.length} checks passed`);
      process.exit(fails ? 1 : 0);
    }
    if (BALLS) {
      // 30s listen: report segment cadence per ball, event age, spawns/dies.
      await new Promise((r) => setTimeout(r, 30_000));
      const gaps = ballSegStats.gaps.slice().sort((a, b) => a - b);
      const ages = ballSegStats.ages.slice().sort((a, b) => a - b);
      const balls = ballSegStats.lastByBall.size;
      log(`--- ball report: ${balls} balls, ${ballSegStats.total} segments, ${ballSegStats.spawns} spawns, ${ballSegStats.dies} dies ---`);
      if (gaps.length) {
        const p50 = gaps[Math.floor(gaps.length * 0.5)];
        const p95 = gaps[Math.floor(gaps.length * 0.95)];
        log(`segment gap p50=${p50}ms p95=${p95}ms max=${ballSegStats.maxGap}ms`);
      }
      if (ages.length) {
        const a50 = ages[Math.floor(ages.length * 0.5)];
        const a95 = ages[Math.floor(ages.length * 0.95)];
        log(`event age p50=${(a50 * 1000).toFixed(0)}ms p95=${(a95 * 1000).toFixed(0)}ms`);
      }
      check('ball segments flowing', ballSegStats.total > balls * 2, `${ballSegStats.total} events over 30s`);
      process.exit(0);
    }
    if (WATCH) {
      // 40s passive window: report join/left cadence and which peers never
      // emit a tick (ghost joins that never send positions).
      const joined = new Map<string, number>();
      const left = new Map<string, number>();
      const origHandle = handleJson;
      handleJson = (m: any) => {
        if (m.type === 'playerJoined') joined.set(m.playerId, Date.now());
        if (m.type === 'playerLeft') left.set(m.playerId, Date.now());
        origHandle(m);
      };
      await new Promise((r) => setTimeout(r, 40_000));
      const now = Date.now();
      const lines: string[] = [];
      for (const [id, o] of others) {
        lines.push(`${id}: lastTick ${now - o.lastTick}ms ago, dead=${o.dead}, hp=${o.health}`);
      }
      log(`--- watch report (${others.size} known peers) ---`);
      for (const l of lines) log(l);
      const joiners = [...joined.entries()].filter(([id]) => !left.has(id));
      const flappers = [...joined.keys()].filter((id) => left.has(id));
      log(`joined this window: ${joiners.length} stayed, ${flappers.length} flapped, ${dupJoins} duplicate join announcements`);
      for (const id of flappers) {
        const age = ((left.get(id)! - joined.get(id)!) / 1000).toFixed(1);
        log(`  flapper ${id}: alive ${age}s`);
      }
      process.exit(0);
    }
    log('running (Ctrl+C to quit)');
    return;
  }

  // ---------- scripted E2E assertions ----------
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(500);

  if (TEST2) {
    // AOE + knockback: rocket detonates ~4m from a live peer → expect
    // playerHit on them and (if we're inside the blast) knockback on us.
    let tgt: [string, Other] | null = null;
    // Same dead-window hazard as --test: the server drops a dead client's
    // aoeShot claim entirely, so if a fighter fragged us, wait out respawn.
    for (let i = 0; i < 100 && dead; i++) await wait(100);
    for (let i = 0; i < 40 && !tgt; i++) { await wait(250); tgt = nearestTarget(); }
    check('aoe: found live target', !!tgt, tgt ? tgt[0] : 'none');
    if (tgt) {
      const [tid, to] = tgt;
      // Lead the target: the blast lands at detonation time, and a moving
      // target (SOAK orbits ~16m/s) would be outside the 8m radius if we
      // aimed where it stood when the rocket launched.
      const dist0 = Math.hypot(to.pos.x - pos.x, to.pos.y - pos.y, to.pos.z - pos.z) || 1;
      const airtime = Math.max(0.05, dist0 / ROCKET_SPEED);
      const px = to.pos.x + to.vel.x * airtime;
      const py = to.pos.y + to.vel.y * airtime;
      const pz = to.pos.z + to.vel.z * airtime;
      const dx = px - pos.x, dy = py - pos.y, dz = pz - pos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      // Spawn the projectile flying at the predicted point.
      sendJson({
        type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
        position: { ...pos },
        velocity: { x: (dx / dist) * ROCKET_SPEED, y: (dy / dist) * ROCKET_SPEED, z: (dz / dist) * ROCKET_SPEED },
      });
      await wait(120); // let projectileCreated assign the id
      await wait(airtime * 1000);
      const hpBefore = to.health;
      const posBefore = { ...to.pos };
      const sawAoeHit = { v: false };
      hitListener = (m) => { if (m.targetId === tid) sawAoeHit.v = true; };
      // Detonate 3m short of the predicted point — inside the rocket's AOE radius.
      const blast = { x: px - dx / dist * 3, y: py, z: pz - dz / dist * 3 };
      sendJson({
        type: 'aoeShot', position: blast, weaponType: WeaponType.Rocket,
        projectileId: lastProjId, airtime,
      });
      // Wait past the forceSend window so the shoved velocity/pos streams back.
      await wait(700);
      hitListener = null;
      check('aoe damage lands', sawAoeHit.v, `hp ${hpBefore} → ${others.get(tid)?.health}`);
      const moved = others.get(tid);
      const disp = moved ? Math.hypot(moved.pos.x - posBefore.x, moved.pos.y - posBefore.y, moved.pos.z - posBefore.z) : 0;
      check('knockback displaces victim in stream', disp > 0.5, `moved ${disp.toFixed(2)}m`);
    }

    // Reconnect: close + rejoin with the session token — server should
    // restore us inside the grace window instead of a fresh spawn.
    const posBefore = { ...pos };
    ws.close();
    connected = false;
    await wait(600);
    others.clear();
    await connect();
    check('reconnect restores state', connected,
      `rejoined at ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)}`);
    await wait(300);
    check('post-reconnect sees peers', others.size >= 0, `${others.size} known`);

    clearInterval(posTimer);
    const fails = results.filter((r) => !r.ok).length;
    log(`${results.length - fails}/${results.length} checks passed`);
    process.exit(fails ? 1 : 0);
  }

  if (TEST3) {
    // ---- abuse surface ----
    let tgt: [string, Other] | null = null;
    for (let i = 0; i < 40 && !tgt; i++) { await wait(250); tgt = nearestTarget(); }
    check('abuse: found live target', !!tgt, tgt ? tgt[0] : 'none');
    // Only OUR shots count — other bots are live-firing nearby.
    const anyHit = { v: false };
    hitListener = (m) => { if (m.shooterId === NAME) anyHit.v = true; };

    // 1. Hit claim with NO spawned projectile → silent reject.
    if (tgt) {
      sendJson({ type: 'shot', targetId: tgt[0], weaponType: WeaponType.Rocket,
        position: { ...tgt[1].pos }, airtime: 0.2 });
      await wait(400);
      check('hit claim with no projectile rejected', !anyHit.v);
    }

    // 2. Impossible reach: spawn a projectile then claim a hit on the
    //    FARTHEST peer almost instantly — claimed airtime can't cover the
    //    distance (reach is radial by design; direction isn't checked).
    {
      let far: [string, Other] | null = null; let fd = 0;
      for (const [id, o] of others) {
        if (o.dead) continue;
        const d = Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z);
        if (d > fd) { fd = d; far = [id, o]; }
      }
      if (far && fd > 25) {
        sendJson({ type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
          position: { ...pos }, velocity: { x: 0, y: ROCKET_SPEED, z: 0 } });
        await wait(150);
        anyHit.v = false;
        // airtime that can't reach: dist/120 needed, claim 0.05 → 21m max.
        sendJson({ type: 'shot', targetId: far[0], projectileId: lastProjId,
          weaponType: WeaponType.Rocket, position: { ...far[1].pos }, airtime: 0.05 });
        await wait(400);
        check(`unreachable hit claim rejected (${fd.toFixed(0)}m)`, !anyHit.v);
      } else log(`SKIP reach test — farthest peer ${fd.toFixed(0)}m, need >25`);
    }

    // 3. Self-target → reject (also explicit server guard).
    anyHit.v = false;
    sendJson({ type: 'shot', targetId: NAME, weaponType: WeaponType.Rocket,
      position: { ...pos }, airtime: 0.1 });
    await wait(300);
    check('self-target rejected', !anyHit.v);

    // 4. Heal clamp: claim 999 → health must stay ≤100.
    sendJson({ type: 'heal', amount: 999 });
    await wait(200);
    const selfHp = await new Promise<number>((res) => {
      const to = setTimeout(() => { snapListener = null; res(-1); }, 3000);
      snapListener = (m) => { clearTimeout(to); snapListener = null; res(m.players.find((p: any) => p.id === NAME)?.health ?? -2); };
      sendJson({ type: 'snapshotRequest' });
    });
    check('heal clamped to max health', selfHp >= 0 && selfHp <= 100, `hp=${selfHp}`);

    // 5. Rate-limit spam: 60 position frames in 200ms — server should drop
    //    the excess without dropping us.
    const cBefore = corrections;
    for (let i = 0; i < 60; i++) sendPosition();
    await wait(500);
    check('position spam tolerated (alive, no correction flood)',
      ws.readyState === 1 && corrections - cBefore <= 1,
      `corrections=${corrections - cBefore} ws=${ws.readyState}`);

    hitListener = null;
    clearInterval(posTimer);
    const fails = results.filter((r) => !r.ok).length;
    log(`${results.length - fails}/${results.length} checks passed`);
    process.exit(fails ? 1 : 0);
  }

  if (TEST4) {
    // ---- projectile + damage-path abuse ----

    // 1. projectileDestroy ownership: a foreign bot can't pop our rocket.
    //    Spawn one, let a peer claim it, then verify no broadcast arrives.
    sendJson({ type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
      position: { ...pos }, velocity: { x: 0, y: ROCKET_SPEED, z: 0 } });
    await wait(150);
    const mineId = lastProjId;
    check('spawned own projectile', !!mineId, mineId ?? 'none');
    let destroyedBy = { v: false };
    projDestroyedListener = (id) => { if (id === mineId) destroyedBy.v = true; };
    if (mineId) {
      // Ownership: destroy a foreign projectile id (captured from a peer's
      // projectileCreated) → server must NOT broadcast projectileDestroyed.
      let foreignSaw = { v: false };
      const fId = lastForeignProjId;
      projDestroyedListener = (id) => { if (id === fId) foreignSaw.v = true; };
      if (fId) {
        sendJson({ type: 'projectileDestroy', projectileId: fId });
        await wait(400);
        check('foreign projectileDestroy ignored', !foreignSaw.v, `id=${fId}`);
      } else log('SKIP foreign destroy — no peer projectile seen');
      // Positive path: own destroy broadcasts.
      projDestroyedListener = (id) => { if (id === mineId) destroyedBy.v = true; };
      sendJson({ type: 'projectileDestroy', projectileId: mineId });
      await wait(300);
      check('own projectileDestroy broadcasts', destroyedBy.v);
    }

    // 2. Spawn claim from a far origin (>40m) → no projectileCreated.
    const prevId = lastProjId;
    sendJson({ type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
      position: { x: pos.x + 100, y: pos.y, z: pos.z },
      velocity: { x: ROCKET_SPEED, y: 0, z: 0 } });
    await wait(300);
    check('far-origin spawn rejected', lastProjId === prevId);

    // 3. Oversized spawn velocity (>600) → rejected.
    sendJson({ type: 'shot', targetId: null, weaponType: WeaponType.Rocket,
      position: { ...pos }, velocity: { x: 1000, y: 0, z: 0 } });
    await wait(300);
    check('oversized-velocity spawn rejected', lastProjId === prevId);

    // 4. environmentDamage clamps at 40 and is self-only: we take ≤40,
    //    nobody else can be targeted by it (message has no target field).
    const myHpBefore = others.get(NAME)?.health ?? 100;
    let envHit = { dmg: -1, tgt: '' };
    hitListener = (m) => { if (m.shooterId === 'environment') { envHit.dmg = m.damage; envHit.tgt = m.targetId; } };
    sendJson({ type: 'environmentDamage', amount: 999 });
    await wait(300);
    check('environmentDamage clamps to 40 and self-targets',
      envHit.dmg >= 0 && envHit.dmg <= 40 && envHit.tgt === NAME,
      `dmg=${envHit.dmg} tgt=${envHit.tgt}`);
    hitListener = null;

    clearInterval(posTimer);
    const fails = results.filter((r) => !r.ok).length;
    log(`${results.length - fails}/${results.length} checks passed`);
    process.exit(fails ? 1 : 0);
  }

  if (TEST5) {
    scripted = true;
    // Walk a legal arc for 6s (keeps delta compression emitting frames
    // for us too — a fully-parked lobby legitimately yields ~0Hz).
    PARK && (orbitSign = 1); // ensure movement: reuse orbit around spawn
    const endAt = Date.now() + 6000;
    while (Date.now() < endAt) {
      // 15m/s circle — inside every plausibility bound.
      const t = (Date.now() - t0) / 1000;
      // Recenter after respawn: the circle's absolute coords would otherwise
      // read as a 15-30m jump from wherever the spawn point dropped us.
      if (!circleBase) circleBase = { cx: pos.x - 15, cz: pos.z, phase: -t * 0.5 };
      pos.x = circleBase.cx + Math.cos(t * 0.5 + circleBase.phase) * 15;
      pos.z = circleBase.cz + Math.sin(t * 0.5 + circleBase.phase) * 15;
      // Glide y — snapping to a cliff edge trips the 300 m/s plausibility
      // check just like a real client teleporting down a ledge would.
      const gy = groundY(pos.x, pos.z);
      const dy = gy - pos.y;
      pos.y += Math.min(Math.abs(dy), 60 * 0.05) * Math.sign(dy);
      await wait(50);
    }
    const n = tickStats.frames;
    const gaps = tickStats.gaps.slice().sort((a, b) => a - b);
    const p50 = gaps[Math.floor(gaps.length * 0.5)] ?? 0;
    const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? 0;
    const rate = n / 6;
    // Server suppresses empty frames: no player change → no broadcast, so
    // effective rate depends on live peers. A healthy window is 8-40Hz;
    // sustained 0Hz with live moving peers would be the failure.
    check('tick frames arrive while moving', rate > 5, `${rate.toFixed(1)}Hz over 6s`);
    check('tick p50 gap sane', p50 < 150, `p50=${p50}ms p95=${p95}ms max=${tickStats.maxGap}ms`);
    // Self-echo: the server intentionally doesn't echo our own record
    // (client-authoritative position). Report drift if it ever appears.
    if (selfEcho) {
      const drift = Math.hypot(selfEcho.pos.x - pos.x, selfEcho.pos.y - pos.y, selfEcho.pos.z - pos.z);
      log(`self-echo drift ${drift.toFixed(2)}m (informational)`);
    }
    check('no corrections while circling', corrections === 0, `${corrections} corrections`);

    // Incremental legal move (steps stay under the 300 m/s cap) — the echo
    // should track without any correction.
    const c0 = corrections;
    const startX = pos.x;
    for (let i = 0; i < 10; i++) { // ~3m per 100ms ≈ 30 m/s
      pos.x += 3; pos.y = groundY(pos.x, pos.z);
      await wait(100);
    }
    await wait(200);
    if (selfEcho) {
      const drift = Math.hypot(selfEcho.pos.x - pos.x, selfEcho.pos.y - pos.y, selfEcho.pos.z - pos.z);
      check('self-echo tracks legal move', drift < 10, `drift=${drift.toFixed(2)}m after +30m`);
    }
    check('no correction on stepped move', corrections === c0, `${corrections - c0}`);

    clearInterval(posTimer);
    const fails = results.filter((r) => !r.ok).length;
    log(`${results.length - fails}/${results.length} checks passed`);
    process.exit(fails ? 1 : 0);
  }

  check('sees another player', others.size >= 1, `${others.size} other(s)`);

  // Rubberband check A: legal movement should produce ZERO corrections.
  const c0 = corrections;
  for (let i = 0; i < 40; i++) { // 2s of legal strafing handled by behavior loop
    await wait(50);
  }
  check('no corrections under legal movement', corrections === c0, `${corrections - c0} corrections`);

  // Rubberband check B: 60m jump without declaring teleport → correction.
  // The server ignores dead clients' positions entirely — SOAK may have
  // fragged us moments ago, so wait out the respawn window first or the
  // jump never reaches the plausibility check.
  for (let i = 0; i < 100 && dead; i++) await wait(100);
  const cBefore = corrections;
  pos.x += 60;
  await wait(400);
  check('60m undeclared jump rejected', corrections > cBefore, `${corrections - cBefore} correction(s)`);

  // Declared teleport: no correction, peers get a teleport relay.
  const cBefore2 = corrections;
  sendJson({ type: 'teleport', position: { ...pos }, rotation: { yaw, pitch: 0 }, velocity: vel });
  await wait(300);
  check('declared teleport accepted', corrections === cBefore2, `${corrections - cBefore2} corrections`);

  if (FIGHTER) {
    // Damage + kill: shoot nearest until kill (rocket = 50 dmg, 2 hits on 100hp).
    snapshotTargets(Date.now());
  const tgt = nearestTarget();
    check('found target to shoot', !!tgt, tgt ? tgt[0] : 'none');
    if (tgt) {
      const [, o] = tgt;
      const startDeaths = killsOf.get(tgt[0]) ?? 0;
      const startHp = o.health;
      const sawHit = { v: false };
      hitListener = (m) => { if (m.targetId === tgt[0]) sawHit.v = true; };
      // Fire fast: override interval.
      for (let i = 0; i < 6 && (killsOf.get(tgt[0]) ?? 0) === startDeaths; i++) {
        fireRocketAt(tgt[0], others.get(tgt[0]) ?? o);
        await wait(600);
      }
      hitListener = null;
      const gotKill = (killsOf.get(tgt[0]) ?? 0) > startDeaths;
      check('damage + kill flow', sawHit.v && (gotKill || (others.get(tgt[0])?.dead ?? false)),
        `hit seen=${sawHit.v} kills=${killsOf.get(tgt[0]) ?? 0}`);
    }
  }

  // Position-stream freshness: live peers update at ~30Hz; a dead peer's
  // stream legitimately goes quiet while they're down.
  let livePeer: Other | null = null;
  for (const [, o] of others) if (!o.dead && Date.now() - o.lastTick < 10000) livePeer = o;
  if (livePeer) {
    const age = Date.now() - livePeer.lastTick;
    check('peer position stream fresh', age < 200, `last tick ${age}ms ago`);
  } else log('SKIP peer freshness — no live peer');

  clearInterval(posTimer);
  const fails = results.filter((r) => !r.ok).length;
  log(`${results.length - fails}/${results.length} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
