// botFill probe: join 2 humans into crossfire (botFill=10); expect total
// bodies to stay at 10 — bots retire as humans join, respawn after leave.
import { decodeTickFrame, isWireFrame, WIRE_TICK, WIRE_TICK_V3, WireIdRoster } from '../../shared/wire.ts';
const wireRoster = new WireIdRoster();

const S = 'ws://127.0.0.1:9105/ws';
const players = new Map<string, number>(); // id -> last seen tick
function join(name: string) {
  const ws = new WebSocket(S);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', playerId: name, room: 'crossfire', mode: 'ctf' }));
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      wireRoster.feed(m);
      if (m.type === 'playerJoined') players.set(m.playerId, Date.now());
      if (m.type === 'playerLeft') players.delete(m.playerId);
      if (m.type === 'gameState') for (const p of m.players) players.set(p.id, Date.now());
    } else {
      const u8 = new Uint8Array(ev.data as ArrayBuffer);
      if (isWireFrame(u8) && (u8[1] === WIRE_TICK || u8[1] === WIRE_TICK_V3)) {
        const f = decodeTickFrame(u8, wireRoster.pool);
        if (f) for (let i = 0; i < (f.count ?? f.updates.length); i++) { const u = f.updates[i]!; if (u.playerId) players.set(u.playerId, Date.now()); }
      }
    }
  };
  return ws;
}
const count = () => [...players.keys()];
const log = (tag: string) => console.log(`${tag}: ${count().length} players`, count().sort().join(','));
const a = join('FILLA' + Math.floor(Math.random() * 1e4));
await new Promise(r => setTimeout(r, 5000));
log('after A join');
const b = join('FILLB' + Math.floor(Math.random() * 1e4));
await new Promise(r => setTimeout(r, 6000));
log('after B join (expect ~10 total, a bot retired)');
b.close();
await new Promise(r => setTimeout(r, 14000));
log('after B leaves (grace + refill → back to 10)');
a.close();
process.exit(0);
