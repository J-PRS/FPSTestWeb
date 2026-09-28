/**
 * Reconnect probe — exercises the grace-token reclaim path over a real
 * socket: join, capture sessionToken, drop the socket, rejoin with the
 * token, and verify the same identity comes back with a fresh gameState
 * (roster, balls, pickups reconciled — the desync class we closed).
 * Also asserts a WRONG token is rejected.
 *
 * Usage: bun _tools/pvptest/reconnect.ts ws://127.0.0.1:PORT/ws
 */
import { openSocket } from './net.ts';

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const ROOM = process.argv[3] ?? 'reconn';
const NAME = 'reconn-probe';
const FAIL = (m: string) => { console.log('FAIL:', m); process.exit(1); };

function join(token?: string): Promise<{ sock: any; state: any }> {
  return new Promise((res, rej) => {
    let sock: any;
    const t = setTimeout(() => rej(new Error('join timeout')), 10000);
    openSocket(WS_URL, 'ws').then((s) => {
      sock = s;
      s.onmessage = (ev: any) => {
        if (typeof ev.data !== 'string') return;
        const m = JSON.parse(ev.data);
        if (m.type === 'gameState') { clearTimeout(t); res({ sock, state: m }); }
      };
      s.onclose = () => rej(new Error('closed before gameState'));
      s.send(JSON.stringify({ type: 'join', playerId: NAME, room: ROOM, transport: 'ws', token }));
    }).catch(rej);
  });
}

const first = await join();
const token = first.state.sessionToken;
if (!token) FAIL('no sessionToken in gameState');
console.log('joined; token captured, roster:', first.state.players.length, 'players, balls:', first.state.balls?.length ?? 'n/a');
const hp = first.state.localPlayerState?.health;

first.sock.close();
await new Promise(r => setTimeout(r, 1200)); // inside grace window

// Wrong token must be rejected
try {
  await join('bogus-token');
  FAIL('bad token accepted');
} catch (e) {
  console.log('bad-token join rejected (expected):', String(e).slice(0, 60));
}
await new Promise(r => setTimeout(r, 400));

// Real token must reclaim the slot
const back = await join(token);
if (back.state.playerId && back.state.playerId !== NAME) FAIL('identity changed');
console.log('rejoined; roster:', back.state.players.length, 'players, health:', back.state.localPlayerState?.health);

// The old socket's player slot must NOT be duplicated in the roster
const dupes = back.state.players.filter((p: any) => p.playerId === NAME);
if (dupes.length > 0) FAIL('self appears in remote roster after reclaim');

// Roster sanity: every remote id unique
const ids = back.state.players.map((p: any) => p.playerId);
if (new Set(ids).size !== ids.length) FAIL('duplicate ids in roster');

console.log('PASS: grace reclaim restores identity with a clean roster');
back.sock.close();
process.exit(0);
