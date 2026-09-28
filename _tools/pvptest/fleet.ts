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
  yaw: number;
}

const bots: Bot[] = [];
let joins = 0, joinFails = 0, totalTickFrames = 0, totalSends = 0;

async function spawnBot(room: string, name: string): Promise<void> {
  const bot: Bot = {
    name, room, ws: null as unknown as BotSocket, joined: false,
    angle: Math.random() * Math.PI * 2,
    cx: (Math.random() - 0.5) * 200,
    cz: (Math.random() - 0.5) * 200,
    tickFrames: 0, sends: 0, seq: 0,
    yaw: Math.random() * Math.PI * 2,
  };
  bots.push(bot);
  try {
    const ws = await openSocket(WS_URL, TIER);
    bot.ws = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const m = JSON.parse(ev.data);
        if (m.type === 'gameState') {
          bot.joined = true; joins++;
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
          bot.sim.setState({
            pos: { ...m.position }, vel: { ...(m.velocity ?? { x: 0, y: 0, z: 0 }) },
            yaw: m.rotation?.yaw ?? bot.yaw, pitch: 0, onGround: m.grounded ?? true,
          });
        }
      } else {
        const u8 = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data);
        if (isWireFrame(u8) && u8[1] === WIRE_TICK) {
          bot.tickFrames++;
          const f = decodeTickFrame(u8);
          if (f) totalTickFrames++;
        }
      }
    };
    ws.onerror = () => { if (!bot.joined) joinFails++; };
    ws.onclose = () => { if (!bot.joined) joinFails++; };
    // FLEET_SBOTS=N requests N server-side bots in the room (join.bots).
    const sbots = parseInt(process.env.FLEET_SBOTS ?? '0') || undefined;
    ws.send(JSON.stringify({ type: 'join', playerId: name, room, transport: TIER, bots: sbots }));
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
  const dt = 0.05;
  for (const b of bots) {
    if (!b.joined || !b.ws || b.ws.readyState !== 1) continue;
    if (!SPOOF && b.sim) {
      b.yaw += dt * 0.35; // gentle arc — a Tribes-ish carve
      b.sim.setInput({ forward: 1, right: 0, jumpHeld: false, skiHeld: true, jetHeld: false });
      b.sim.update(dt);
      b.ws.send(JSON.stringify({
        type: 'inputMove', seq: ++b.seq,
        input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 0 },
        rotation: { yaw: b.yaw, pitch: 0 },
      }));
      const s = b.sim.state;
      (b.ws.sendUnreliable ?? b.ws.send).call(b.ws, encodePosition(
        s.pos, { yaw: b.yaw, pitch: 0 }, s.vel, b.seq, 0,
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
}, 50);

setTimeout(() => {
  clearInterval(moveTimer);
  const joined = bots.filter(b => b.joined).length;
  console.log(`\n=== FLEET RESULTS ===`);
  console.log(`joined: ${joined}/${bots.length}  failed: ${joinFails}`);
  console.log(`tick frames received: ${totalTickFrames}  position sends: ${totalSends}`);
  for (const b of bots.slice(0, 3)) {
    console.log(`  ${b.name}: ${b.tickFrames} frames, ${b.sends} sends`);
  }
  process.exit(joined === bots.length ? 0 : 1);
}, SECONDS * 1000 + ROOMS * PER_ROOM * 40 + 2000);

console.log(`spawning ${ROOMS * PER_ROOM} bots across ${ROOMS} rooms on tier=${TIER} — ${SECONDS}s run`);
