import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { RtcRelay } from './RtcRelay.ts';
import { RtcServer } from './RtcServer.ts';
import { WtServer } from './WtServer.ts';
import { join } from 'node:path';
import { clientLogRoute, rotateLogs } from './clientLogs.ts';
import { adminRoute, clipRoute, corsResponse, demoRoute, makeRoutes, mapBinRoute } from './serverRoutes.ts';
import { wallNow } from './wallClock.ts';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));
// P2P signalling: /rtc sockets never touch GameServer — the relay just
// shuttles SDP/ICE between the two members of a room.
const rtcRelay = new RtcRelay();
// Server-peer WebRTC tier: /rtcs sockets carry signalling; the negotiated
// DataChannel is adapted onto GameServer as if it were a /ws socket.
const rtcServer = new RtcServer(gameServer);
const wtServer = new WtServer(gameServer);

function wsUpgrade(srv: { upgrade(req: Request, opts: { data: WebSocketData }): boolean }, req: Request, data: WebSocketData): Response | undefined {
  if (srv.upgrade(req, { data })) {return undefined;}
  return new Response('Upgrade failed', { status: 400 });
}

// Dev-watch seat carryover: the watcher holds one blob in memory — a
// restart restores seats so reconnecting players land where they were.
// Production never sets FPS_STATE_URL; this lane is dev-only by env.
const stateUrl = process.env.FPS_STATE_URL;
if (stateUrl) {
  try {
    const res = await fetch(stateUrl, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {gameServer.restoreFrom(await res.json());}
  } catch { /* watcher not serving — clean boot */ }
}

rotateLogs();

let wtCertHash: string | null = null;
// requestIP binds lazily — `server` doesn't exist until Bun.serve below
// returns, but no request can arrive before that.
// oxlint-disable-next-line no-use-before-define -- lazily bound, see comment above
const httpCtx = { gameServer, demoStorage, rtcRelay, wtCertHash: (): string | null => wtCertHash, requestIP: (req: Request): Bun.SocketAddress | null => server?.requestIP(req) ?? null };
const ROUTES = makeRoutes(httpCtx);

// Let the close frames flush before exiting: an immediate process.exit
// kills the sockets mid-handshake and players see a drop, not 1001.
// The loop drains on its own once the server socket is down; the
// fallback timer force-exits if a straggler socket lingers.
async function shutdown(): Promise<void> {
  try {
    // Snapshot seats BEFORE stop() closes sockets — the restore is only
    // useful if it still names live players. Awaited and abort-bounded:
    // the handoff must land before exit, or there's nothing to hand off.
    if (stateUrl) {
      try {
        await fetch(stateUrl, {
          method: 'PUT',
          body: JSON.stringify(gameServer.exportRestore()),
          signal: AbortSignal.timeout(400),
        });
      } catch { /* watcher gone — nothing to hand off */ }
    }
    gameServer.stop();
  } finally {
    // Exit is the contract — a handoff/stop failure must still die.
    setTimeout((): never => process.exit(0), 500).unref();
  }
}



// EADDRINUSE here is almost always a bun --watch orphan holding the port
// after a crash — Windows never delivers SIGTERM to it. Reclaim only from
// bun.exe holders; anything else is a real conflict and stays untouched.
function killPortHolders(port: number): boolean {
  const out = Bun.spawnSync(['netstat', '-ano', '-p', 'tcp']).stdout.toString();
  const pids = [...out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gm)]
    .filter((m) => Number(m[1]) === port).map((m) => m[2]!);
  for (const pid of pids) {
    const img = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout.toString();
    if (!/bun\.exe/i.test(img)) { logger.error(`:${port} held by non-bun pid ${pid} — refusing to kill`); return false; }
    Bun.spawnSync(['taskkill', '/F', '/PID', pid]);
    logger.warn(`stale bun (pid ${pid}) killed — it held :${port}`);
  }
  if (pids.length > 0) {Bun.sleepSync(250);} // let the socket fully release
  return pids.length > 0;
}

