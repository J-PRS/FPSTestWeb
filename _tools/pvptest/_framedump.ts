// Raw-frame dump: join prod, self-respawn, log every inbound frame's
// transport shape so a missing playerRespawn names its lane.
import { openSocket } from './net.ts';
import { decodeWireJson, iterBatch } from '../../shared/wire.ts';

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const PID = `framedump-${Date.now() % 100000}`;

const KIND: Record<number, string> = { 0x09: 'WIRE_JSON', 0x0B: 'PROJSPAWN', 0x0C: 'PROJGONE', 0x0D: 'BATCH' };

function describe(u8: Uint8Array): string {
  if (u8[0] === 0x7b) {
    try {
      const m = JSON.parse(new TextDecoder().decode(u8));
      return `BAREJSON -> ${m.type}${m.playerId ? ':' + m.playerId : ''}`;
    } catch { return 'BAREJSON (bad)'; }
  }
  const k = KIND[u8[1]!] ?? `0x${u8[1]!.toString(16)}`;
  if (u8[1] === 0x09) {
    const j = decodeWireJson(u8);
    if (j) {
      try { const m = JSON.parse(j); return `${k} -> ${m.type}${m.playerId ? ':' + m.playerId : ''}`; } catch { /* fall */ }
    }
    return `${k} (undecodable)`;
  }
  return k;
}

const counts: Record<string, number> = {};
const sock: any = await new Promise((res, rej) => {
  openSocket(WS_URL, 'ws').then((s: any) => {
    s.onmessage = (ev: any) => {
      const d = ev?.data ?? ev;
      if (typeof d === 'string') {
        let t = '?';
        try { t = JSON.parse(d).type ?? '?'; } catch { /* */ }
        counts[`text:${t}`] = (counts[`text:${t}`] ?? 0) + 1;
        if (t === 'playerRespawn' || /respawn/i.test(d)) {console.log('TEXT-FRAME', d.slice(0, 200));}
        return;
      }
      let u8: Uint8Array;
      if (d instanceof ArrayBuffer) {u8 = new Uint8Array(d);}
      else if (ArrayBuffer.isView(d)) {u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);}
      else {return;}
      if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
        for (const f of iterBatch(u8)) {
          const desc = describe(f);
          counts[`bin:${desc}`] = (counts[`bin:${desc}`] ?? 0) + 1;
          if (desc.includes('playerRespawn') || desc.includes('WIRE_JSON -> playerRespawn')) {console.log('BATCH-SUB', desc);}
        }
        return;
      }
      const desc = describe(u8);
      counts[`bin:${desc}`] = (counts[`bin:${desc}`] ?? 0) + 1;
      if (desc.includes('playerRespawn')) {console.log('BIN-FRAME', desc);}
    };
    s.onclose = () => rej(new Error('closed early'));
    res(s);
  }).catch(rej);
});

sock.send(JSON.stringify({ type: 'join', playerId: PID, room: 'selfkill', transport: 'ws', armorClass: 'light', perk: 'none' }));
await new Promise(r => setTimeout(r, 2500));
sock.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 4000));
console.log('sending respawn claim as', PID);
sock.send(JSON.stringify({ type: 'respawn' }));
await new Promise(r => setTimeout(r, 25000));
console.log('COUNTS', JSON.stringify(counts, null, 0));
sock.close();
process.exit(0);
