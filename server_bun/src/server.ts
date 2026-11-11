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
import { matchResultsRoute } from './matchResults.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { adminRoute, clipRoute, corsResponse, demoRoute, leaderboardRoute, makeRoutes, mapBinRoute } from './serverRoutes.ts';
import { wallNow } from './wallClock.ts';
import type { ServerWebSocket } from 'bun';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));
// P2P signalling: /rtc sockets never touch GameServer — the relay just
// shuttles SDP/ICE between the two members of a room.
const rtcRelay = new RtcRelay();
// Server-peer WebRTC tier: /rtcs sockets carry signalling; the negotiated
// DataChannel is adapted onto GameServer as if it were a /ws socket.
const rtcServer = new RtcServer(gameServer);
const wtServer = new WtServer(gameServer);

// Native-shell volatile lane: raw UDP carrying seq'd binary frames
// (claims up, ticks down) for clients that expose the loopback shim.
// Off unless FPS_UDP_PORT is set — nothing else on the box needs it.
const udpPort = Number(process.env.FPS_UDP_PORT ?? 0);
if (udpPort > 0) {
  const { UdpLane } = await import('./UdpLane.ts');
  const lane = new UdpLane();
  await lane.listen(udpPort);
  gameServer.attachUdpLane(lane);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Proxied peers all read 127.0.0.1 — throttles/flood logs would key
// every client onto the proxy. Trust the LAST XFF hop only when the
// peer actually is loopback; a direct socket can spoof XFF.
function effClientIp(srv: { requestIP?(req: Request): { address?: string } | null }, req: Request): string | undefined {
  const peer = srv.requestIP?.(req)?.address;
  const xff = peer && LOOPBACK.has(peer) ? req.headers.get('x-forwarded-for') : null;
  return (xff ? xff.split(',').pop()!.trim() : undefined) ?? peer;
}
function wsUpgrade(srv: { upgrade(req: Request, opts: { data: WebSocketData }): boolean; requestIP?(req: Request): { address?: string } | null }, req: Request, data: WebSocketData): Response | undefined {
  data.clientIp = effClientIp(srv, req);
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

// Drain-deploys: /admin/drain arms the flag; once every human seat is
// empty the process exits so the new build takes over. 30s poll —
// drain is never urgent (the deploy waits on it, players don't).
setInterval((): void => {
  gameServer.afkSweep();
  if (gameServer.draining && gameServer.totalHumans() === 0) {
    void shutdown();
  }
}, 30_000).unref();



// EADDRINUSE here is almost always a bun --watch orphan holding the port
// after a crash — Windows never delivers SIGTERM to it. Reclaim only from
// bun.exe holders; anything else is a real conflict and stays untouched.
function killPortHolders(port: number): boolean {
  const out = Bun.spawnSync(['netstat', '-ano', '-p', 'tcp']).stdout.toString();
  const pids = [...out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gm)]
    .filter((m): boolean => Number(m[1]) === port).map((m): string => m[2]!);
  for (const pid of pids) {
    const img = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout.toString();
    // Same race as the UDP variant: dead-between-netstat-and-tasklist
    // reads empty — skip it, don't refuse.
    if (!img.trim()) {continue;}
    if (!/bun\.exe/i.test(img)) { logger.error(`:${port} held by non-bun pid ${pid} — refusing to kill`); return false; }
    Bun.spawnSync(['taskkill', '/F', '/PID', pid]);
    logger.warn(`stale bun (pid ${pid}) killed — it held :${port}`);
  }
  if (pids.length > 0) {Bun.sleepSync(250);} // let the socket fully release
  return pids.length > 0;
}

/** UDP sibling of killPortHolders — the WT QUIC listener can't be probed
 *  like /metrics, so the same bun.exe-only guard stands in: a bun holding
 *  OUR wt port while another process owns the game port is an orphan. */
function killUdpPortHolders(port: number): boolean {
  const out = Bun.spawnSync(['netstat', '-ano', '-p', 'udp']).stdout.toString();
  const pids = [...out.matchAll(/^\s*UDP\s+\S+:(\d+)\s+\S+\s+(\d+)\s*$/gm)]
    .filter((m): boolean => Number(m[1]) === port).map((m): string => m[2]!);
  for (const pid of pids) {
    const img = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout.toString();
    // Race: a pid that died between netstat and tasklist returns empty —
    // nothing to kill, but it's no reason to refuse the reclaim either.
    if (!img.trim()) {continue;}
    if (!/bun\.exe/i.test(img)) { logger.error(`udp:${port} held by non-bun pid ${pid} — refusing to kill`); return false; }
    Bun.spawnSync(['taskkill', '/F', '/PID', pid]);
    logger.warn(`stale bun (pid ${pid}) killed — it held udp:${port}`);
  }
  if (pids.length > 0) {Bun.sleepSync(250);}
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

// Shared options shape: the primary plaintext listener and the opt-in
// direct-TLS listener (FPS_TLS_PORT) dispatch the same sockets into the
// same GameServer - only port + tls differ.
const serveOpts = {
  hostname: '0.0.0.0',
  idleTimeout: CONFIG.idleTimeoutSec,

  websocket: {
    data: {} as WebSocketData,
    maxPayloadLength: CONFIG.maxPayloadLength,

    open(ws: ServerWebSocket<WebSocketData>): void {
      if (ws.data.rtc) { rtcRelay.onOpen(ws); return; }
      if (ws.data.rtcs) { rtcServer.onOpen(ws); return; }
      gameServer.onOpen(ws);
    },

    message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer<ArrayBuffer>): void {
      if (ws.data.rtc) { rtcRelay.onMessage(ws, message as string | ArrayBuffer); return; }
      if (ws.data.rtcs) { rtcServer.onMessage(ws, message as string | ArrayBuffer); return; }
      gameServer.onMessage(ws, message as string | ArrayBuffer);
    },

    close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string): void {
      if (ws.data.rtc) { rtcRelay.onClose(ws); return; }
      if (ws.data.rtcs) { rtcServer.onClose(ws); return; }
      gameServer.onClose(ws, code, reason);
    },

    drain(ws: ServerWebSocket<WebSocketData>): void {
      if (ws.data.rtc || ws.data.rtcs) {return;}
      gameServer.onDrain(ws);
    },
  },

  async fetch(req: Request, srv: Bun.Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return corsResponse(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      // Per-IP cap on unseated sockets: the kernel SYN rate bounds the
      // connection RATE but not the held count; a source riding under it
      // could still park hundreds of pending joins. Seated sockets are
      // exempt (LAN cafes share an IP and join legitimately).
      if (!gameServer.unseatAllow(effClientIp(srv, req))) {return corsResponse('Too many pending joins', { status: 429 });}
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
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return corsResponse('loopback only', { status: 403 });
      }
      // Tunnels (cloudflared/ngrok) forward remote traffic AS loopback —
      // without the token, any tunnel visitor gets a free server restart.
      // Unset token = closed to strangers, same rule as /admin/*.
      if (CONFIG.adminToken && url.searchParams.get('key') !== CONFIG.adminToken) {
        return corsResponse('unauthorized', { status: 401 });
      }
      setImmediate((): Promise<void> => shutdown());
      return corsResponse('shutting down', { status: 200 });
    }

    const route = ROUTES[url.pathname];
    if (route) {return route(url, req);}

    // Prefix routes — path carries params (admin query args, demo filename).
    if (url.pathname.startsWith('/admin/')) {return adminRoute(httpCtx, req, url);}
    if (url.pathname.startsWith('/demos/')) {return demoRoute(httpCtx, req, url);}
    if (url.pathname.startsWith('/leaderboard') || url.pathname === '/challenge') {return leaderboardRoute(httpCtx, req, url);}
    // Clip-feed deep links — OG card for crawlers, refresh into the client.
    if (url.pathname === '/clips' || url.pathname.startsWith('/clips/')) {
      return clipRoute(httpCtx, url);
    }
    if (url.pathname.startsWith('/maps/')) {return mapBinRoute(url);}
    if (url.pathname === '/client-log' && req.method === 'POST') {
      return clientLogRoute(req, corsResponse, srv.requestIP(req)?.address ?? '');
    }

    if (url.pathname === '/results' && req.method === 'POST') {
      return matchResultsRoute(req, corsResponse);
    }

    return corsResponse('Not found', { status: 404 });
  },
};

