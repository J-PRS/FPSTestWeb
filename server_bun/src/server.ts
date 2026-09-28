import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { RtcRelay } from './RtcRelay.ts';
import { RtcServer } from './RtcServer.ts';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));
// P2P signalling: /rtc sockets never touch GameServer — the relay just
// shuttles SDP/ICE between the two members of a room.
const rtcRelay = new RtcRelay();
// Server-peer WebRTC tier: /rtcs sockets carry signalling; the negotiated
// DataChannel is adapted onto GameServer as if it were a /ws socket.
const rtcServer = new RtcServer(gameServer);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body: BodyInit | null, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data: unknown, init?: ResponseInit) =>
  corsResponse(JSON.stringify(data), { ...init, headers: JSON_HEADERS });

// Plain GET endpoints — a new JSON route is one table entry.
const ROUTES: Record<string, (url: URL) => Response | Promise<Response>> = {
  '/': () => json(gameServer.getHealthStatus()),
  '/health': () => json(gameServer.getHealthStatus()),
  // Ops metrics — uptime, players, balls, tick-lag stats.
  '/metrics': () => json(gameServer.getMetrics()),
  // Server-browser card — identity + occupancy for master lists / LAN.
  '/serverinfo': () => json(gameServer.getServerInfo()),
  // Lobby browse — live matches with occupancy.
  '/rooms': () => json(gameServer.listRooms()),
  // Match history ring (also journaled to logs/matches.jsonl).
  '/matches': () => json(gameServer.listMatches()),
  // Lifetime per-player aggregates off the match journal.
  '/stats': async () => json(await gameServer.getStats()),
  // Quick-join: /join?mode=ctf → emptiest live match of a mode.
  '/join': (url) => {
    const mode = url.searchParams.get('mode') ?? '';
    if (!/^[a-z0-9_-]{0,16}$/.test(mode)) {
      return corsResponse('Bad mode', { status: 400 });
    }
    const room = gameServer.quickRoom(mode);
    return json({ room: room.name, mode: room.mode });
  },
};

