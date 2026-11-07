/**
 * Reclaim-storm + live classchange probe — prod WAN.
 * 4x rapid drop/reclaim cycles: each must restore the seat, keep the
 * live class, and fire Lightning clean. Then a mid-match classUpdate
 * round-trip (light→heavy→light) verified via respawn health pools.
 *
 * Usage: bun _tools/pvptest/storm.ts wss://play.jprice.app:8443/ws
 */
import { openSocket } from './net.ts';
import { iterBatch, decodeWireJson } from '../../shared/wire.ts';

const WS_URL = process.argv[2] ?? 'wss://play.jprice.app:8443/ws';
let ROOM = 'storm';
const PID = `storm-${Date.now() % 100000}`;
const LIGHTNING = 12;
const FAIL = (m: string) => { console.log('FAIL:', m); process.exit(1); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function msgsOf(ev: { data: unknown }): any[] {
  let u8: Uint8Array | null = null; let text: string | null = null;
  if (typeof ev.data === 'string') {text = ev.data;}
  else if (ev.data instanceof ArrayBuffer) {u8 = new Uint8Array(ev.data);}
  else if (ev.data instanceof Uint8Array) {u8 = ev.data;}
  if (text !== null) {try {return [JSON.parse(text)];} catch {return [];}}
  if (u8 === null) {return [];}
  const out: any[] = [];
  const pushJson = (f: Uint8Array): void => {const j = decodeWireJson(f); if (j === null) {return;} try {out.push(JSON.parse(j));} catch {}};
  if (u8.length >= 2 && u8[0] === 0x54 && u8[1] === 0x0D) {for (const f of iterBatch(u8)) {pushJson(f);}}
  else {pushJson(u8);}
  return out;
}

interface Conn { sock: any; state: any; msgs: any[]; closed: boolean }
function join(armorClass: string, token?: string): Promise<Conn> {
  return new Promise((res, rej) => {
    const msgs: any[] = []; const c: Conn = { sock: null, state: null, msgs, closed: false };
    const t = setTimeout(() => rej(new Error('join timeout')), 12000);
    openSocket(WS_URL, 'wss', true).then((s: any) => {
      c.sock = s;
      s.onmessage = (ev: any) => {for (const m of msgsOf(ev)) {msgs.push(m); if (m.type === 'gameState') {if (m.room) {ROOM = m.room;} clearTimeout(t); c.state = m; res(c);}}};
      s.onclose = () => {c.closed = true;};
      s.send(JSON.stringify({ type: 'join', playerId: PID, room: ROOM, transport: 'ws', token, armorClass, perk: 'none', spawnHold: true }));
    }).catch(rej);
  });
}

async function ready(c: Conn): Promise<void> {
  await sleep(800); c.sock.send(JSON.stringify({ type: 'ready' })); await sleep(300); c.sock.send(JSON.stringify({ type: 'ready' }));
}
function countType(c: Conn, type: string, ms: number): Promise<number> {
  return new Promise((res) => {
    const prev = c.sock.onmessage; let n = 0;
    c.sock.onmessage = (ev: any) => {prev?.(ev); for (const m of msgsOf(ev)) {if (m.type === type) {n += 1;}}};
    setTimeout(() => {c.sock.onmessage = prev; res(n);}, ms);
  });
}
async function fireLightning(c: Conn): Promise<number> {
  let locked = 0;
  const prev = c.sock.onmessage;
  c.sock.onmessage = (ev: any) => {prev?.(ev); for (const m of msgsOf(ev)) {if (m.type === 'shotRejected' && String(m.reason).includes('class-locked')) {locked += 1;}}};
  for (let i = 0; i < 4; i++) {c.sock.send(JSON.stringify({ type: 'shotFired', weaponType: LIGHTNING, dir: { x: 0, y: 0, z: 1 }, shotId: `st-${Date.now()}-${i}` }));}
  await sleep(1500); c.sock.onmessage = prev;
  return locked;
}
function waitDeath(c: Conn, ms = 8000): Promise<boolean> {
  return new Promise((res) => {
    const prev = c.sock.onmessage; const t = setTimeout(() => res(false), ms);
    c.sock.onmessage = (ev: any) => {prev?.(ev); for (const m of msgsOf(ev)) {if (m.type === 'playerKill' && m.targetId === PID) {clearTimeout(t); res(true); return;}}};
  });
}
function waitHealth(c: Conn, ms = 20000): Promise<number> {
  return new Promise((res) => {
    const prev = c.sock.onmessage; const t = setTimeout(() => res(0), ms);
    c.sock.onmessage = (ev: any) => {prev?.(ev); for (const m of msgsOf(ev)) {if (m.type === 'yourHealth' && m.health > 0) {clearTimeout(t); res(m.health); return;}}};
  });
}

// --- Storm: 4 rapid drop/reclaim cycles ---
let token: string | undefined;
for (let i = 0; i < 4; i++) {
  const c = await join('light', i === 0 ? undefined : token);
  token = c.state.sessionToken ?? token;
  await ready(c);
  const rej = await fireLightning(c);
  const respawns = await countType(c, 'playerRespawn', 500);
  console.log(`cycle ${i}: reclaim ok, class-locked=${rej}, respawnFrames=${respawns}, closedPrev=${c.closed}`);
  if (rej !== 0) {FAIL(`cycle ${i}: class-locked reject after reclaim`);}
  if (i < 3) {c.sock.close(); await sleep(900);}
}
const live = await join('light', token); token = live.state.sessionToken ?? token;
await ready(live);
console.log('storm done — live classchange leg');

// --- Classchange round-trip: heavy (200hp) then light (75hp) ---
for (const [cls, wantHp] of [['heavy', 200], ['light', 75]] as const) {
  live.sock.send(JSON.stringify({ type: 'classUpdate', armorClass: cls }));
  await sleep(400);
  // Banked pick applies at NEXT respawn — self-kill until death lands.
  let hp = 0;
  for (let a = 0; a < 4 && hp === 0; a++) {
    const dead = waitDeath(live, 6000);
    live.sock.send(JSON.stringify({ type: 'respawn' }));
    if (!(await dead)) {continue;}
    hp = await waitHealth(live, 20000);
  }
  console.log(`classUpdate→${cls}: respawn health=${hp} (want ${wantHp})`);
  if (hp !== wantHp) {FAIL(`class change to ${cls} gave health ${hp}, want ${wantHp}`);}
}
live.sock.close();
console.log('PASS: 4x reclaim storm clean + live classchange round-trip verified');
process.exit(0);
