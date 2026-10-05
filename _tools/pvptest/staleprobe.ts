// Stale-heartbeat probe: two bots join, stream 3s, then go silent for 11s.
// A watcher counts how many tick records each stale id still emits.
// Pre-fix (shared lastStaleHeartbeat): only the FIRST stale sender in map
// order ever heartbeat — one of these counts would sit at ~0.
import { decodeTickFrame, isWireFrame, WireIdRoster } from '../../shared/wire.ts';
const wireRoster = new WireIdRoster();

const SERVER = process.env.PVP_WS ?? 'ws://localhost:8000/ws';
const RUN = Math.floor(Math.random() * 900 + 100);
const NAME_A = `STALE-A${RUN}`;
const NAME_B = `STALE-B${RUN}`;
const counts: Record<string, number> = { [NAME_A]: 0, [NAME_B]: 0 };
let totalUpdates = 0;

function client(name: string): WebSocket {
  const ws = new WebSocket(SERVER);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: name }));
  ws.onclose = (e) => console.log(`${name} closed: ${e.code} ${e.reason}`);
  ws.onerror = (e) => console.log(`${name} error:`, e);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      const u8 = new Uint8Array(ev.data as ArrayBuffer);
      if (isWireFrame(u8)) {
        const t = decodeTickFrame(u8, wireRoster.pool);
        if (t) for (const u of t.updates) { totalUpdates++; if (u.playerId in counts) counts[u.playerId]++; }
      }
      return;
    }
    const m = JSON.parse(ev.data);
    wireRoster.feed(m);
    if (name.startsWith('WATCH') && m.type === 'gameState') console.log('WATCH joined, others:', m.players?.length ?? 0);
    if (m.type === 'gameState') ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
  };
  return ws;
}

const a = client(NAME_A);
const b = client(NAME_B);
const w = client(`WATCH${RUN}`);

function stream(ws: WebSocket) {
  return setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({
      type: 'position',
      position: { x: 0, y: 50, z: 0 },
      rotation: { yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      seq: 0, ping: 10,
    }));
  }, 50);
}

setTimeout(() => {}, 16000); // keep alive
setTimeout(async () => {
  await new Promise(r => setTimeout(r, 1000)); // let all three join
  const ta = stream(a), tb = stream(b);
  await new Promise(r => setTimeout(r, 3000));
  clearInterval(ta); clearInterval(tb); // go silent → stale after 5s
  console.log('after stream:', JSON.stringify(counts), 'totalUpdates:', totalUpdates);
  counts[NAME_A] = 0; counts[NAME_B] = 0;
  await new Promise(r => setTimeout(r, 11000)); // >5s stale + several 2s beats
  console.log('after stale window:', JSON.stringify(counts), 'totalUpdates:', totalUpdates);
  const ok = counts[NAME_A]! >= 2 && counts[NAME_B]! >= 2;
  console.log(ok ? 'PASS: both stale players heartbeat' : 'FAIL: a stale player was starved');
  process.exit(ok ? 0 : 1);
}, 0);
