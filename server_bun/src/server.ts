import { CONFIG } from './config.ts';
import { GameServer } from './GameServer.ts';
import { weaponStats } from './weaponStats.ts';
import { WEAPONSTATS_PAGE } from './weaponstatsPage.ts';
import { logger } from './logger.ts';
import type { WebSocketData } from './types.ts';
import { DemoStorage } from './DemoStorage.ts';
import { RtcRelay } from './RtcRelay.ts';
import { RtcServer } from './RtcServer.ts';
import { WtServer } from './WtServer.ts';
import { join, basename, extname } from 'node:path';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readdirSync } from 'node:fs';

const gameServer = new GameServer();
const demoStorage = new DemoStorage(join(import.meta.dir, '..', 'demos'));
// P2P signalling: /rtc sockets never touch GameServer — the relay just
// shuttles SDP/ICE between the two members of a room.
const rtcRelay = new RtcRelay();
// Server-peer WebRTC tier: /rtcs sockets carry signalling; the negotiated
// DataChannel is adapted onto GameServer as if it were a /ws socket.
const rtcServer = new RtcServer(gameServer);
const wtServer = new WtServer(gameServer);

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

// The three websocket endpoints share one upgrade shape — undefined on
// success (Bun owns the socket), 400 Response on refusal.
function wsUpgrade(srv: { upgrade(req: Request, opts: { data: WebSocketData }): boolean }, req: Request, data: WebSocketData): Response | undefined {
  if (srv.upgrade(req, { data })) return undefined;
  return new Response('Upgrade failed', { status: 400 });
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
  // Balance telemetry — per-mode damage/hits/kills by weapon source,
  // bot-authored share split out (also journaled to weaponstats.jsonl).
  '/weaponstats': () => json(weaponStats.snapshot()),
  // Readable dashboard over the same ledger — tables, bars, funnel pcts.
  '/weaponstats.html': () => corsResponse(WEAPONSTATS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  // Map list for the menu's match setup — name + mode + default bots.
  '/maps': () => json(gameServer.listMaps()),
  // Quick-join: /join?mode=ctf&map=raindance&bots=6 → emptiest live
  // match fitting the request (or a fresh room built from that spec).
  '/join': (url) => {
    const mode = url.searchParams.get('mode') ?? '';
    const map = url.searchParams.get('map') ?? '';
    const botsRaw = url.searchParams.get('bots');
    const bots = botsRaw === null ? undefined
      : Math.max(0, Math.min(24, Math.floor(Number(botsRaw) || 0)));
    if (!/^[a-z0-9_-]{0,16}$/.test(mode) || !/^[a-z0-9_-]{0,32}$/.test(map)) {
      return corsResponse('Bad mode/map', { status: 400 });
    }
    const room = gameServer.quickRoom(mode, map, bots);
    return json({ room: room.name, mode: room.mode });
  },
  // WebTransport discovery: browser clients pin self-signed certs via
  // serverCertificateHashes — this is the DER SHA-256 of FPS_WT_CERT.
  '/wthash': () => json(wtInfo() ?? { enabled: false }),
  // WebRTC tier: STUN/TURN servers come from the deployment, not the
  // client build — parsed once at boot from FPS_ICE_SERVERS.
  '/rtcconfig': () => json({ iceServers: iceServers() }),
  // Open P2P lobbies — hosts that marked their room public, still waiting
  // on a guest. Quick-join picks the first (longest waiting).
  '/rtc/lobbies': () => json(rtcRelay.lobbies()),
};

let _ice: unknown[] | null = null;
function iceServers(): unknown[] {
  if (_ice === null) {
    try { _ice = CONFIG.iceServersJson ? JSON.parse(CONFIG.iceServersJson) : []; }
    catch { logger.warn('FPS_ICE_SERVERS is not valid JSON — RTC tier will run without STUN/TURN'); _ice = []; }
    if (!Array.isArray(_ice)) _ice = [];
  }
  return _ice;
}

let wtCertHash: string | null = null;
function wtInfo(): { enabled: true; port: number; sha256: string } | null {
  if (!wtCertHash) return null;
  return { enabled: true, port: CONFIG.wtPort, sha256: wtCertHash };
}

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

// Heightfield distribution — gameState names maps/<file>.bin; clients fetch
// the same bytes the room's sims consume so terrain matches bit-for-bit.
async function mapBinRoute(url: URL): Promise<Response> {
  const file = url.pathname.slice('/maps/'.length);
  if (!/^[\w-]{1,64}\.bin$/.test(file)) return corsResponse('Not found', { status: 404 });
  const f = Bun.file(`${import.meta.dir}/../../maps/${file}`);
  if (!(await f.exists())) return corsResponse('Not found', { status: 404 });
  return corsResponse(f, { headers: { 'Content-Type': 'application/octet-stream' } });
}

ROUTES['/demos'] = async () => {
  const list = await demoStorage.listDemos();
  logger.info('Demo list requested', { count: list.length, top: list[0]?.projectileLifetime.toFixed(2) ?? 'none' });
  return json({ demos: list });
};

const LOGS_DIR = join(import.meta.dir, '..', '..', 'logs');

// Log rotation — the previous run's logs move to logs/OLD/<name>_<mtime
// -ts>.<ext> at boot so each file always reflects the build that produced
// it (JP's manual timestamp convention, automated). Best-effort only.
const p2 = (n: number) => String(n).padStart(2, '0');
const logStamp = (t: Date) =>
  `${t.getFullYear()}_${p2(t.getMonth() + 1)}_${p2(t.getDate())}-${p2(t.getHours())}_${p2(t.getMinutes())}_${p2(t.getSeconds())}`;

const rotateLog = (p: string): void => {
  try {
    if (!existsSync(p) || statSync(p).size === 0) return;
    const dst = join(LOGS_DIR, 'OLD', `${basename(p, extname(p))}_${logStamp(statSync(p).mtime)}${extname(p)}`);
    renameSync(p, dst);
  } catch { /* rotation must never block boot */ }
};

function rotateLogs(): void {
  try {
    mkdirSync(join(LOGS_DIR, 'OLD'), { recursive: true });
    for (const f of readdirSync(LOGS_DIR)) {
      if (/\.(log|jsonl)$/.test(f)) rotateLog(join(LOGS_DIR, f));
    }
    rotateLog(join(import.meta.dir, '..', 'logs', 'server.log'));
  } catch { /* same */ }
}
rotateLogs();

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
      return wsUpgrade(srv, req, { playerId: '', connectedAt: Date.now() });
    }

    // P2P signalling: /rtc?room=CODE — two sockets per room, opaque relay.
    if (url.pathname === '/rtc') {
      const room = url.searchParams.get('room') ?? '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(room)) {
        return new Response('Bad room', { status: 400 });
      }
      const open = url.searchParams.get('open') === '1';
      return wsUpgrade(srv, req, { playerId: '', connectedAt: Date.now(), rtc: true, room, open });
    }

    // Server-peer WebRTC signalling: /rtcs — one shot offer/answer, then
    // the DataChannel becomes the game socket.
    if (url.pathname === '/rtcs') {
      return wsUpgrade(srv, req, { playerId: '', connectedAt: Date.now(), rtcs: true });
    }

    const route = ROUTES[url.pathname];
    if (route) return route(url);

    // Prefix routes — path carries params (admin query args, demo filename).
    if (url.pathname.startsWith('/admin/')) return adminRoute(req, url);
    if (url.pathname.startsWith('/demos/')) return demoRoute(req, url);
    if (url.pathname.startsWith('/maps/')) return mapBinRoute(url);
    if (url.pathname === '/client-log' && req.method === 'POST') return clientLogRoute(req);

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
