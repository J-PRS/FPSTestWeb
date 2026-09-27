// Passive wire recorder — joins a room, writes every inbound message to a
// .rec file for offline replay (netcode regression, decoder benchmarks).
// Usage: bun record.ts <outfile.rec> [seconds] [--room=NAME]
// Line format: <ms>\t<kind>\t<payload> — kind 'bin' (hex) or 'json'.
import { appendFileSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'capture.rec';
const SECS = Number(process.argv[3] ?? 30);
const ROOM = process.argv.find(a => a.startsWith('--room='))?.slice(7);
const WS_URL = process.env.PVP_WS ?? 'ws://localhost:8000/ws';
const NAME = `REC-${Math.floor(Math.random() * 1000)}`;

const ws = new WebSocket(WS_URL);
ws.binaryType = 'arraybuffer';
const t0 = Date.now();
let frames = 0, jsons = 0, bytes = 0;

ws.onopen = () => {
  writeFileSync(OUT, '');
  ws.send(JSON.stringify({ type: 'join', playerId: NAME, room: ROOM }));
};
ws.onmessage = (ev) => {
  const ms = Date.now() - t0;
  if (typeof ev.data === 'string') {
    jsons++;
    appendFileSync(OUT, `${ms}\tjson\t${ev.data}\n`);
  } else {
    const u8 = new Uint8Array(ev.data);
    frames++;
    bytes += u8.byteLength;
    appendFileSync(OUT, `${ms}\tbin\t${Buffer.from(u8).toString('hex')}\n`);
  }
};
ws.onerror = () => { console.error('ws error'); process.exit(1); };

setTimeout(() => {
  ws.close();
  console.log(`recorded ${frames} binary frames + ${jsons} json (${bytes} bytes) → ${OUT}`);
  process.exit(0);
}, SECS * 1000);
