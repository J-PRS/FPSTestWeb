// Probe: does a capper NetBot actually reach the flag server-side?
import { GameServer } from '../server_bun/src/GameServer.ts';
import { RtcServer } from '../server_bun/src/RtcServer.ts';
import type { WebSocketData } from '../server_bun/src/types.ts';
import { NetClient } from './netbot/netClient.ts';
import { NetBot } from './netbot/bot.ts';
import { LatencyLink } from './netbot/latency.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../shared/botLoadouts.ts';

const gs = new GameServer();
const rtc = new RtcServer(gs);
const server = Bun.serve<WebSocketData>({
  port: 0,
  websocket: {
    data: {} as WebSocketData,
    open(ws) { ws.data.rtcs ? rtc.onOpen(ws) : gs.onOpen(ws); },
    message(ws, m) { (ws.data.rtcs ? rtc : gs).onMessage(ws, m as string | ArrayBuffer); },
    close(ws) { ws.data.rtcs ? rtc.onClose(ws) : gs.onClose(ws); },
    drain(ws) { if (!ws.data.rtcs) gs.onDrain(ws); },
  },
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtcs: false } })) return undefined;
      return new Response('upgrade failed', { status: 400 });
    }
    return new Response('nf', { status: 404 });
  },
});
gs.setBunServer(server);
const url = `ws://127.0.0.1:${server.port}/ws`;

const opts = { room: 'henge', mode: 'ctf', bots: 4 };
const nc = new NetClient(url, 'runner', new LatencyLink({ pingMs: 0, jitterMs: 0, lossRate: 0 }), { ...opts, armorClass: botClassForLoadout(BOT_LOADOUTS[0]!) });
const bot = new NetBot(nc, { loadout: BOT_LOADOUTS[0]!, capper: true });
await nc.connect();
bot.start();

let minD = Infinity;
const t = setInterval(() => {
  const room = gs.rooms.get('henge');
  if (!room) { console.log('no room yet'); return; }
  const f = room.flags ? [...room.flags.flags.values()].map(f => `${f.state}@${f.pos.x.toFixed(0)},${f.pos.y.toFixed(1)},${f.pos.z.toFixed(0)} car=${f.carrier ?? '-'}`).join(' | ') : 'NO FLAGS';
  const me = room.players.getPlayer('runner');
  const bf = room.flags?.flags.get('bravo');
  if (me && bf) {
    const d = Math.hypot(me.position.x - bf.pos.x, me.position.z - bf.pos.z);
    if (d < minD) minD = d;
    console.log(`  dy=${(me.position.y - bf.pos.y).toFixed(1)} planarD=${d.toFixed(1)} minSoFar=${minD.toFixed(1)}`);
  }
  console.log(`me=${me ? `${me.position.x.toFixed(0)},${me.position.y.toFixed(0)},${me.position.z.toFixed(0)} team=${me.team} dead=${me.isDead}` : '??'} | flags: ${f}`);
  console.log(`  client sees flags: ${[...nc.flags.entries()].map(([t, f]) => `${t}:${f.state}@${f.pos.x.toFixed(0)},${f.pos.z.toFixed(0)}`).join(' | ') || 'none'} team=${nc.self.team} pos=${nc.self.pos.x.toFixed(0)},${nc.self.pos.z.toFixed(0)}`);
}, 3000);

await new Promise(r => setTimeout(r, 45000));
clearInterval(t);
bot.stop(); nc.close(); server.stop(true); gs.stop();
console.log('done');
