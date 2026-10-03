import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { WebSocketData } from '../src/types.ts';
import { NetClient } from '../../tools/netbot/netClient.ts';
import { NetBot } from '../../tools/netbot/bot.ts';
import { LatencyLink } from '../../tools/netbot/latency.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../shared/botLoadouts.ts';

// Networked soak regression guard — does sim time track wall clock inside a real
// room tick? Regression test for the room.sims clock migration: a fixed
// TICK_DT feed lets interval lag drift sims ~18% behind wall time.
function bootServer() {
  const gs = new GameServer();
  const server = Bun.serve<WebSocketData>({
    port: 0,
    websocket: {
      data: {} as WebSocketData,
      open(ws) { gs.onOpen(ws); },
      message(ws, m) { gs.onMessage(ws, m as string | ArrayBuffer); },
      close(ws) { gs.onClose(ws); },
      drain(ws) { gs.onDrain(ws); },
    },
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now() } })) return undefined;
      return new Response('nf', { status: 404 });
    },
  });
  gs.setBunServer(server);
  return { gs, server, url: `ws://127.0.0.1:${server.port}/ws` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sim clock vs wall clock (networked soak)', () => {
  const env = bootServer();
  const bots: { nc: NetClient; bot: NetBot }[] = [];

  afterEach(() => {
    for (const b of bots.splice(0)) { b.bot.stop(); b.nc.close(); }
    env.server.stop(true);
    env.gs.stop();
  });

  it('ballSim/creatureSim simTime tracks wall time over 30s of real ticks', async () => {
    for (let i = 0; i < 2; i++) {
      const lo = BOT_LOADOUTS[i % BOT_LOADOUTS.length]!;
      const nc = new NetClient(env.url, `clk_${i}`, new LatencyLink({ pingMs: 20, jitterMs: 60, lossRate: 0 }), { armorClass: botClassForLoadout(lo) });
      const bot = new NetBot(nc, { loadout: lo });
      bots.push({ nc, bot });
      await nc.connect();
      await sleep(60);
      bot.start();
    }
    const room = env.gs.rooms.get('default')!;
    expect(room).toBeTruthy();
    // Let the sims settle before sampling (field attach + first tick).
    await sleep(2000);
    const t0 = Date.now();
    const b0 = room.ballSim.simTime;
    const c0 = room.creatureSim.simTime;
    await sleep(30000);
    const wall = (Date.now() - t0) / 1000;
    const ballRate = (room.ballSim.simTime - b0) / wall;
    const crawlRate = (room.creatureSim.simTime - c0) / wall;
    const alive = [...room.players.getAllPlayers().values()].filter(p => !p.isDead).length;
    console.log(`SOAK wall=${wall.toFixed(1)}s ballRate=${ballRate.toFixed(3)} crawlRate=${crawlRate.toFixed(3)} dormant=${room.creatureSim.dormant} field=${!!room.creatureSim.field} pops=${JSON.stringify(room.creatureSim.pops)} alive=${alive}`);
    // Sim time should track wall time within ~10% (tick lag only, not drift).
    expect(ballRate).toBeGreaterThan(0.9);
    expect(crawlRate).toBeGreaterThan(0.9);
    expect(ballRate).toBeLessThan(1.1);
    expect(crawlRate).toBeLessThan(1.1);
  }, 60000);
});