function reclaimStaleBun(port: number): Promise<boolean> {
  // A live supervised server (dev-watch respawns children instantly) is
  // not "stale" — killing it is whack-a-mole we'd lose. Stale means the
  // port is held but the game doesn't answer.
  return fetch(`http://localhost:${port}/metrics`, { signal: AbortSignal.timeout(800) }).then(
    (r): boolean => {
      if (r.ok) { logger.error(`:${port} serves a live game server — not stale, refusing takeover`); return false; }
      return killPortHolders(port);
    },
    (): boolean => killPortHolders(port), // not answering = the zombie we reclaim
  );
}

const serve = (): ReturnType<typeof Bun.serve<WebSocketData>> => Bun.serve<WebSocketData>({
  port: CONFIG.port,
  hostname: '0.0.0.0',
  idleTimeout: CONFIG.idleTimeoutSec,

  websocket: {
    data: {} as WebSocketData,
    maxPayloadLength: CONFIG.maxPayloadLength,

    open(ws): void {
      if (ws.data.rtc) { rtcRelay.onOpen(ws); return; }
      if (ws.data.rtcs) { rtcServer.onOpen(ws); return; }
      gameServer.onOpen(ws);
    },

    message(ws, message): void {
      if (ws.data.rtc) { rtcRelay.onMessage(ws, message as string | ArrayBuffer); return; }
      if (ws.data.rtcs) { rtcServer.onMessage(ws, message as string | ArrayBuffer); return; }
      gameServer.onMessage(ws, message as string | ArrayBuffer);
    },

    close(ws): void {
      if (ws.data.rtc) { rtcRelay.onClose(ws); return; }
      if (ws.data.rtcs) { rtcServer.onClose(ws); return; }
      gameServer.onClose(ws);
    },

    drain(ws): void {
      if (ws.data.rtc || ws.data.rtcs) {return;}
      gameServer.onDrain(ws);
    },
  },

  async fetch(req, srv): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      return wsUpgrade(srv, req, { playerId: '', connectedAt: wallNow() });
    }

    // P2P signalling: /rtc?room=CODE — two sockets per room, opaque relay.
    if (url.pathname === '/rtc') {
      const room = url.searchParams.get('room') ?? '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
        return new Response('Bad room', { status: 400 });
      }
      const open = url.searchParams.get('open') === '1';
      return wsUpgrade(srv, req, { playerId: '', connectedAt: wallNow(), rtc: true, room, open });
    }

    // Server-peer WebRTC signalling: /rtcs — one shot offer/answer, then
    // the DataChannel becomes the game socket.
    if (url.pathname === '/rtcs') {
      return wsUpgrade(srv, req, { playerId: '', connectedAt: wallNow(), rtcs: true });
    }

    // Dev-watch graceful door: Windows kill() is TerminateProcess — no
    // SIGTERM reaches the child, so restart would hard-drop every socket
    // (1006, silent). Loopback-only: the caller asks, we run the normal
    // shutdown() — players get their 'server restarting' close frames.
    if (url.pathname === '/dev/shutdown') {
      const ip = srv.requestIP(req)?.address;
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        setImmediate((): Promise<void> => shutdown());
        return corsResponse('shutting down', { status: 200 });
      }
      return corsResponse('loopback only', { status: 403 });
    }

    const route = ROUTES[url.pathname];
    if (route) {return route(url, req);}

    // Prefix routes — path carries params (admin query args, demo filename).
    if (url.pathname.startsWith('/admin/')) {return adminRoute(httpCtx, req, url);}
    if (url.pathname.startsWith('/demos/')) {return demoRoute(httpCtx, req, url);}
    // Clip-feed deep links — OG card for crawlers, refresh into the client.
    if (url.pathname === '/clips' || url.pathname.startsWith('/clips/')) {
      return clipRoute(httpCtx, url);
    }
    if (url.pathname.startsWith('/maps/')) {return mapBinRoute(url);}
    if (url.pathname === '/client-log' && req.method === 'POST') {
      return clientLogRoute(req, corsResponse, srv.requestIP(req)?.address ?? '');
    }

    return corsResponse('Not found', { status: 404 });
  },
});

