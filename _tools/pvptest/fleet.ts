/**
 * Stress fleet — N networked bots in ONE process (per-process bots hit the
 * OS process cap ~80). Each bot is a real WS client: join handshake,
 * 20Hz binary position frames, JSON event handling, orbit movement.
 *
 * Usage: bun fleet.ts <wsUrl> <roomPrefix> <rooms> <botsPerRoom> [seconds] [--tier=ws|rtc|wt]
 *   bun fleet.ts ws://localhost:8062/ws stress 10 10 90
 *   bun fleet.ts ws://localhost:8062/ws mix 1 6 30 --tier=rtc
 * --tier exercises the UDP transports end-to-end (net.ts adapters); the
 * join reports the tier so /metrics tiers{} reflects the fleet.
 */

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const PREFIX = process.argv[3] ?? 'stress';
const ROOMS = parseInt(process.argv[4] ?? '10');
const PER_ROOM = parseInt(process.argv[5] ?? '10');
const SECONDS = parseInt(process.argv[6] ?? '60');
const TIER = (process.argv.find(a => a.startsWith('--tier='))?.slice(7) ?? 'ws') as Tier;

import { encodePosition, decodeTickFrame, isWireFrame, WIRE_TICK } from '../../shared/wire.ts';
import { openSocket, type BotSocket, type Tier } from './net.ts';
import { getWeaponStats } from '../../shared/weapons';
import { MoveSim } from '../../shared/movement.ts';
import { hmHeight, hmNormal, type Heightfield } from '../../shared/heightfield.ts';
import { readFileSync } from 'fs';

// Honest movement: each bot runs the shared MoveSim against the SAME
// heightfield the server sweeps — reports are true prediction, so a
// clean run shows zero divergence/rejects. FLEET_SPOOF=1 restores the
// old position-spoofing orbit (deliberately illegal — for testing the
// anti-cheat path itself).
const SPOOF = process.env.FLEET_SPOOF === '1';

function parseHm(buf: Uint8Array): Heightfield {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = view.getUint32(0, true);
  return { size: w, data: buf.subarray(8), stride: 1 };
}
const hmPath = new URL('../../server_bun/heightmap.bin', import.meta.url).pathname;
const DEFAULT_FIELD: Heightfield = parseHm(new Uint8Array(readFileSync(hmPath.replace(/^\/([A-Za-z]:)/, '$1'))));
const fieldCache = new Map<string, Promise<Heightfield>>();
function fieldFor(terrain?: string): Promise<Heightfield> {
  if (!terrain) return Promise.resolve(DEFAULT_FIELD);
  let p = fieldCache.get(terrain);
  if (!p) {
    const http = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
    p = fetch(`${http}/maps/${terrain}`).then((r) => r.arrayBuffer()).then((ab) => parseHm(new Uint8Array(ab)));
    fieldCache.set(terrain, p);
  }
  return p;
}
const surfaceOf = (f: Heightfield) => ({
  getHeight: (x: number, z: number) => hmHeight(f, x, z),
  getNormal: (x: number, z: number, out: { x: number; y: number; z: number }) => { hmNormal(f, x, z, out); return out; },
});

interface Bot {
  name: string;
  room: string;
  ws: BotSocket;
  joined: boolean;
  angle: number;
  cx: number; cz: number; // orbit center
  tickFrames: number;
  sends: number;
  seq: number;
  sim?: MoveSim;
  /** Leftover time budget carried into the next send tick for fixed-rate sim substeps. */
  acc: number;
  yaw: number;
  /** Honest combat: remotes seen on tick frames + one in-flight slug. */
  remotes: Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; dead: boolean }>;
  team?: string;
  pending: { id?: string; targetId: string; firedAt: number; flyS: number;
    muzzle: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number } } | null;
  fireAt: number;
  rejects: number;
  kills: number;
  corrections: number;
  /** Largest pre-snap gap a correction was asked to fix — a measure of
   *  how far the two sims had drifted when the server stepped in. */
  maxCorrectionGap: number;
  /** Next plant time + cycling kind — exercises the deploy claim path. */
  deployAt: number;
  deployKind: number;
  deploys: number;
  /** Journaled inputs not yet acked by the server — replayed over a
   *  correction snap exactly like the real client's input journal. */
  journal: { seq: number; yaw: number }[];
}

