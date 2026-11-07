// Cross-listener fanout probe: two clients in the SAME room on the SAME
// worker but DIFFERENT Bun.serve listeners (direct-TLS :8443 vs Caddy
// plaintext /w0). uWS publish is per-server — pre-publishFns the TLS
// socket's pubbed broadcasts went only to the plaintext server (or vice
// versa). Chat from A must reach B across the listener boundary.
// Usage: node _xlistener.mjs
import WebSocket from '../node_modules/ws/index.js';

const A_URL = 'wss://play.jprice.app:8443/ws';   // worker :8001 TLS listener
const B_URL = 'wss://play.jprice.app/w0/ws';      // worker :8001 plaintext via Caddy
const ROOM = 'xlistener';
const PID_A = `xl-a-${Date.now() % 100000}`;
const PID_B = `xl-b-${Date.now() % 100000}`;
const TEXT = `xl-${Math.random().toString(36).slice(2, 8)}`;

function mk(url, pid) {
  const ws = new WebSocket(url);
  const st = { ws, room: null, got: [], dead: false };
  ws.on('message', (d, isBinary) => {
    const texts = [];
    if (!isBinary) {texts.push(d.toString());}
    else {
      const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      // unwrap WIRE_BATCH / WIRE_JSON subframes
      const frames = [];
      if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let o = 2;
        while (o + 2 <= u8.length) {const n = dv.getUint16(o, true); o += 2; if (o + n > u8.length) break; frames.push(u8.subarray(o, o + n)); o += n;}
      } else {frames.push(u8);}
      const DEC = new TextDecoder();
      for (const f of frames) {
        if (f.length >= 3 && f[0] === 0x54 && f[1] === 0x09) {texts.push(DEC.decode(f.subarray(2)));}
      }
    }
    for (const t of texts) {
      try {
        const m = JSON.parse(t);
        st.got.push(m.type);
        if (m.type === 'gameState' && m.room && !st.room) {st.room = m.room;}
        if (m.type === 'chat' && m.text === TEXT) {st.chatFrom = m.playerId;}
        if (m.type === 'playerRespawn') {st.respawns = (st.respawns ?? 0) + 1;}
      } catch {}
    }
  });
  return st;
}

const open = (st) => new Promise((res, rej) => {st.ws.on('open', res); st.ws.on('error', rej);});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const a = mk(A_URL, PID_A), b = mk(B_URL, PID_B);
await Promise.all([open(a), open(b)]);
a.ws.send(JSON.stringify({ type: 'join', playerId: PID_A, room: ROOM, transport: 'ws', armorClass: 'light', perk: 'none' }));
await sleep(3000);
// B joins the room A actually landed in (resolved identity, like a /s/ client)
const roomB = a.room ?? ROOM;
b.ws.send(JSON.stringify({ type: 'join', playerId: PID_B, room: roomB, transport: 'ws', armorClass: 'light', perk: 'none' }));
await sleep(3000);
a.ws.send(JSON.stringify({ type: 'ready' }));
b.ws.send(JSON.stringify({ type: 'ready' }));
await sleep(2000);

console.log(`A(${A_URL}) room=${a.room}  B(${B_URL}) room=${b.room}`);
if (a.room !== b.room) {console.log('NOTE: different rooms - fanout N/A');}

// 1) chat A -> B across listeners
a.ws.send(JSON.stringify({ type: 'chat', text: TEXT }));
await sleep(3000);
console.log(`chat A->B: ${b.chatFrom === PID_A ? 'PASS' : 'FAIL'} (b.chatFrom=${b.chatFrom})`);

// 2) B self-kills; A must see B's playerKill + playerRespawn across listeners
b.ws.send(JSON.stringify({ type: 'respawn' }));
await sleep(6000);
const bKill = a.got.includes('playerKill'), bResp = (a.got.filter(t => t === 'playerRespawn').length);
console.log(`B kill/respawn seen by A: kill=${bKill} respawnFrames=${bResp} (any playerRespawn counts - room has bots)`);

// 3) reciprocal: A chats, already proven direction; also B->A chat
a.chatFrom = undefined;
const TEXT2 = TEXT + '-back';
b.ws.send(JSON.stringify({ type: 'chat', text: TEXT2 }));
await sleep(3000);
// A's listener records chat in got[] but chatFrom only tracks TEXT; recount via raw? just check got has chat
console.log(`B->A chat frames on A: chat count=${a.got.filter(t => t === 'chat').length}`);

const pass = b.chatFrom === PID_A;
a.ws.close(); b.ws.close();
process.exit(pass ? 0 : 1);