// The reclaim probe is async but no-async-await is repo law — the bind
// runs as a flat promise chain and `server` stays a late-bound handle
// every consumer (requestIP, setBunServer) only reaches after bind.
let server: ReturnType<typeof serve> | null = null;
let bindErr: Error | null = null;
Promise.resolve()
  .then((): ReturnType<typeof serve> => serve())
  .catch((error: unknown): Promise<boolean> => {
    const busy = (error as { code?: string }).code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(String(error));
    if (!busy) {throw error;}
    bindErr = error instanceof Error ? error : new Error(String(error));
    return reclaimStaleBun(CONFIG.port);
  })
  .then((v): ReturnType<typeof serve> => {
    if (typeof v !== 'boolean') {return v;}
    if (!v) {throw bindErr;}
    return serve();
  })
  .then((s): null => { server = s; gameServer.setBunServer(s); return null; })
  .catch((error): never => { throw error; }); // unhandled rejection = the module-level throw it replaces

// WebTransport tier — opt-in via env (FPS_WT_PORT + cert/key paths).
// Shares GameServer through the socket adapter; failure here must never
// stop the WS game, so all errors are logged-and-continue inside start().
if (CONFIG.wtPort > 0) {
  try {
    const { readFileSync: rf, existsSync: fileExists } = await import('node:fs');
    const { createHash, X509Certificate } = await import('node:crypto');
    // Dev convenience: a checked-in certs/dev.{crt,key} pair means "WT on"
    // without env wiring — certs/ is dev-only self-signed anyway.
    const certPath = CONFIG.wtCertPath || `${import.meta.dir}/../certs/dev.crt`;
    const keyPath = CONFIG.wtKeyPath || `${import.meta.dir}/../certs/dev.key`;
    if (!fileExists(certPath) || !fileExists(keyPath)) {
      logger.warn('WebTransport disabled — no cert/key (env or certs/dev.*)', {});
    } else {
    const certPem = rf(certPath, 'utf8');
    // DER hash is what serverCertificateHashes expects — PEM is just the
    // base64 wrapper, so decode via X509Certificate to get the raw bytes.
    wtCertHash = createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64');
    wtServer.start({
      port: CONFIG.wtPort,
      certPem,
      keyPem: rf(keyPath, 'utf8'),
    });
    }
  } catch (error) {
    logger.warn('WebTransport disabled — cert/key unreadable', { error: (error as Error).message });
  }
}

// Boot banner bypasses the log level — a server that prints nothing looks
// dead. It's once-per-process, so it can never add to the chatter floor.
// oxlint-disable-next-line no-console
console.log(`FPS Bun Server started port=${CONFIG.port} tick=${CONFIG.tickRate} maxPlayers=${CONFIG.maxPlayers} respawnMs=${CONFIG.respawnDelayMs}`);
// oxlint-disable-next-line no-console
console.log(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
// oxlint-disable-next-line no-console
console.log(`Health:    http://localhost:${CONFIG.port}/health`);
// oxlint-disable-next-line no-console
console.log(`RTC relay: ws://localhost:${CONFIG.port}/rtc?room=CODE`);

// Fleet worker heartbeat — under fleet.ts this process is one of N
// children; the matchmaker tracks room homes + per-worker ccu off these
// beats and serves the aggregated /rooms lobby list from `list`.
const fleetReport = process.env.FPS_FLEET_REPORT;
if (fleetReport) {
  setInterval((): void => {
    const rooms = [...gameServer.rooms.values()];
    fetch(fleetReport, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: CONFIG.port,
        ccu: rooms.reduce((n, r): number => n + r.playerCount() + r.spectators.size, 0),
        rooms: rooms.map((r): string => r.name),
        list: gameServer.listRooms(),
      }),
    }).catch((): void => { /* matchmaker restarting — the next beat retries */ });
  }, 2000);
}

// Last-resort catches: a stray timer callback (killFeed taunts, grace
// sweeps) or a rejected promise must not drop every player in every room.
// Room ticks have their own finer quarantine — whatever reaches here
// bypassed it, so log at error level rather than swallowing silently.
process.on('unhandledRejection', (reason): void => {
  logger.error('Unhandled rejection (process survived)', { err: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
process.on('uncaughtException', (e): void => {
  logger.error('Uncaught exception (process survived)', { err: e.stack ?? e.message });
});

process.on('SIGINT', (): void => {
  logger.info('SIGINT received, shutting down...');
  shutdown();
});

process.on('SIGTERM', (): void => {
  logger.info('SIGTERM received, shutting down...');
  shutdown();
});