const bots: Bot[] = [];
let joins = 0, joinFails = 0, totalTickFrames = 0, totalSends = 0;
let deploySpawns = 0, deployGones = 0, turretShots = 0, mineBooms = 0;

async function spawnBot(room: string, name: string): Promise<void> {
  const bot: Bot = {
    name, room, ws: null as unknown as BotSocket, joined: false,
    angle: Math.random() * Math.PI * 2,
    cx: (Math.random() - 0.5) * 200,
    cz: (Math.random() - 0.5) * 200,
    tickFrames: 0, sends: 0, seq: 0,
    yaw: Math.random() * Math.PI * 2,
    remotes: new Map(), pending: null, fireAt: 0, rejects: 0, kills: 0,
    corrections: 0, maxCorrectionGap: 0, journal: [],
    deployAt: Date.now() + 3000 + Math.random() * 4000, deployKind: 0, deploys: 0,
  };
  bots.push(bot);
  try {
    const ws = await openSocket(WS_URL, TIER);
    bot.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const m = JSON.parse(ev.data);
        if (m.type === 'projectileCreated' && m.ownerId === name && bot.pending && !bot.pending.id) {
          bot.pending.id = m.projectileId;
        } else if (m.type === 'shotRejected') {
          bot.rejects++;
          if (bot.rejects <= 5) console.log(`  ${name} shotRejected: ${m.reason}`);
          if (bot.pending?.id) bot.pending = null;
        } else if (m.type === 'deploySpawn') {
          deploySpawns++;
        } else if (m.type === 'deployGone') {
          deployGones++;
        } else if (m.type === 'turretShot') {
          turretShots++;
        } else if (m.type === 'mineBoom') {
          mineBooms++;
        } else if (m.type === 'playerLeft') {
          // Stale roster entries read as 'unknown target' rejects — a bot
          // that never forgets departed players keeps shooting ghosts.
          bot.remotes.delete(m.playerId);
        } else if (m.type === 'playerKill') {
          const v = bot.remotes.get(m.targetId);
          if (v) v.dead = true;
          if (m.shooterId === name) {
            bot.kills++;
            bot.pending = null;
          }
        } else if (m.type === 'gameState') {
          bot.joined = true; joins++;
          bot.team = m.team;
          // Seed the local sim at the spawn the server assigned —
          // reports are only honest if we start where the server put us.
          const lp = m.localPlayerState;
          if (lp?.position) {
            void fieldFor(m.map?.terrain).then((f) => {
              bot.sim = new MoveSim(surfaceOf(f), {
                pos: { ...lp.position }, vel: { ...(lp.velocity ?? { x: 0, y: 0, z: 0 }) },
                yaw: lp.rotation?.yaw ?? 0, pitch: 0, onGround: true,
              });
            });
          }
        } else if (m.type === 'correction' && bot.sim) {
          // A correction is the server's truth — snap the sim to it
          // exactly like the client does, or divergence compounds.
          bot.corrections++;
          const before = Math.hypot(
            m.position.x - bot.sim.state.pos.x,
            m.position.y - bot.sim.state.pos.y,
            m.position.z - bot.sim.state.pos.z);
          bot.sim.setState({
            pos: { ...m.position }, vel: { ...(m.velocity ?? { x: 0, y: 0, z: 0 }) },
            yaw: m.rotation?.yaw ?? bot.yaw, pitch: 0, onGround: m.grounded ?? true,
          });
          // Replay the journaled inputs the server hadn't consumed — the
          // blind snap would otherwise shed in-flight input and the sims
          // sit at a permanent ~RTT lag, re-triggering corrections.
          bot.journal = bot.journal.filter(j => j.seq > (m.inputSeq ?? -1));
          for (const j of bot.journal) {
            bot.yaw = j.yaw;
            bot.sim.state.yaw = j.yaw;
            bot.sim.setInput({ forward: 1, right: 0, jumpHeld: false, skiHeld: true, jetHeld: false });
            bot.sim.update(1 / 30);
          }
          // The correction should bring the client sim into near-agreement
          // with the server — a residual still >2m means the two sims
          // disagree structurally, not just on timing.
          bot.maxCorrectionGap = Math.max(bot.maxCorrectionGap, before);
        } else if (m.type === 'playerRespawn') {
          const v = bot.remotes.get(m.playerId);
          if (v) v.dead = false;
          if (m.playerId === name && bot.sim) {
            // Own respawn — reseat the sim at the spawn point exactly like the
            // client's syncMovement, or the corpse-to-spawn jump reads as a
            // (legit, once-per-life) divergence spike.
            bot.sim.setState({
              pos: { ...m.position }, vel: { x: 0, y: 0, z: 0 },
              yaw: m.rotation?.yaw ?? bot.yaw, pitch: 0, onGround: true,
            });
          }
        } else if (m.type === 'knockback' && bot.sim && m.targetId === name) {
          // Server shoved us — apply the same impulse the real client would,
          // or the judge sees the un-eaten impulse as divergence.
          const s = bot.sim.state;
          const dx = s.pos.x - m.position.x, dz = s.pos.z - m.position.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          const sgn = m.pull ? -1 : 1;
          s.vel.x += sgn * (dx / dist) * m.force;
          s.vel.y += (m.pull ? 0.3 : 0.5) * m.force;
          s.vel.z += sgn * (dz / dist) * m.force;
        }
      } else {
        const u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
        if (isWireFrame(u8) && u8[1] === WIRE_TICK) {
          bot.tickFrames++;
          const f = decodeTickFrame(u8);
          if (f) {
            totalTickFrames++;
            for (const p of f.updates) {
              if (p.playerId === name) continue;
              bot.remotes.set(p.playerId, {
                x: p.position.x, y: p.position.y, z: p.position.z,
                vx: p.velocity.x, vy: p.velocity.y, vz: p.velocity.z,
                dead: p.isDead,
              });
            }
          }
        }
      }
    };
    ws.onerror = () => { if (!bot.joined) joinFails++; };
    ws.onclose = () => { if (!bot.joined) joinFails++; };
    // FLEET_SBOTS=N requests N server-side bots in the room (join.bots).
    const sbots = parseInt(process.env.FLEET_SBOTS ?? '0') || undefined;
    const map = process.env.FLEET_MAP || undefined;
    ws.send(JSON.stringify({ type: 'join', playerId: name, room, transport: TIER, bots: sbots, map }));
  } catch {
    joinFails++;
  }
}