const serve = (): ReturnType<typeof Bun.serve<WebSocketData>> =>
  Bun.serve<WebSocketData>({ port: CONFIG.port, ...serveOpts });

// The reclaim probe is async but no-async-await is repo law — the bind
// runs as a flat promise chain and `server` stays a late-bound handle
// every consumer (requestIP, setBunServer) only reaches after bind.
// Bounded retry: a supervised predecessor mid-drain still answers
// /metrics (reclaim refuses, correctly) but its socket frees ~1s out —
// dying on the first EADDRINUSE is what spiraled the respawn loop.
let server: ReturnType<typeof serve> | null = null;
const tryServe = (attempt: number): Promise<ReturnType<typeof serve>> =>
  Promise.resolve()
    .then((): ReturnType<typeof serve> => serve())
    .catch((error: unknown): Promise<ReturnType<typeof serve>> => {
      const busy = (error as { code?: string }).code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(String(error));
      if (!busy || attempt >= 4) {throw error;}
      return reclaimStaleBun(CONFIG.port).then((ok): Promise<ReturnType<typeof serve>> =>
        ok ? tryServe(attempt + 1)
          : Bun.sleep(600).then((): Promise<ReturnType<typeof serve>> => tryServe(attempt + 1)));
    });
tryServe(0)
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
    const usingDevCert = !CONFIG.wtCertPath;
    const certPath = CONFIG.wtCertPath || `${import.meta.dir}/../certs/dev.crt`;
    const keyPath = CONFIG.wtKeyPath || `${import.meta.dir}/../certs/dev.key`;
    if (!fileExists(certPath) || !fileExists(keyPath)) {
      logger.warn('WebTransport disabled — no cert/key (env or certs/dev.*)', {});
    } else {
    // Chrome pins only certs that are valid AND ≤14-day-lived, so the dev
    // pair is minted 13-day — and silently bricks the WT tier every two
    // weeks when it lapses. Dev pair only: regen at <48h to expiry so an
    // unchecked-in week never degrades the ladder to bare WS again.
    if (usingDevCert) {
      const validTo = new Date(new X509Certificate(rf(certPath, 'utf8')).validTo).getTime();
      if (validTo - Date.now() < 48 * 3600 * 1000) {
        const { spawnSync } = await import('node:child_process');
        // EC + CA:FALSE are load-bearing — Chrome refuses
        // serverCertificateHashes on RSA and CA certs; openssl req -x509
        // defaults RSA + CA:TRUE, exactly the rejection we hit.
        const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', keyPath, '-out', certPath, '-days', '13', '-nodes', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1', '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'pipe' });
        if (r.status === 0) {logger.info('WebTransport dev cert regenerated (was expiring <48h)', { validTo });}
        else {logger.warn('WebTransport dev cert expiring but regen failed — WT tier will degrade', { validTo, stderr: String(r.stderr) });}
      }
    }
    const certPem = rf(certPath, 'utf8');
    // DER hash is what serverCertificateHashes expects — PEM is just the
    // base64 wrapper, so decode via X509Certificate to get the raw bytes.
    const wtOpts = { port: CONFIG.wtPort, certPem, keyPem: rf(keyPath, 'utf8') };
    // AddrInUse = an orphaned child squatting the QUIC port (the TCP
    // squatter-killer can't see UDP). Reclaim from bun.exe holders, retry once.
    let wtOk = await wtServer.start(wtOpts);
    if (!wtOk && killUdpPortHolders(CONFIG.wtPort)) {wtOk = await wtServer.start(wtOpts);}
    // Advertise only a live bind — a failed start leaving the hash set
    // makes /wthash point clients at a dead UDP port (the flap-era
    // ERR_CONNECTION_RESET churn that looked like a transport bug).
    if (wtOk) {wtCertHash = createHash('sha256').update(new X509Certificate(certPem).raw).digest('base64');}
    }
  } catch (error) {
    logger.warn('WebTransport disabled — cert/key unreadable', { error: (error as Error).message });
  }
}

