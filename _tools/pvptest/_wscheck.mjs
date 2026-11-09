// Minimal worker check: join, report resolved room + event census.
import WebSocket from '../node_modules/ws/index.js';
const URL = process.argv[2];
const PID = `wschk-${Date.now() % 100000}`;
const counts = {};
const ws = new WebSocket(URL);
ws.on('message', (d, isBinary) => {
  const texts = [];
  if (!isBinary) texts.push(d.toString());
  else {
    const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    const DEC = new TextDecoder();
    if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let o = 2;
      while (o + 2 <= u8.length) {const n = dv.getUint16(o, true); o += 2; if (o + n > u8.length) break;
        const f = u8.subarray(o, o + n); o += n;
        if (f.length >= 3 && f[0] === 0x54 && f[1] === 0x09) texts.push(DEC.decode(f.subarray(2)));}
    } else if (u8.length >= 3 && u8[0] === 0x54 && u8[1] === 0x09) texts.push(DEC.decode(u8.subarray(2)));
  }
  for (const t of texts) {try {const m = JSON.parse(t); const k = m.type; counts[k] = (counts[k] ?? 0) + 1;
    if (k === 'gameState') console.log('gameState room=' + m.room + ' players=' + (m.players?.length ?? '?'));} catch {}}
});
ws.on('open', () => ws.send(JSON.stringify({ type: 'join', playerId: PID, room: 'wschk', transport: 'ws', armorClass: 'light', perk: 'none' })));
ws.on('error', (e) => {console.log('WS-ERR', e.message); process.exit(1);});
await new Promise(r => setTimeout(r, 12000));
console.log('counts:', JSON.stringify(counts));
ws.close(); process.exit(0);
