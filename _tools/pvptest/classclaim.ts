/**
 * Class-reclaim probe — the prod 'class-locked weapon' spam, over a real
 * socket. A light player banks a heavy swap (classUpdate), drops, and
 * reclaims. The handshake must carry the LIVE class (appliedClass), not
 * the banked pick: pre-fix the seat flipped to 'heavy' on reclaim and
 * every light-only weapon (Lightning) reject-spammed until respawn.
 *
 * Leg A (fixed client): reclaim armorClass='light' → Lightning fires clean.
 * Leg B (old client):   reclaim armorClass='heavy' → Lightning rejects,
 *                       proving the adjudication path itself is alive.
 *
 * Usage: bun _tools/pvptest/classclaim.ts ws://127.0.0.1:PORT/ws
 */
import { openSocket } from './net.ts';
import { iterBatch, decodeWireJson } from '../../shared/wire.ts';

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
// Bare joins resolve via quickRoom to the busiest room (e.g. headhunt-1);
// the reclaim path compares the REQUESTED room name to the seat's actual
// room, so rejoins must carry gameState.room — the /s/<room> identity a
// real client ends up with — or the seat is retired as a 'different-room
// join' and pendingClass dies with it.
let ROOM = 'classclaim';
const PID = `classclaim-${Date.now() % 100000}`;
const LIGHTNING = 12; // shared WeaponType.Lightning
const FAIL = (m: string) => { console.log('FAIL:', m); process.exit(1); };

interface Sock { send(s: string): void; close(): void; onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null }

// Server→client reliable JSON rides text when idle but gets coalesced
// into WIRE_BATCH binary frames during ticks — unwrap both shapes.
function msgsOf(ev: { data: unknown }): any[] {
  let u8: Uint8Array | null = null;
  let text: string | null = null;
  if (typeof ev.data === 'string') {text = ev.data;}
  else if (ev.data instanceof ArrayBuffer) {u8 = new Uint8Array(ev.data);}
  else if (ev.data instanceof Uint8Array) {u8 = ev.data;}
  if (text !== null) {
    try {return [JSON.parse(text)];} catch {return [];}
  }
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

function join(armorClass: string, token?: string): Promise<{ sock: Sock; state: any; msgs: any[] }> {
  return new Promise((res, rej) => {
    const msgs: any[] = [];
    const t = setTimeout(() => rej(new Error('join timeout')), 10000);
    openSocket(WS_URL, 'ws').then((s: any) => {
      s.onmessage = (ev: any) => {
        for (const m of msgsOf(ev)) {
          msgs.push(m);
          if (m.type === 'gameState') {
            if (typeof m.room === 'string' && m.room) {ROOM = m.room;}
            clearTimeout(t); res({ sock: s, state: m, msgs });
          }
        }
      };
      s.onclose = () => rej(new Error('closed before gameState'));
      s.send(JSON.stringify({
        type: 'join', playerId: PID, room: ROOM, transport: 'ws', token,
        armorClass, perk: 'none', spawnHold: true,
      }));
    }).catch(rej);
  });
}

function fireLightning(sock: Sock, shots = 1, windowMs = 1200): Promise<{ locked: number; all: string[]; types: Record<string, number> }> {
  return new Promise((res) => {
    let locked = 0;
    const all: string[] = [];
    const types: Record<string, number> = {};
    const prev = sock.onmessage;
    sock.onmessage = (ev: any) => {
      prev?.(ev);
      for (const m of msgsOf(ev)) {
        types[m.type] = (types[m.type] ?? 0) + 1;
        if (m.type === 'shotRejected') {all.push(String(m.reason)); if (String(m.reason).includes('class-locked')) {locked += 1;}}
      }
    };
    for (let i = 0; i < shots; i++) {
      sock.send(JSON.stringify({ type: 'shotFired', weaponType: LIGHTNING, dir: { x: 0, y: 0, z: 1 }, shotId: `cc-${Date.now()}-${i}` }));
    }
    setTimeout(() => res({ locked, all, types }), windowMs);
  });
}

/** First yourHealth with health>0 after a confirmed kill = the respawn.
 *  Class HP pools make the value name the applied class: light 75,
 *  medium 125, heavy 200 (100 base + CLASS_STATS bonus, perk 'none').
 *  playerRespawn itself rides a lane this probe can't decode, but the
 *  health echo can't fire while dead — health 0 — so >0 means revived. */
function waitHealth(sock: Sock, ms = 20000): Promise<{ health: number; types: Record<string, number> }> {
  return new Promise((res) => {
    const types: Record<string, number> = {};
    const prev = sock.onmessage;
    const t = setTimeout(() => res({ health: 0, types }), ms);
    sock.onmessage = (ev: any) => {
      prev?.(ev);
      for (const m of msgsOf(ev)) {
        types[m.type] = (types[m.type] ?? 0) + 1;
        if (m.type === 'yourHealth' && typeof m.health === 'number' && m.health > 0) {
          clearTimeout(t); res({ health: m.health, types }); return;
        }
      }
    };
  });
}

// Leg 0: join live-light, bank a heavy swap, drop inside the grace window.
const first = await join('light');
const token = first.state.sessionToken;
if (!token) {FAIL('no sessionToken in gameState');}
first.sock.send(JSON.stringify({ type: 'classUpdate', armorClass: 'heavy' }));
await new Promise(r => setTimeout(r, 300));
first.sock.close();
await new Promise(r => setTimeout(r, 1200));
console.log('joined light, banked heavy pick, dropped — reclaiming');

// Leg A: fixed client reclaims with the LIVE class.
const backA = await join('light', token);
// Reclaim re-arms the spawn hold — 'ready' must land AFTER the hold is
// up or it no-ops and the seat stays awaitingReady (respawn refuses).
await new Promise(r => setTimeout(r, 800));
backA.sock.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 300));
backA.sock.send(JSON.stringify({ type: 'ready' }));
const rejA = await fireLightning(backA.sock, 5);
console.log(`leg A (claim=light/applied): class-locked rejects = ${rejA.locked} all=${JSON.stringify(rejA.all)} types=${JSON.stringify(rejA.types)}`);
if (rejA.locked !== 0) {FAIL(`light-only gun rejected ${rejA.locked}x after live-class reclaim`);}

