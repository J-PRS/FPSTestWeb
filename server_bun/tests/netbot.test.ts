import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import type { WebSocketData } from '../src/types.ts';
import { NetClient } from '../../tools/netbot/netClient.ts';
import { NetBot } from '../../tools/netbot/bot.ts';
import { LatencyLink } from '../../tools/netbot/latency.ts';

// Real-socket tier: an actual Bun.serve + actual WebSocket clients, so the
// join/tick/claim pipeline runs the same code path a browser would — the
// scenario suite drives GameServer in-process and structurally cannot
// produce reorders or lifecycle gaps. LatencyLink supplies the jitter that
// makes claims race their spawn registrations.
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
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now() } })) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response('nf', { status: 404 });
    },
  });
  gs.setBunServer(server);
  return { gs, server, url: `ws://127.0.0.1:${server.port}/ws` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('netbot — real clients over real sockets', () => {
  let env: ReturnType<typeof bootServer> | null = null;
  const bots: { nc: NetClient; bot: NetBot }[] = [];

  afterEach(() => {
    for (const b of bots.splice(0)) { b.bot.stop(); b.nc.close(); }
    env?.server.stop(true);
    env?.gs.stop();
    env = null;
  });

  const spawn = async (n: number, jitter: number, opts: { hopEveryMs?: number } = {}) => {
    for (let i = 0; i < n; i++) {
      const nc = new NetClient(env!.url, `nb_${i}`, new LatencyLink({ pingMs: 20, jitterMs: jitter, lossRate: 0 }));
      const bot = new NetBot(nc, opts);
      bots.push({ nc, bot });
      // Staggered connects — a burst of simultaneous socket opens made
      // some joins never land (silent ghost sockets), exactly the flake
      // a join-retry now papers over.
      await nc.connect();
      await sleep(60);
    }
    for (const b of bots) b.bot.start();
  };

  it('bots fight over real WS with jittered claims — every legit claim resolves', async () => {
    env = bootServer();
    await spawn(4, 150); // heavy jitter: claims race spawns constantly
    await sleep(8000);
    await sleep(400); // let in-flight claims land

    const t = bots.map((b) => b.nc.tel);
    for (const b of bots) expect(b.nc.tel.gameStates).toBeGreaterThan(0);
    const shots = t.reduce((a, x) => a + x.shots, 0);
    const claims = t.reduce((a, x) => a + x.claims, 0);
    const dealt = t.reduce((a, x) => a + x.hitsDealt, 0);
    const rejects = t.reduce((a, x) => a + [...x.rejects.values()].reduce((p, q) => p + q, 0), 0);

    // Sanity: the fight actually happened.
    expect(shots).toBeGreaterThan(0);
    expect(claims).toBeGreaterThan(0);
    // The property the whole harness exists for: deferred claims must
    // absorb reorders — a healthy session produces zero rejects.
    expect(dealt).toBeGreaterThan(0);
    expect(rejects).toBe(0);
  }, 30000);

  it('a mid-match room hop keeps hits flowing (per-room seq reset)', async () => {
    env = bootServer();
    await spawn(4, 60, { hopEveryMs: 4000 });
    await sleep(9000);

    const hopped = bots.some((b) => b.nc.tel.hops > 0);
    const dealt = bots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0);
    const rejects = bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);
    const dedupStorms = bots.reduce((a, b) => a + b.nc.tel.dedupDrops, 0);

    expect(hopped).toBe(true);
    expect(dealt).toBeGreaterThan(0);
    expect(rejects).toBe(0);
    // Stale-seq drops across a hop mean the watermark never reset — the
    // session-long damage blackout this suite exists to prevent.
    expect(dedupStorms).toBeLessThan(4);
  }, 30000);
});