// Direct wss tier - opt-in via env (FPS_TLS_PORT + cert/key paths): a
// second listener on the same handlers with TLS inside uWS, so game
// frames skip the Caddy decrypt/proxy hop entirely (bench: ~0.9 core
// on the A1). Matchmaker/metrics keep Caddy; this only adds a port.
// Failures are logged-and-continue like the WT tier.
let directTlsPort = 0;
if (CONFIG.tlsCertPath || CONFIG.tlsKeyPath) {
  try {
    const { existsSync: fileExists, statSync } = await import('node:fs');
    const certPath = CONFIG.tlsCertPath;
    const keyPath = CONFIG.tlsKeyPath;
    if (!certPath || !keyPath || !fileExists(certPath) || !fileExists(keyPath)) {
      logger.warn('Direct TLS disabled - FPS_TLS_CERT/KEY unset or unreadable', { certPath, keyPath });
    } else {
      const bindTls = (): ReturnType<typeof Bun.serve<WebSocketData>> | null => {
        try {
          return Bun.serve<WebSocketData>({
            port: CONFIG.tlsPort,
            tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
            ...serveOpts,
          });
        } catch (error) {
          logger.warn('Direct TLS bind failed', { error: (error as Error).message });
          return null;
        }
      };
      let tlsServer = bindTls();
      // uWS publish is per-server: a topic subscriber only hears publishes
      // issued through ITS listener's server object. Register this
      // listener's publish alongside the primary's or TLS clients (the
      // ones /join advertises) silently lose every async broadcast.
      let tlsPublish: ((topic: string, data: string | Uint8Array) => void) | null = null;
      const registerTlsPublish = (): void => {
        if (tlsPublish) {ConnectionManager.publishFns.delete(tlsPublish); tlsPublish = null;}
        const srv = tlsServer;
        if (!srv) {return;}
        tlsPublish = (topic: string, data: string | Uint8Array): void => { srv.publish(topic, data as string | Uint8Array<ArrayBuffer>); };
        ConnectionManager.publishFns.add(tlsPublish);
      };
      registerTlsPublish();
      directTlsPort = tlsServer?.port ?? 0;
      if (tlsServer) {logger.info('Direct wss listener up', { port: directTlsPort });}
      // Cert renewal watch: the ACME pair rotates (~60d) and Bun reads
      // PEM at bind only - rebind on mtime change or the listener would
      // keep serving the expired cert until restart. Rebind drops live
      // TLS sockets; clients ride the normal reconnect chain.
      let certMtime = statSync(certPath).mtimeMs;
      setInterval((): void => {
        let m: number;
        try { m = statSync(certPath).mtimeMs; } catch { return; } // mid-rotation file gap
        if (m !== certMtime) {
          certMtime = m;
          tlsServer?.stop(true).catch((): void => { /* cert-rotation retry owns the outcome */ });
          tlsServer = null;
        }
        if (!tlsServer) {
          tlsServer = bindTls();
          registerTlsPublish();
          directTlsPort = tlsServer?.port ?? 0;
          if (tlsServer) {logger.info('Direct wss listener bound', { port: directTlsPort, renew: true });}
        }
      }, 60_000).unref();
    }
  } catch (error) {
    logger.warn('Direct TLS listener failed', { error: (error as Error).message });
  }
}