// Stagger joins — 100 simultaneous handshakes would test connection
// burst, not steady-state load.
for (let r = 0; r < ROOMS; r++) {
  for (let p = 0; p < PER_ROOM; p++) {
    const name = `${PREFIX}${r}-${p}`;
    setTimeout(() => spawnBot(`${PREFIX}-${r}`, name), (r * PER_ROOM + p) * 40);
  }
}

// Movement: honest bots drive their sim with ski+forward in a gentle
// carve; spoof bots teleport-orbit at fixed altitude (old behavior).
const moveTimer = setInterval(() => {
  // Send at the server's 30Hz cadence: at 20Hz an input sits ~50ms in the
  // pipe before the shadow sees it, which alone is ~10m at ski speeds.
  const dt = 1 / 30;
  for (const b of bots) {
    if (!b.joined || !b.ws || b.ws.readyState !== 1) continue;
    // Honest bots hold all sends until the sim is seeded — the frames
    // between gameState and the async field load would otherwise leave
    // as orbit spoofs and get rejected as teleports.
    if (!SPOOF && !b.sim) continue;
    if (!SPOOF && b.sim) {
      // Step at exactly the server's 1/30 rate with an accumulator: any
      // other granularity integrates ski/ground contact differently than
      // the 30Hz shadow and drifts ~8-10m — right at the tolerance edge.
      b.acc = (b.acc ?? 0) + dt;
      while (b.acc >= 1 / 30) {
        b.acc -= 1 / 30;
        b.yaw += (1 / 30) * 0.35; // gentle arc — a Tribes-ish carve
        b.sim.setInput({ forward: 1, right: 0, jumpHeld: false, skiHeld: true, jetHeld: false });
        b.sim.update(1 / 30);
      }
      b.ws.send(JSON.stringify({
        type: 'inputMove', seq: ++b.seq,
        input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 0 },
        rotation: { yaw: b.yaw, pitch: 0 },
      }));
      b.journal.push({ seq: b.seq, yaw: b.yaw });
      if (b.journal.length > 60) b.journal.splice(0, b.journal.length - 60);
      const s = b.sim.state;
      (b.ws.sendUnreliable ?? b.ws.send).call(b.ws, encodePosition(
        s.pos, { yaw: b.yaw, pitch: 0 }, s.vel, b.seq, 0, b.seq,
      ));
    } else {
      b.angle += dt * 1.2;
      const x = b.cx + Math.cos(b.angle) * 15;
      const z = b.cz + Math.sin(b.angle) * 15;
      const vx = -Math.sin(b.angle) * 15 * 1.2;
      const vz = Math.cos(b.angle) * 15 * 1.2;
      // Position frames ride the unreliable lane when the tier has one.
      (b.ws.sendUnreliable ?? b.ws.send).call(b.ws, encodePosition(
        { x, y: 30, z },
        { yaw: b.angle, pitch: 0 },
        { x: vx, y: 0, z: vz },
        ++b.seq, 0,
      ));
    }
    b.sends++; totalSends++;
  }
}, 33);

