// Control probe: does self-kill -> respawn work on a FRESH prod join?
// Isolates the classclaim leg-A2 failure from the reclaim path.
import { openSocket } from './net.ts';
import { decodeWireJson, iterBatch } from '../../shared/wire.ts';

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const PID = `selfkill-${Date.now() % 100000}`;

type Sock = { send: (d: string) => void; close: () => void; onmessage: any; onclose: any };

function msgsOf(ev: any): any[] {
  let u8: Uint8Array | null = null;
  const d = ev?.data ?? ev;
  if (typeof d === 'string') {
    try {return [JSON.parse(d)];} catch {return [];}
  }
  if (d instanceof ArrayBuffer) {u8 = new Uint8Array(d);}
  else if (ArrayBuffer.isView(d)) {u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);}
  if (u8 === null) {return [];}
  const out: any[] = [];
  const pushJson = (frame: Uint8Array): void => {
    const j = decodeWireJson(frame);
    if (j === null) {return;}
    try {out.push(JSON.parse(j));} catch { /* not json */ }
  };
  if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
    for (const f of iterBatch(u8)) {pushJson(f);}
  } else {pushJson(u8);}
  return out;
}

const seen: Record<string, number> = {};
let myKill = false, myRespawn: any = null;
const sock: Sock = await new Promise((res, rej) => {
  openSocket(WS_URL, 'ws').then((s: any) => {
    s.onmessage = (ev: any) => {
      const raw = ev?.data ?? ev;
      if (typeof raw === 'string' && /respawn/i.test(raw)) {console.log('RAW-RESPAWN', raw.slice(0, 300));}
      for (const m of msgsOf(ev)) {
        seen[m.type] = (seen[m.type] ?? 0) + 1;
        if (m.type === 'playerKill' && m.targetId === PID) {myKill = true; console.log('MY KILL', JSON.stringify(m));}
        if (m.type === 'playerRespawn') {console.log('RESPAWN-EVT', JSON.stringify(m)); if (m.playerId === PID) {myRespawn = m;}}
        if (JSON.stringify(m).includes('espawn')) {console.log('ESP?', JSON.stringify(m).slice(0, 300));}
        if (m.type === 'yourHealth') {console.log('HEALTH', JSON.stringify(m));}
        if (m.type === 'matchNotice') {console.log('NOTICE', JSON.stringify(m));}
      }
    };
    s.onclose = () => rej(new Error('closed'));
    res(s);
  }).catch(rej);
});

sock.send(JSON.stringify({ type: 'join', playerId: PID, room: 'selfkill', transport: 'ws', armorClass: 'light', perk: 'none' }));
await new Promise(r => setTimeout(r, 2500));
sock.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 4000)); // let spawn shield expire
console.log('sending respawn self-kill');
sock.send(JSON.stringify({ type: 'respawn' }));
await new Promise(r => setTimeout(r, 20000));
console.log(`kill=${myKill} respawn=${JSON.stringify(myRespawn)} types=${JSON.stringify(seen)}`);
sock.close();
process.exit(myKill && myRespawn ? 0 : 1);
