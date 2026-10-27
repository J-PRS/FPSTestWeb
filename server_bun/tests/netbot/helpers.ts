import { afterEach } from 'bun:test';
import { GameServer } from '../../src/GameServer.ts';
import { RtcServer } from '../../src/RtcServer.ts';
import type { WebSocketData } from '../../src/types.ts';
import { NetClient } from '../../../tools/netbot/netClient.ts';
import { NetBot } from '../../../tools/netbot/bot.ts';
import { LatencyLink, type LatencyOpts } from '../../../tools/netbot/latency.ts';
import { BOT_LOADOUTS, botClassForLoadout } from '../../../shared/botLoadouts.ts';
import type { NdModule } from '../../../tools/netbot/rtcSocket.ts';

// Real-socket tier: an actual Bun.serve + actual WebSocket clients, so the
// join/tick/claim pipeline runs the same code path a browser would — the
// scenario suite drives GameServer in-process and structurally cannot
// produce reorders or lifecycle gaps. LatencyLink supplies the jitter that
// makes claims race their spawn registrations.
export function bootServer(): { gs: GameServer; server: ReturnType<typeof Bun.serve<WebSocketData>>; url: string } {
  const gs = new GameServer();
  const rtc = new RtcServer(gs);
  const server = Bun.serve<WebSocketData>({
    port: 0,
    websocket: {
      data: {} as WebSocketData,
      open(ws) { (ws.data.rtcs ? rtc : gs).onOpen(ws); },
      message(ws, m) { (ws.data.rtcs ? rtc : gs).onMessage(ws, m as string | ArrayBuffer); },
      close(ws) { (ws.data.rtcs ? rtc : gs).onClose(ws); },
      drain(ws) { if (!ws.data.rtcs) {gs.onDrain(ws);} },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      // Netbots fetch the room's field the way the browser does —
      // without this every bot falls back to heightmap.bin regardless
      // of the room's actual map, and mirror-vs-shadow sims diverge
      // tens of meters at every terrain contact.
      if (url.pathname.startsWith('/maps/')) {
        const f = Bun.file(new URL(`../../../maps/${decodeURIComponent(url.pathname.slice(6))}`, import.meta.url));
        return f.exists().then((ok) => (ok ? new Response(f) : new Response('nf', { status: 404 })));
      }
      if (url.pathname === '/ws' || url.pathname === '/rtcs') {
        if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtcs: url.pathname === '/rtcs' } })) {return undefined;}
        return new Response('upgrade failed', { status: 400 });
      }
      return new Response('nf', { status: 404 });
    },
  });
  gs.setBunServer(server);
  return { gs, server, url: `ws://127.0.0.1:${server.port}/ws` };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` every 250ms until true or the deadline passes — returns
 *  the outcome so the caller's expect() still fails the same way. Fixed
 *  sleep windows were the flake source: engagement timing varies wildly
 *  under CI scheduling while the property under test (claims resolve)
 *  is timing-independent. */
export const until = async (cond: () => boolean, maxMs: number): Promise<boolean> => {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (cond()) {return true;}
    await sleep(250);
  }
  return cond();
};

/** Starvation-aware `until`: while `progress()` keeps increasing the
 *  deadline extends by `extendMs` per check — a suite-starved bot still
 *  ticks, just slower, and punishing a slow start with a wall deadline
 *  was the wsFight flake. A genuine stall (no progress for extendMs)
 *  still fails at the base deadline; `hardCapMs` bounds total wait so a
 *  live-but-never-converging condition can't run past the test timeout. */
export const untilProgress = async (
  cond: () => boolean,
  progress: () => number,
  maxMs: number,
  opts: { extendMs?: number; hardCapMs?: number } = {},
): Promise<boolean> => {
  const extendMs = opts.extendMs ?? 4000;
  const hardCap = Date.now() + (opts.hardCapMs ?? maxMs * 2);
  const deadline = Date.now() + maxMs;
  let lastProgress = progress();
  let extendUntil = 0;
  while (Date.now() < Math.max(deadline, extendUntil) && Date.now() < hardCap) {
    if (cond()) {return true;}
    const p = progress();
    if (p > lastProgress) {
      lastProgress = p;
      extendUntil = Date.now() + extendMs;
    }
    await sleep(250);
  }
  return cond();
};

// node-datachannel resolves from server_bun/node_modules — injected into
// netbot's RTC transport rather than imported inside tools/.
export const nd = await import('node-datachannel').then((m) => ((m as { default?: NdModule }).default ?? m) as NdModule).catch(() => null);

export type SpawnOpts = { hopEveryMs?: number; transports?: ('ws' | 'rtc')[]; room?: string; mode?: string; bots?: number };

/** Per-test harness: one server + a bot roster, auto-torn-down by
 *  afterEach. Split files so ptest shards these wall-paced tests
 *  across processes instead of serializing them in one describe. */
export function mkNetbots(): {
  spawn: (n: number, link: LatencyOpts | LatencyOpts[], opts?: SpawnOpts) => Promise<void>;
  bots: { nc: NetClient; bot: NetBot }[];
  rejectsOf: () => string;
  totalRejects: () => number;
  sleep: typeof sleep;
  until: typeof until;
  untilProgress: typeof untilProgress;
  env: () => ReturnType<typeof bootServer> | null;
} {
  let env: ReturnType<typeof bootServer> | null = null;
  const nonce = Math.floor(Math.random() * 1e4).toString(36);
  const bots: { nc: NetClient; bot: NetBot }[] = [];

  afterEach(() => {
    for (const b of bots.splice(0)) { b.bot.stop(); b.nc.close(); }
    env?.server.stop(true);
    env?.gs.stop();
    env = null;
  });

  const spawn = async (n: number, link: LatencyOpts | LatencyOpts[], opts: SpawnOpts = {}) => {
    // NETBOT_URL override: drive the same scenarios at a REAL remote
    // server (tunnel soaks — LatencyLink still wraps the socket, so a
    // harsh-WAN profile stacks synthetic jitter on the true WAN path).
    const url = process.env.NETBOT_URL;
    if (!url) {env = bootServer();}
    for (let i = 0; i < n; i++) {
      const transport = opts.transports?.[i % opts.transports.length] ?? 'ws';
      // Kit and tier declared up front like a real loadout pick — the
      // squad-role weighting reads armorClass off roster entries.
      const lo = BOT_LOADOUTS[i % BOT_LOADOUTS.length]!;
      const li = Array.isArray(link) ? link[i % link.length]! : link;
      // Remote runs share one live server across runs — a parked seat from
      // a previous test still claims `nb_0`, so nonce the ids per HARNESS
      // (process.pid collides: every test file in a run shares it).
      const id = url ? `nb_${nonce}_${i}` : `nb_${i}`;
      const nc = new NetClient(url ?? env!.url, id, new LatencyLink(li), { transport, rtc: nd ? { nd } : undefined, room: opts.room, mode: opts.mode, bots: opts.bots, armorClass: botClassForLoadout(lo) });
      const bot = new NetBot(nc, { ...opts, loadout: lo });
      bots.push({ nc, bot });
      // Staggered connects — a burst of simultaneous socket opens made
      // some joins never land (silent ghost sockets), exactly the flake
      // a join-retry now papers over.
      await nc.connect();
      await sleep(60);
    }
    for (const b of bots) {b.bot.start();}
  };

  const rejectsOf = () => bots.map((b) => `${b.nc.id}: ${[...b.nc.tel.rejects.entries()].map(([r, n]) => `${r} x${n}`).join(', ') || 'none'}`).join(' | ');
  const totalRejects = () => bots.reduce((a, b) => a + [...b.nc.tel.rejects.values()].reduce((p, q) => p + q, 0), 0);

  return { spawn, bots, rejectsOf, totalRejects, sleep, until, untilProgress, env: () => env };
}