// Honest combat: honest bots lob real PlasmaGun bolts at the nearest
// remote seen on tick frames — spawn the projectile (miss-branch shot),
// land the hit claim after the true flight time, then destroy the shell.
// Exercises the full claim pipeline (projectileCreated → validateHitClaim
// → playerHit → kill credit) under fleet load.
const FLEE_WID = 23; // WeaponType.PlasmaGun — fat bolt forgives lead error
const fireTimer = setInterval(() => {
  const speed = getWeaponStats(FLEE_WID).speed;
  const now = Date.now();
  for (const b of bots) {
    if (!b.joined || !b.ws || b.ws.readyState !== 1 || !b.sim) continue;
    // Tick records don't carry teams — a teamed bot can't tell friend
    // from foe, so it holds fire (the friendly gate already proved itself
    // by rejecting these as 'friendly fire'). Combat testing belongs to
    // FFA rooms.
    if (b.team) continue;
    if (b.pending) {
      // Land the claim once the bolt would have arrived.
      if (b.pending.id && now - b.pending.firedAt >= b.pending.flyS * 1000) {
        // Claim where the BOLT is (muzzle + dir·speed·flyS), not where the
        // target is now — a skier can drag its live position hundreds of
        // meters off the trajectory, which reads as an impossible claim.
        const p = b.pending;
        const end = {
          x: p.muzzle.x + p.dir.x * speed * p.flyS,
          y: p.muzzle.y + p.dir.y * speed * p.flyS,
          z: p.muzzle.z + p.dir.z * speed * p.flyS,
        };
        const t = b.remotes.get(p.targetId);
        const td = t && !t.dead
          ? Math.hypot(t.x - end.x, t.y - end.y, t.z - end.z) : Infinity;
        b.ws.send(JSON.stringify({
          type: 'shot', targetId: td <= 6 ? p.targetId : null,
          projectileId: p.id,
          position: end,
          airtime: (now - p.firedAt) / 1000,
          weaponType: FLEE_WID,
        }));
        b.ws.send(JSON.stringify({ type: 'projectileDestroy', projectileId: b.pending.id }));
        b.pending = null;
      }
      continue;
    }
    if (now < b.fireAt) continue;
    b.fireAt = now + 500 + Math.random() * 500;
    // Nearest living remote within reach; lead by one flight time.
    const s = b.sim.state;
    let best: string | null = null, bd = 140 * 140, tp: { x: number; y: number; z: number; vx: number; vy: number; vz: number } | null = null;
    for (const [id, r] of b.remotes) {
      if (r.dead) continue;
      const dx = r.x - s.pos.x, dz = r.z - s.pos.z, dy = r.y - s.pos.y;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = id; tp = r; }
    }
    if (!best || !tp) continue;
    const dist = Math.sqrt(bd);
    const flyS = dist / speed;
    const aim = { x: tp.x + tp.vx * flyS, y: tp.y + tp.vy * flyS, z: tp.z + tp.vz * flyS };
    const mx = s.pos.x, my = s.pos.y + 1.5, mz = s.pos.z;
    let dx = aim.x - mx, dy = aim.y - my, dz = aim.z - mz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    b.ws.send(JSON.stringify({
      type: 'shot', targetId: null, weaponType: FLEE_WID,
      position: { x: mx, y: my, z: mz },
      velocity: { x: dx * speed, y: dy * speed, z: dz * speed },
    }));
    b.pending = { targetId: best, firedAt: now, flyS,
      muzzle: { x: mx, y: my, z: mz }, dir: { x: dx, y: dy, z: dz } };
  }
}, 80);

