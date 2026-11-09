// Plain-node TLS repro: wss://…:8502 self-respawn, assert playerRespawn.
// Inlines the wire decode (WIRE_JSON 0x09 / WIRE_BATCH 0x0D) so node needs
// no TS loader. Usage: node _tlskill.mjs wss://localhost:8502/ws
import WebSocket from '../node_modules/ws/index.js';

const WS_URL = process.argv[2] ?? 'wss://localhost:8502/ws';
const PID = `tlskill-${Date.now() % 100000}`;
const DEC = new TextDecoder();

function* subframes(u8) {
  if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
    let o = 2;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (o + 2 <= u8.length) {
      const n = dv.getUint16(o, true); o += 2;
      if (o + n > u8.length) return;
      yield u8.subarray(o, o + n); o += n;
    }
    return;
  }
  yield u8;
}
function* msgs(d) {
  if (typeof d === 'string') {try {yield JSON.parse(d);} catch {} return;}
  const u8 = d instanceof ArrayBuffer ? new Uint8Array(d)
    : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
  if (!u8) return;
  for (const f of subframes(u8)) {
    if (f.length < 3 || f[0] !== 0x54 || f[1] !== 0x09) continue;
    try {yield JSON.parse(DEC.decode(f.subarray(2)));} catch {}
  }
}

let myKill = false, myRespawn = null, sawAnyRespawn = 0;
const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
ws.on('message', (d, isBinary) => {
  // ws delivers TEXT frames as Buffer too — isBinary is the only truth.
  if (!isBinary) {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'playerKill' && m.targetId === PID) myKill = true;
      if (m.type === 'playerRespawn') {sawAnyRespawn++; if (m.playerId === PID) {myRespawn = m; console.log('RESPAWN-EVT', JSON.stringify(m).slice(0, 160));}}
    } catch {}
    return;
  }
  for (const m of msgs(d)) {
    if (m.type === 'playerKill' && m.targetId === PID) myKill = true;
    if (m.type === 'playerRespawn') {sawAnyRespawn++; if (m.playerId === PID) {myRespawn = m; console.log('RESPAWN-EVT', JSON.stringify(m).slice(0, 160));}}
  }
});
await new Promise((res, rej) => {ws.on('open', res); ws.on('error', rej);});
ws.send(JSON.stringify({ type: 'join', playerId: PID, room: process.argv[3] ?? 'tlskill', transport: 'ws', armorClass: 'light', perk: 'none' }));
await new Promise(r => setTimeout(r, 2500));
ws.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 4000));
console.log('kill+respawn claim as', PID);
ws.send(JSON.stringify({ type: 'respawn' }));
await new Promise(r => setTimeout(r, 20000));
console.log(`kill=${myKill} myRespawn=${myRespawn ? 'YES' : 'NO'} anyRespawn=${sawAnyRespawn}`);
ws.close();
process.exit(myKill && myRespawn ? 0 : 1);
