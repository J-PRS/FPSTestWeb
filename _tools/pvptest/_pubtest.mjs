// Two-listener pub test: plain :8500 + TLS :8502 into the same room.
// Plain sends chat (async broadcast); TLS must receive it via publish.
import WebSocket from '../node_modules/ws/index.js';

const PLAIN = 'ws://127.0.0.1:8500/ws';
const TLS = 'wss://localhost:8502/ws';
const ROOM = 'pubtest';
const DEC = new TextDecoder();

function* subframes(u8) {
  if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
    let o = 2; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (o + 2 <= u8.length) { const n = dv.getUint16(o, true); o += 2; if (o + n > u8.length) return; yield u8.subarray(o, o + n); o += n; }
    return;
  }
  yield u8;
}
function* msgs(d) {
  if (typeof d === 'string') { try { yield JSON.parse(d); } catch {} return; }
  const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
  if (!u8) return;
  for (const f of subframes(u8)) { if (f.length < 3 || f[0] !== 0x54 || f[1] !== 0x09) continue; try { yield JSON.parse(DEC.decode(f.subarray(2))); } catch {} }
}

function connect(url, pid, tls) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, tls ? { rejectUnauthorized: false } : {});
    const seen = [];
    ws.on('message', (d) => { for (const m of msgs(d)) { seen.push(m.type + (m.text ? ':' + String(m.text).slice(0, 30) : '')); if (m.type === 'chat') console.log(`  [${pid}] CHAT:`, JSON.stringify(m).slice(0, 140)); } });
    ws.on('error', rej);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', playerId: pid, room: ROOM, transport: 'ws', armorClass: 'light', perk: 'none' }));
      res({ ws, seen });
    });
  });
}

const a = await connect(PLAIN, 'pubplain-1', false);
await new Promise(r => setTimeout(r, 1500));
const b = await connect(TLS, 'pubtls-1', true);
await new Promise(r => setTimeout(r, 2500));
a.ws.send(JSON.stringify({ type: 'ready' }));
b.ws.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 2000));
console.log('sending chat from plain');
a.ws.send(JSON.stringify({ type: 'chat', text: 'pubtest-ping' }));
await new Promise(r => setTimeout(r, 5000));
console.log('plain saw:', a.seen.filter(t => t.startsWith('chat')).length, 'tls saw:', b.seen.filter(t => t.startsWith('chat')).length);
console.log('tls total types:', b.seen.length);
a.ws.close(); b.ws.close();
process.exit(0);
