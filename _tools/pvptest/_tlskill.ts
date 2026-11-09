// TLS-listener repro: connect wss://…:8502 (the direct-TLS Bun.serve),
// self-respawn, assert playerRespawn actually arrives. Pre-fix the
// :8443-class listener's pubbed sockets missed every async broadcast.
import WebSocket from '../../_tools/node_modules/ws/index.js';
import { decodeWireJson, iterBatch } from '../../shared/wire.ts';

const WS_URL = process.argv[2] ?? 'wss://localhost:8502/ws';
const PID = `tlskill-${Date.now() % 100000}`;

function msgsOf(d: any): any[] {
  if (typeof d === 'string') {try {return [JSON.parse(d)];} catch {return [];}}
  let u8: Uint8Array | null = null;
  if (d instanceof ArrayBuffer) {u8 = new Uint8Array(d);}
  else if (ArrayBuffer.isView(d)) {u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);}
  if (u8 === null) {return [];}
  const out: any[] = [];
  const pushJson = (f: Uint8Array): void => {
    const j = decodeWireJson(f);
    if (j === null) {return;}
    try {out.push(JSON.parse(j));} catch { /* not json */ }
  };
  if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {for (const f of iterBatch(u8)) {pushJson(f);}}
  else {pushJson(u8);}
  return out;
}

let myKill = false, myRespawn: any = null, myHealth: any = null;
const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
ws.on('message', (d: any) => {
  for (const m of msgsOf(d)) {
    if (m.type === 'playerKill' && m.targetId === PID) {myKill = true;}
    if (m.type === 'playerRespawn' && m.playerId === PID) {myRespawn = m; console.log('RESPAWN-EVT', JSON.stringify(m).slice(0, 160));}
    if (m.type === 'yourHealth' && (m.health ?? 0) > 0 && myKill) {myHealth = m;}
  }
});
await new Promise<void>((res, rej) => {ws.on('open', () => res()); ws.on('error', rej);});
ws.send(JSON.stringify({ type: 'join', playerId: PID, room: 'tlskill', transport: 'ws', armorClass: 'light', perk: 'none' }));
await new Promise(r => setTimeout(r, 2500));
ws.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 4000));
console.log('kill+respawn claim as', PID);
ws.send(JSON.stringify({ type: 'respawn' }));
await new Promise(r => setTimeout(r, 20000));
console.log(`kill=${myKill} respawn=${myRespawn ? 'YES' : 'NO'} health=${JSON.stringify(myHealth)}`);
ws.close();
process.exit(myKill && myRespawn ? 0 : 1);
