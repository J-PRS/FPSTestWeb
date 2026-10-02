import { describe, it, expect, afterEach } from 'bun:test';
import { GameServer } from '../src/GameServer.ts';
import { RtcServer } from '../src/RtcServer.ts';
import type { WebSocketData } from '../src/types.ts';
import { NetClient } from '../../tools/netbot/netClient.ts';
import { NetBot } from '../../tools/netbot/bot.ts';
import { LatencyLink, type LatencyOpts } from '../../tools/netbot/latency.ts';
import type { NdModule } from '../../tools/netbot/rtcSocket.ts';

// Real-socket tier: an actual Bun.serve + actual WebSocket clients, so the
// join/tick/claim pipeline runs the same code path a browser would — the
// scenario suite drives GameServer in-process and structurally cannot
// produce reorders or lifecycle gaps. LatencyLink supplies the jitter that
// makes claims race their spawn registrations.
function bootServer() {
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
      if (url.pathname === '/ws' || url.pathname === '/rtcs') {
        if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtcs: url.pathname === '/rtcs' } })) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response('nf', { status: 404 });
    },
  });
  gs.setBunServer(server);
  return { gs, server, url: `ws://127.0.0.1:${server.port}/ws` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// node-datachannel resolves from server_bun/node_modules — injected into
// netbot's RTC transport rather than imported inside tools/.
const nd = await import('node-datachannel').then((m) => ((m as { default?: NdModule }).default ?? m) as NdModule).catch(() => null);

describe('netbot — real clients over real sockets', () => {
  let env: ReturnType<typeof bootServer> | null = null;
  const bots: { nc: NetClient; bot: NetBot }[] = [];

  afterEach(() => {
    for (const b of bots.splice(0)) { b.bot.stop(); b.nc.close(); }
    env?.server.stop(true);
    env?.gs.stop();
    env = null;
  });

  const spawn = async (n: number, link: LatencyOpts, opts: { hopEveryMs?: number; transports?: ('ws' | 'rtc')[] } = {}) => {
    for (let i = 0; i < n; i++) {
      const transport = opts.transports?.[i % opts.transports.length] ?? 'ws';
      const nc = new NetClient(env!.url, `nb_${i}`, new LatencyLink(link), { transport, rtc: nd ? { nd } : undefined });
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

  const rejectsOf = () => bots.map((b) => `${b.nc.id}: ${[...b.nc.tel.rejects.entries()].map(([r, n]) => `${r} x${n}`).join(', ') || 'none'}`).join(' | ');
  const totalRejects = () => bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);

  it('bots fight over real WS with jittered claims — every legit claim resolves', async () => {
    env = bootServer();
    await spawn(4, { pingMs: 20, jitterMs: 150, lossRate: 0 }); // heavy jitter: claims race spawns constantly
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

    // State correctness, not just flow: two observers of the same player
    // should agree on what the server told them. Both read the same
    // ordered tick/event streams, so divergence means a broadcast bug —
    // not a latency artifact.
    for (const [id, a] of bots[0].nc.roster) {
      for (const other of bots.slice(1)) {
        const b = other.nc.roster.get(id);
        if (!b) continue;
        expect(b.health).toBe(a.health);
        expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)).toBeLessThan(2);
      }
    }
  }, 30000);

  it('a deploy claim lands on every observer — deploySpawn/deployables wire coverage', async () => {
    env = bootServer();
    await spawn(3, { pingMs: 20, jitterMs: 120, lossRate: 0 });
    await sleep(1500); // joined + field loaded
    const planter = bots[0].nc;
    planter.send({ type: 'deploy', kind: 'mine', position: { ...planter.self.pos } });
    await sleep(800);
    // Every client — planter included — should see the same deployable
    // set; a dropped deploySpawn leaves the world permanently forked.
    for (const b of bots) {
      const owned = [...b.nc.deployables.values()].filter((d) => d.owner === planter.id && d.kind === 'mine');
      expect(owned.length).toBe(1);
    }
  }, 30000);

  it('a mid-match room hop keeps hits flowing (per-room seq reset)', async () => {
    env = bootServer();
    await spawn(4, { pingMs: 20, jitterMs: 60, lossRate: 0 }, { hopEveryMs: 4000 });
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

  it('a harsh WAN (100ms + 300 jitter + 5% loss) still resolves every claim it sees', async () => {
    env = bootServer();
    await spawn(4, { pingMs: 100, jitterMs: 300, lossRate: 0.05 });
    await sleep(9000);
    await sleep(600); // drain the deep in-flight window

    const dealt = bots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0);
    const rejects = bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);
    const lost = bots.reduce((a, b) => a + b.nc.link.dropped, 0);

    // Loss drops messages before the server ever sees them — rejects
    // should still be zero because nothing malformed survives, only
    // vanished. Assert the link actually dropped (guard against a
    // silently off loss knob).
    expect(lost).toBeGreaterThan(0);
    expect(dealt).toBeGreaterThan(0);
    if (rejects) console.log(`  rejects: ${rejectsOf()}`);
    expect(rejects).toBe(0);
  }, 30000);

  it('a dropped socket rejoins cleanly — post-reconnect claims resolve', async () => {
    env = bootServer();
    await spawn(2, { pingMs: 20, jitterMs: 60, lossRate: 0 });
    await sleep(3500);

    const victim = bots[0]!;
    const gsBefore = victim.nc.tel.gameStates;
    victim.nc.ws?.close();
    await sleep(300);
    await victim.nc.connect();
    await sleep(3500);
    await sleep(300);

    const rejects = totalRejects();
    if (rejects) console.log(`  rejects: ${rejectsOf()}`);
    expect(victim.nc.tel.gameStates).toBeGreaterThan(gsBefore);
    expect(victim.nc.closed).toBe(false);
    expect(bots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0)).toBeGreaterThan(0);
    // The bug this pins: a stale gameStates>0 used to un-gate gameplay
    // before the new handshake — the server would 1008 the socket and
    // rejects would never even arrive to count.
    expect(rejects).toBe(0);
  }, 30000);

  it('ws and rtc clients fight in the same room — SCTP lanes resolve claims too', async () => {
    if (!nd) return; // native addon unavailable in this environment
    env = bootServer();
    await spawn(4, { pingMs: 20, jitterMs: 80, lossRate: 0 }, { transports: ['ws', 'rtc'] });
    await sleep(9000);
    await sleep(400);

    for (const b of bots) expect(b.nc.tel.gameStates).toBeGreaterThan(0);
    const rtcBots = bots.filter((_, i) => i % 2 === 1);
    const rtcDealt = rtcBots.reduce((a, b) => a + b.nc.tel.hitsDealt, 0);
    const rejects = totalRejects();
    if (rejects) console.log(`  rejects: ${rejectsOf()}`);

    expect(rtcBots.length).toBe(2);
    expect(rtcDealt).toBeGreaterThan(0); // the SCTP lane dealt damage
    expect(rejects).toBe(0);
  }, 30000);
});
