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
  if (srv.upgrade(req, { data })) return undefined;
  return new Response('Upgrade failed', { status: 400 });
}

rotateLogs();

let wtCertHash: string | null = null;
// requestIP binds lazily — `server` doesn't exist until Bun.serve below
// returns, but no request can arrive before that.
const httpCtx = { gameServer, demoStorage, rtcRelay, wtCertHash: () => wtCertHash, requestIP: (req: Request) => server.requestIP(req) };
const ROUTES = makeRoutes(httpCtx);

const server = Bun.serve<WebSocketData>({
  port: CONFIG.port,
  hostname: '0.0.0.0',
  idleTimeout: CONFIG.idleTimeoutSec,

  websocket: {
    data: {} as WebSocketData,
    maxPayloadLength: CONFIG.maxPayloadLength,

    open(ws) {
      if (ws.data.rtc) { rtcRelay.onOpen(ws); return; }
      if (ws.data.rtcs) { rtcServer.onOpen(ws); return; }
      gameServer.onOpen(ws);
    },

    message(ws, message) {
      if (ws.data.rtc) { rtcRelay.onMessage(ws, message as string | ArrayBuffer); return; }
      if (ws.data.rtcs) { rtcServer.onMessage(ws, message as string | ArrayBuffer); return; }
      gameServer.onMessage(ws, message as string | ArrayBuffer);
    },

    close(ws) {
      if (ws.data.rtc) { rtcRelay.onClose(ws); return; }
      if (ws.data.rtcs) { rtcServer.onClose(ws); return; }
      gameServer.onClose(ws);
    },

    drain(ws) {
      if (ws.data.rtc || ws.data.rtcs) return;
      gameServer.onDrain(ws);
    },
  },

  async fetch(req, srv) {
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

    const route = ROUTES[url.pathname];
    if (route) return route(url, req);

    // Prefix routes — path carries params (admin query args, demo filename).
    if (url.pathname.startsWith('/admin/')) return adminRoute(httpCtx, req, url);
    if (url.pathname.startsWith('/demos/')) return demoRoute(httpCtx, req, url);
    // Clip-feed deep links — OG card for crawlers, refresh into the client.
    if (url.pathname === '/clips' || url.pathname.startsWith('/clips/')) {
      return clipRoute(httpCtx, url);
    }
    if (url.pathname.startsWith('/maps/')) return mapBinRoute(url);
    if (url.pathname === '/client-log' && req.method === 'POST') {
      return clientLogRoute(req, corsResponse, srv.requestIP(req)?.address ?? '');
    }

    return corsResponse('Not found', { status: 404 });
  },
});

gameServer.setBunServer(server);

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
    void wtServer.start({
      port: CONFIG.wtPort,
      certPem,
      keyPem: rf(keyPath, 'utf8'),
    });
    }
  } catch (e) {
    logger.warn('WebTransport disabled — cert/key unreadable', { error: (e as Error).message });
  }
}

// Boot banner bypasses the log level — a server that prints nothing looks
// dead. It's once-per-process, so it can never add to the chatter floor.
console.log(`FPS Bun Server started port=${CONFIG.port} tick=${CONFIG.tickRate} maxPlayers=${CONFIG.maxPlayers} respawnMs=${CONFIG.respawnDelayMs}`);
console.log(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
console.log(`Health:    http://localhost:${CONFIG.port}/health`);
console.log(`RTC relay: ws://localhost:${CONFIG.port}/rtc?room=CODE`);

// Last-resort catches: a stray timer callback (killFeed taunts, grace
// sweeps) or a rejected promise must not drop every player in every room.
// Room ticks have their own finer quarantine — whatever reaches here
// bypassed it, so log at error level rather than swallowing silently.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection (process survived)', { err: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});
process.on('uncaughtException', (e) => {
  logger.error('Uncaught exception (process survived)', { err: e.stack ?? e.message });
});

// Let the close frames flush before exiting: an immediate process.exit
// kills the sockets mid-handshake and players see a drop, not 1001.
// The loop drains on its own once the server socket is down; the
// fallback timer force-exits if a straggler socket lingers.
function shutdown(): void {
  gameServer.stop();
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  shutdown();
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  shutdown();
});