// Admin API — bearer-token guarded (FPS_ADMIN_TOKEN). Unset = closed.
//   POST /admin/reload?room=X   re-read maps/X.json into the live room
//   POST /admin/kick?player=X   boot a player
//   POST /admin/end?room=X      force-end the match (leader wins)
//   GET  /admin/rooms           detailed live dump
function adminRoute(req: Request, url: URL): Response {
  const want = CONFIG.adminToken;
  if (!want) return corsResponse('admin disabled (FPS_ADMIN_TOKEN unset)', { status: 403 });
  const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '');
  if (got !== want) return corsResponse('unauthorized', { status: 401 });

  if (url.pathname === '/admin/rooms' && req.method === 'GET') {
    return json(gameServer.listRooms());
  }
  if (req.method !== 'POST') return corsResponse('POST only', { status: 405 });

  const ADMIN_ACTIONS: Record<string, () => Response> = {
    '/admin/reload': () => {
      const r = gameServer.reloadRoom(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
    '/admin/kick': () => {
      const ok = gameServer.kickPlayer(url.searchParams.get('player') ?? '');
      return json({ ok }, { status: ok ? 200 : 404 });
    },
    '/admin/end': () => {
      const r = gameServer.forceEndMatch(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
  };
  return ADMIN_ACTIONS[url.pathname]?.() ?? corsResponse('Unknown admin route', { status: 404 });
}

// Demo endpoints: POST /demos/upload, GET /demos/:filename.
// (GET /demos is an exact-path route, handled in ROUTES below.)
async function demoRoute(req: Request, url: URL): Promise<Response> {
  if (url.pathname === '/demos/upload' && req.method === 'POST') {
    try {
      // Reject oversized uploads before buffering the body — clips are
      // ~seconds of binary frames, 16MB is a generous ceiling
      const contentLength = Number(req.headers.get('content-length') ?? 0);
      if (contentLength > 16 * 1024 * 1024) {
        return json({ success: false, error: 'Upload too large' }, { status: 413 });
      }
      const body = await req.arrayBuffer();
      if (body.byteLength > 16 * 1024 * 1024) {
        return json({ success: false, error: 'Upload too large' }, { status: 413 });
      }
      logger.info('Demo upload received', { size: body.byteLength });
      const meta = await demoStorage.saveDemo(body);
      if (!meta.filename) {
        return json({ success: false, rejected: true, reason: 'Below minimum lifetime' });
      }
      return json({ success: true, ...meta });
    } catch (e) {
      logger.warn('Demo upload failed', { error: (e as Error).message });
      return json({ success: false, error: (e as Error).message }, { status: 500 });
    }
  }

  if (req.method === 'GET') {
    const filename = url.pathname.slice('/demos/'.length);
    if (filename === 'upload' || filename === '') {
      return corsResponse('Not found', { status: 404 });
    }
    const data = await demoStorage.loadDemo(filename);
    if (!data) {
      logger.info('Demo download not found', { filename });
      return corsResponse('Not found', { status: 404 });
    }
    logger.info('Demo downloaded', { filename, size: data.byteLength });
    return corsResponse(data, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  return corsResponse('Not found', { status: 404 });
}

ROUTES['/demos'] = async () => {
  const list = await demoStorage.listDemos();
  logger.info('Demo list requested', { count: list.length, top: list[0]?.projectileLifetime.toFixed(2) ?? 'none' });
  return json({ demos: list });
};

const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');

// Client log shipping: POST /client-log — appended to logs/client.log.
// Bodies are plain text lines (WARN/ERROR only by client convention).
// Lines also fan out by level: client_warning.log / client_error.log.
async function clientLogRoute(req: Request): Promise<Response> {
  try {
    const body = await req.text();
    if (body.length > 512 * 1024) {
      return corsResponse('Too large', { status: 413 });
    }
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, 'client.log'), body);
    const warnLines: string[] = [];
    const errLines: string[] = [];
    for (const line of body.split('\n')) {
      if (!line) continue;
      if (line.includes('[ERROR]')) errLines.push(line);
      else if (line.includes('[WARN]')) warnLines.push(line);
    }
    if (warnLines.length) appendFileSync(join(LOGS_DIR, 'client_warning.log'), warnLines.join('\n') + '\n');
    if (errLines.length) appendFileSync(join(LOGS_DIR, 'client_error.log'), errLines.join('\n') + '\n');
    return corsResponse('ok');
  } catch (e) {
    logger.warn('Client log append failed', { error: (e as Error).message });
    return corsResponse('append failed', { status: 500 });
  }
}

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
      if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now() } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    // P2P signalling: /rtc?room=CODE — two sockets per room, opaque relay.
    if (url.pathname === '/rtc') {
      const room = url.searchParams.get('room') ?? '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
        return new Response('Bad room', { status: 400 });
      }
      if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtc: true, room } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    // Server-peer WebRTC signalling: /rtcs — one shot offer/answer, then
    // the DataChannel becomes the game socket.
    if (url.pathname === '/rtcs') {
      if (srv.upgrade(req, { data: { playerId: '', connectedAt: Date.now(), rtcs: true } })) {
        return;
      }
      return new Response('Upgrade failed', { status: 400 });
    }

    const route = ROUTES[url.pathname];
    if (route) return route(url);

    // Prefix routes — path carries params (admin query args, demo filename).
    if (url.pathname.startsWith('/admin/')) return adminRoute(req, url);
    if (url.pathname.startsWith('/demos/')) return demoRoute(req, url);
    if (url.pathname === '/client-log' && req.method === 'POST') return clientLogRoute(req);

    return corsResponse('Not found', { status: 404 });
  },
});

gameServer.setBunServer(server);

logger.info('FPS Bun Server started', {
  port: CONFIG.port,
  tickRate: CONFIG.tickRate,
  maxPlayers: CONFIG.maxPlayers,
  respawnMs: CONFIG.respawnDelayMs,
});

logger.info(`WebSocket: ws://localhost:${CONFIG.port}/ws`);
logger.info(`Health:    http://localhost:${CONFIG.port}/health`);
logger.info(`RTC relay: ws://localhost:${CONFIG.port}/rtc?room=CODE`);

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  gameServer.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  gameServer.stop();
  process.exit(0);
});