/** Watch for MY death (playerKill targetId) — WAN jitter can land the
 *  self-hit inside the post-release shield, which refuses it silently. */
function waitKill(sock: Sock, ms = 6000): Promise<boolean> {
  return new Promise((res) => {
    const prev = sock.onmessage;
    const t = setTimeout(() => res(false), ms);
    sock.onmessage = (ev: any) => {
      prev?.(ev);
      for (const m of msgsOf(ev)) {
        if (m.type === 'playerKill' && m.targetId === PID) { clearTimeout(t); res(true); return; }
      }
    };
  });
}

// Leg A2: the banked heavy pick must survive the reclaim and apply at the
// next respawn — respawnRequest self-kills, the ~3s timer revives as heavy.
// Reclaim shields the seat for 2s (protectedUntil) — retry the self-kill
// until the death actually registers instead of trusting one shot.
await new Promise(r => setTimeout(r, 3000));
let respawned = false;
for (let attempt = 0; attempt < 4 && !respawned; attempt++) {
  backA.sock.send(JSON.stringify({ type: 'respawn' }));
  if (!(await waitKill(backA.sock))) {continue;} // shield ate the self-hit — retry
  const hp = await waitHealth(backA.sock, 20000);
  // 200 = heavy pool (pendingClass applied); 75 = light (pick lost).
  respawned = hp.health > 0;
  console.log(`leg A2 respawn health = ${hp.health} (200=heavy applied, 75=light) types=${JSON.stringify(hp.types)}`);
  if (!respawned) {FAIL('death registered but no respawn health echo — seat wedged dead');}
}
if (!respawned) {FAIL('self-kill never registered — respawn path untestable this run');}
const rejA2 = await fireLightning(backA.sock);
console.log(`leg A2 (now heavy): class-locked rejects = ${rejA2.locked} all=${JSON.stringify(rejA2.all)}`);
if (rejA2.locked === 0) {FAIL('heavy class did not lock Lightning after respawn — gate is dead');}
backA.sock.close();
await new Promise(r => setTimeout(r, 800));

// Leg B: old client reclaims with the banked PICK — seat must flip and
// the same shot must reject, proving the gate is alive and leg A meant it.
const backB = await join('heavy', token);
await new Promise(r => setTimeout(r, 800));
backB.sock.send(JSON.stringify({ type: 'ready' }));
await new Promise(r => setTimeout(r, 300));
backB.sock.send(JSON.stringify({ type: 'ready' }));
const rejB = await fireLightning(backB.sock);
console.log(`leg B (claim=heavy/pick):   class-locked rejects = ${rejB.locked} all=${JSON.stringify(rejB.all)} types=${JSON.stringify(rejB.types)}`);
if (rejB.locked === 0) {FAIL('pick-class reclaim did not lock the gun — gate is dead');}
backB.sock.close();

console.log('PASS: reclaim carries the live class; banked picks survive to respawn');
process.exit(0);