// Deployables: every few seconds each honest bot plants the next kind in
// rotation a few meters ahead — exercises the deploy claim path, caps,
// TTLs, and the server-side combat sims under load.
const DEPLOY_KINDS = ['turret', 'mine', 'station', 'drone'];
const deployTimer = setInterval(() => {
  const now = Date.now();
  for (const b of bots) {
    if (!b.joined || !b.ws || b.ws.readyState !== 1 || !b.sim) continue;
    if (now < b.deployAt) continue;
    b.deployAt = now + 6000 + Math.random() * 6000;
    const s = b.sim.state;
    const pos = {
      x: s.pos.x + Math.cos(b.yaw) * 3,
      y: s.pos.y,
      z: s.pos.z + Math.sin(b.yaw) * 3,
    };
    b.ws.send(JSON.stringify({
      type: 'deploy', kind: DEPLOY_KINDS[b.deployKind++ % DEPLOY_KINDS.length],
      position: pos,
    }));
    b.deploys++;
  }
}, 250);

setTimeout(() => {
  clearInterval(moveTimer);
  clearInterval(fireTimer);
  clearInterval(deployTimer);
  const joined = bots.filter(b => b.joined).length;
  console.log(`\n=== FLEET RESULTS ===`);
  console.log(`joined: ${joined}/${bots.length}  failed: ${joinFails}`);
  console.log(`tick frames received: ${totalTickFrames}  position sends: ${totalSends}`);
  const kills = bots.reduce((n, b) => n + b.kills, 0);
  const rejects = bots.reduce((n, b) => n + b.rejects, 0);
  console.log(`combat: ${kills} kills, ${rejects} shot rejects`);
  const corr = bots.reduce((n, b) => n + b.corrections, 0);
  const worstGap = Math.max(0, ...bots.map(b => b.maxCorrectionGap));
  console.log(`corrections: ${corr} (worst pre-snap gap ${worstGap.toFixed(1)}m)`);
  const deploys = bots.reduce((n, b) => n + b.deploys, 0);
  console.log(`deployables: ${deploys} claims → ${deploySpawns} spawns, ${deployGones} gones, ${turretShots} turret shots, ${mineBooms} mine booms`);
  for (const b of bots.slice(0, 3)) {
    console.log(`  ${b.name}: ${b.tickFrames} frames, ${b.sends} sends, ${b.kills} kills, ${b.rejects} rejects, ${b.corrections} corr`);
  }
  process.exit(joined === bots.length ? 0 : 1);
}, SECONDS * 1000 + ROOMS * PER_ROOM * 40 + 2000);

console.log(`spawning ${ROOMS * PER_ROOM} bots across ${ROOMS} rooms on tier=${TIER} — ${SECONDS}s run`);
