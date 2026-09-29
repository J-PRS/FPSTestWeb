/* Chat relay probe — two bots join a room, one sends `chat`, the other
 * must receive the `chat` broadcast back. Verifies the only wire path
 * never exercised live: validation → broadcast → delivery. */
import { openSocket, type BotSocket } from './net.ts';

const WS_URL = process.argv[2] ?? 'ws://localhost:8000/ws';
const ROOM = process.argv[3] ?? 'chatprobe';
const TEXT = `probe-${Math.random().toString(36).slice(2, 8)}`;

function join(sock: BotSocket, name: string): Promise<void> {
  return new Promise((res, rej) => {
    const prev = sock.onmessage;
    sock.onmessage = (ev) => {
      prev?.(ev);
      try {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : 'null');
        if (m?.type === 'gameState') res();
      } catch { /* binary frames */ }
    };
    sock.send(JSON.stringify({ type: 'join', playerId: name, room: ROOM, transport: 'ws' }));
    setTimeout(() => rej(new Error(`${name}: join timeout`)), 15000);
  });
}

const a = await openSocket(WS_URL, 'ws');
const b = await openSocket(WS_URL, 'ws');
await join(a, 'CHAT-A');
await join(b, 'CHAT-B');

const got = new Promise<string | null>((res) => {
  const prev = b.onmessage;
  b.onmessage = (ev) => {
    prev?.(ev);
    try {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : 'null');
      if (m?.type === 'chat') res(`${m.playerId}: ${m.text}`);
    } catch { /* binary frames */ }
  };
  setTimeout(() => res(null), 10000);
});

a.send(JSON.stringify({ type: 'chat', text: TEXT }));
const relayed = await got;
console.log(relayed === `CHAT-A: ${TEXT}` ? `PASS: relayed "${relayed}"` : `FAIL: got ${relayed}`);
// Also confirm the room never echoes to anyone else / sender sees own line
a.close(); b.close();
process.exit(relayed === `CHAT-A: ${TEXT}` ? 0 : 1);
