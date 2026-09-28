/**
 * Stress fleet — N networked bots in ONE process (per-process bots hit the
 * OS process cap ~80). Each bot is a real WS client: join handshake,
 * 20Hz binary position frames, JSON event handling, orbit movement.
 *
 * Usage: bun fleet.ts <wsUrl> <roomPrefix> <rooms> <botsPerRoom> [seconds]
 *   bun fleet.ts ws://localhost:8062/ws stress 10 10 90
 */

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const PREFIX = process.argv[3] ?? 'stress';
const ROOMS = parseInt(process.argv[4] ?? '10');
const PER_ROOM = parseInt(process.argv[5] ?? '10');
const SECONDS = parseInt(process.argv[6] ?? '60');

import { encodePosition, decodeTickFrame, isWireFrame, WIRE_TICK } from '../../shared/wire.ts';

interface Bot {
  name: string;
  room: string;
  ws: WebSocket;
  joined: boolean;
  angle: number;
  cx: number; cz: number; // orbit center
  tickFrames: number;
  sends: number;
  seq: number;
}

const bots: Bot[] = [];
let joins = 0, joinFails = 0, totalTickFrames = 0, totalSends = 0;

function spawnBot(room: string, name: string): void {
  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';
  const bot: Bot = {
    name, room, ws, joined: false,
    angle: Math.random() * Math.PI * 2,
    cx: (Math.random() - 0.5) * 200,
    cz: (Math.random() - 0.5) * 200,
    tickFrames: 0, sends: 0, seq: 0,
  };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: name, room }));
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.type === 'gameState') { bot.joined = true; joins++; }
    } else {
      const u8 = new Uint8Array(ev.data);
      if (isWireFrame(u8) && u8[1] === WIRE_TICK) {
        bot.tickFrames++;
        const f = decodeTickFrame(u8);
        if (f) totalTickFrames++;
      }
    }
  };
  ws.onerror = () => { if (!bot.joined) joinFails++; };
  ws.onclose = () => { if (!bot.joined) joinFails++; };
  bots.push(bot);
}

// Stagger joins — 100 simultaneous handshakes would test connection
// burst, not steady-state load.
for (let r = 0; r < ROOMS; r++) {
  for (let p = 0; p < PER_ROOM; p++) {
    const name = `${PREFIX}${r}-${p}`;
    setTimeout(() => spawnBot(`${PREFIX}-${r}`, name), (r * PER_ROOM + p) * 40);
  }
}

// Movement: each bot orbits its own center at ~10m/s, 20Hz binary frames.
const moveTimer = setInterval(() => {
  const dt = 0.05;
  for (const b of bots) {
    if (!b.joined || b.ws.readyState !== 1) continue;
    b.angle += dt * 1.2;
    const x = b.cx + Math.cos(b.angle) * 15;
    const z = b.cz + Math.sin(b.angle) * 15;
    const vx = -Math.sin(b.angle) * 15 * 1.2;
    const vz = Math.cos(b.angle) * 15 * 1.2;
    b.ws.send(encodePosition(
      { x, y: 30, z },
      { yaw: b.angle, pitch: 0 },
      { x: vx, y: 0, z: vz },
      ++b.seq, 0,
    ));
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

console.log(`spawning ${ROOMS * PER_ROOM} bots across ${ROOMS} rooms — ${SECONDS}s run`);
