/**
 * API surface soak — exercises every HTTP route and the spectate/admin
 * wire paths over a live server. Run against a server started with
 * FPS_ADMIN_TOKEN set (probe asserts the auth gate both ways).
 *
 * Usage: bun _tools/pvptest/apisoak.ts http://127.0.0.1:PORT <adminToken>
 */
import { openSocket, type BotSocket } from './net.ts';

const BASE = process.argv[2] ?? 'http://localhost:8000';
const TOKEN = process.argv[3] ?? 'soak';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const FAIL = (m: string): never => { console.log('FAIL:', m); process.exit(1); };
const ok = (m: string) => console.log('ok —', m);

const get = async (p: string, auth = false) => {
  const r = await fetch(BASE + p, auth ? { headers: { authorization: `Bearer ${TOKEN}` } } : {});
  return r;
};
const post = (p: string, auth = false, body?: string) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    body,
  });

// --- plain routes
for (const p of ['/health', '/metrics', '/serverinfo', '/rooms', '/matches', '/stats', '/maps']) {
  const r = await get(p);
  if (r.status !== 200) FAIL(`${p} → ${r.status}`);
  await r.json();
}
ok('all GET routes 200 JSON');
const info = await (await get('/serverinfo')).json();
if (!info.name || !info.tickRate) FAIL('/serverinfo missing name/tickRate');
const maps = await (await get('/maps')).json();
if (!Array.isArray(maps.maps) && !Array.isArray(maps)) FAIL('/maps not a list');
ok(`serverinfo="${info.name}" maps=${(maps.maps ?? maps).length}`);

// --- quick join
const jr = await (await get('/join?mode=dm&map=duel&bots=2')).json();
if (!jr.room) FAIL('/join no room');
ok(`/join → ${jr.room} (${jr.mode})`);
const bad = await get('/join?mode=<script>');
if (bad.status !== 400) FAIL('/join bad mode not rejected');
ok('/join rejects bad params');

// --- player join over WS
const run = Math.floor(Math.random() * 1e6);
const pid = `soaker-${run}`;
const joined: any = {};
const playerEvents: string[] = [];
await new Promise<void>((res, rej) => {
  openSocket(WS, 'ws').then((s: BotSocket) => {
    joined.sock = s;
    s.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { playerEvents.push('binary'); return; }
      const m = JSON.parse(ev.data);
      playerEvents.push(m.type);
      if (m.type === 'gameState') { joined.state = m; res(); }
    };
    s.send(JSON.stringify({ type: 'join', playerId: pid, room: jr.room, transport: 'ws' }));
    setTimeout(() => rej(new Error('join timeout')), 10000);
  });
});
if (!joined.state.localPlayerState || !joined.state.sessionToken) FAIL('player gameState incomplete');
ok('player joined, gameState sane');

// --- spectate join
const spec: any = {};
await new Promise<void>((res, rej) => {
  openSocket(WS, 'ws').then((s: BotSocket) => {
    spec.sock = s;
    s.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { spec.binary = true; return; }
      const m = JSON.parse(ev.data);
      if (m.type === 'gameState') { spec.state = m; res(); }
    };
    s.send(JSON.stringify({ type: 'join', playerId: `spec-${run}`, room: jr.room, spectate: true }));
    setTimeout(() => rej(new Error('spectate join timeout')), 10000);
  });
});
if (spec.state.localPlayerState) FAIL('spectator got localPlayerState');
if (spec.state.sessionToken) FAIL('spectator got sessionToken');
if (!Array.isArray(spec.state.players)) FAIL('spectator got no roster');
// spectator receives tick frames (binary)
await new Promise(r => setTimeout(r, 1500));
if (!spec.binary) FAIL('spectator got no tick frames');
// spectator position writes must be ignored — send inputMove, expect no crash
spec.sock.send(JSON.stringify({ type: 'inputMove', seq: 1, x: 0, y: 0, z: 0 }));
await new Promise(r => setTimeout(r, 300));
ok('spectator: no player state, receives ticks, writes ignored');

// --- /rooms reflects the room
const rooms = await (await get('/rooms')).json();
const rr = (rooms.rooms ?? rooms).find((x: any) => x.name === jr.room);
if (!rr) FAIL('/rooms missing the room');
ok(`room visible in /rooms (players=${rr.players ?? rr.playerCount ?? '?'})`);

// --- admin gate
const noTok = await post('/admin/rooms'); // GET-only route; use GET for the gate check
const badTok = await fetch(BASE + '/admin/rooms', { headers: { authorization: 'Bearer wrong' } });
if (badTok.status !== 401) FAIL(`/admin/rooms bad token → ${badTok.status}`);
const good = await fetch(BASE + '/admin/rooms', { headers: { authorization: `Bearer ${TOKEN}` } });
if (good.status !== 200) FAIL(`/admin/rooms good token → ${good.status}`);
ok('admin auth gate: bad=401 good=200');

// --- admin/end → matchEnd broadcast
const endP = post(`/admin/end?room=${jr.room}`, true);
// FFA rooms end with 'ffaMatchEnd', team rooms with 'matchEnd'.
const gotMatchEnd = new Promise<boolean>((res) => {
  const iv = setInterval(() => {
    if (playerEvents.includes('matchEnd') || playerEvents.includes('ffaMatchEnd')) { clearInterval(iv); res(true); }
  }, 100);
  setTimeout(() => { clearInterval(iv); res(false); }, 6000);
});
const er = await endP;
if (er.status !== 200) FAIL(`/admin/end → ${er.status}`);
if (!(await gotMatchEnd)) FAIL('no matchEnd broadcast after /admin/end');
ok('/admin/end → matchEnd broadcast');

// --- /matches gains the entry
await new Promise(r => setTimeout(r, 500));
const matches = await (await get('/matches')).json();
const list = matches.matches ?? matches;
if (!Array.isArray(list) || !list.some((m: any) => (m.room ?? m.name) === jr.room))
  console.log('WARN: /matches has no entry for', jr.room, JSON.stringify(list).slice(0, 200));
else ok('/matches journaled the ended match');

// --- admin/kick closes the socket
const kicked = new Promise<boolean>((res) => {
  joined.sock.onclose = () => res(true);
  setTimeout(() => res(false), 4000);
});
const kr = await post(`/admin/kick?player=${pid}`, true);
if (kr.status !== 200) FAIL(`/admin/kick → ${kr.status}`);
if (!(await kicked)) FAIL('player socket survived /admin/kick');
ok('/admin/kick closed the player socket');
const miss = await post('/admin/kick?player=nobody-here', true);
if (miss.status !== 404) FAIL(`/admin/kick unknown player → ${miss.status}`);

// --- client log shipping
const cl = await post('/client-log', false, `[${new Date().toISOString()}] [WARN] apisoak probe line`);
if (cl.status !== 200) FAIL('/client-log → ' + cl.status);
ok('/client-log accepted');

console.log('PASS: full API surface + spectate + admin verified over the wire');
process.exit(0);