// Boot banner bypasses the log level — a server that prints nothing looks
// dead. It's once-per-process, so it can never add to the chatter floor.
// oxlint-disable-next-line no-console
console.log(`\x1b[32m\x1b[1mFPS Bun Server started port=${CONFIG.port} tick=${CONFIG.tickRate} maxPlayers=${CONFIG.maxPlayers} respawnMs=${CONFIG.respawnDelayMs}\x1b[0m`);
// oxlint-disable-next-line no-console
console.log(`\x1b[32mWebSocket: ws://localhost:${CONFIG.port}/ws`);
// oxlint-disable-next-line no-console
console.log(`Health:    http://localhost:${CONFIG.port}/health`);
// oxlint-disable-next-line no-console
console.log(`RTC relay: ws://localhost:${CONFIG.port}/rtc?room=CODE\x1b[0m`);
// No admin token = ops surfaces (/metrics /wire /weaponstats /status)
// are WIDE OPEN — fine for dev, dangerous if a real deploy forgot the
// env. Scream at boot so a misconfig can't ship silently.
// oxlint-disable-next-line no-console
if (!CONFIG.adminToken) {console.log('\x1b[33mWARN: FPS_ADMIN_TOKEN unset — ops endpoints (/metrics /wire /status /weaponstats) are OPEN to anyone who can reach the port\x1b[0m');}

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
        tlsPort: directTlsPort || undefined,
        draining: gameServer.draining || undefined,
        ccu: rooms.reduce((n, r): number => n + r.playerCount() + r.spectators.size, 0),
        rooms: rooms.map((r): string => r.name),
        list: gameServer.listRooms(true),
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
  shutdown().catch((): void => { /* finally exits regardless */ });
});

process.on('SIGTERM', (): void => {
  logger.info('SIGTERM received, shutting down...');
  shutdown().catch((): void => { /* finally exits regardless */ });
});
