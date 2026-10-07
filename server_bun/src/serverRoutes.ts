/**
 * serverRoutes — every HTTP route handler for the game server: the
 * plain-GET table, the admin API, demo upload/download, and the map-bin
 * distribution endpoint. server.ts keeps the transport wiring
 * (Bun.serve + WS/RTC/WT sockets); this owns "what the HTTP surface
 * answers". Handlers take live refs via HttpCtx so nothing here caches
 * server state.
 */
import { CONFIG } from './config.ts';
import { evictEldest } from './evictEldest.ts';
import type { GameServer } from './GameServer.ts';
import type { DemoStorage } from './DemoStorage.ts';
import type { RtcRelay } from './RtcRelay.ts';
import { weaponStats } from './weaponStats.ts';
import { WEAPONSTATS_PAGE } from './weaponstatsPage.ts';
import { STATUS_PAGE } from './statusPage.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';

export interface HttpCtx {
  gameServer: GameServer;
  demoStorage: DemoStorage;
  rtcRelay: RtcRelay;
  /** DER SHA-256 of the WebTransport cert, once the WT block has read it. */
  wtCertHash(): string | null;
  /** Client IP for per-caller throttle tables — Bun's server.requestIP. */
  requestIP?(req: Request): { address: string } | null;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function corsResponse(body: BodyInit | null, init?: ResponseInit): Response {
  return new Response(body, { ...init, headers: { ...CORS_HEADERS, ...init?.headers } });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data: unknown, init?: ResponseInit) =>
  corsResponse(JSON.stringify(data), { ...init, headers: JSON_HEADERS });

let _ice: unknown[] | null = null;
function iceServers(): unknown[] {
  if (_ice === null) {
    try { _ice = CONFIG.iceServersJson ? JSON.parse(CONFIG.iceServersJson) : []; }
    catch { logger.warn('FPS_ICE_SERVERS is not valid JSON — RTC tier will run without STUN/TURN'); _ice = []; }
    if (!Array.isArray(_ice)) _ice = [];
  }
  return _ice;
}

function wtInfo(ctx: HttpCtx): { enabled: true; port: number; sha256: string } | null {
  const sha256 = ctx.wtCertHash();
  if (!sha256) return null;
  return { enabled: true, port: CONFIG.wtPort, sha256 };
}

/** /join per-IP throttle — the WS handshake has one (SessionManager),
 *  but a GET flood here never reaches a handshake: each request can
 *  build a fresh Room + bot populate (empties dispose per tick, so the
 *  churn repeats every request). Mirrors the 5/min handshake budget. */
const joinIps = new Map<string, { count: number; start: number }>();
const JOIN_IP_LIMIT = 5;
const JOIN_IP_WINDOW_MS = 60_000;
function joinThrottleAllow(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  const now = wallNow();
  let w = joinIps.get(ip);
  if (!w || now - w.start >= JOIN_IP_WINDOW_MS) {
    w = { count: 0, start: now };
    joinIps.set(ip, w);
    if (joinIps.size > 1024) evictEldest(joinIps);
  }
  return ++w.count <= JOIN_IP_LIMIT;
}

// Plain GET endpoints — a new JSON route is one table entry. Handlers
// get (url, req) — req is only needed by /join for the client IP.
export function makeRoutes(ctx: HttpCtx): Record<string, (url: URL, req?: Request) => Response | Promise<Response>> {
  return {
    '/': () => json(ctx.gameServer.getHealthStatus()),
    '/health': () => json(ctx.gameServer.getHealthStatus()),
    // Ops metrics — uptime, players, balls, tick-lag stats.
    '/metrics': () => json(ctx.gameServer.getMetrics()),
    // Server-browser card — identity + occupancy for master lists / LAN.
    '/serverinfo': () => json(ctx.gameServer.getServerInfo()),
    // Lobby browse — live matches with occupancy.
    '/rooms': () => json(ctx.gameServer.listRooms()),
    // Match history ring (also journaled to logs/matches.jsonl).
    '/matches': () => json(ctx.gameServer.listMatches()),
    // Lifetime per-player aggregates off the match journal.
    '/stats': async () => json(await ctx.gameServer.getStats()),
    // Balance telemetry — per-mode damage/hits/kills by weapon source,
    // bot-authored share split out (also journaled to weaponstats.jsonl).
    '/weaponstats': () => json(weaponStats.snapshot()),
    // Readable dashboard over the same ledger — tables, bars, funnel pcts.
    '/weaponstats.html': () => corsResponse(WEAPONSTATS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    // Live ops dashboard over /metrics + /health — degraded banner,
    // per-phase tick bars, per-room bot CPU + client tails.
    '/status': () => corsResponse(STATUS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    // Map list for the menu's match setup — name + mode + default bots.
    '/maps': () => json(ctx.gameServer.listMaps()),
    // Quick-join: /join?mode=ctf&map=raindance&bots=6 → emptiest live
    // match fitting the request (or a fresh room built from that spec).
    '/join': (url, req) => {
      const ip = req ? ctx.requestIP?.(req)?.address : undefined;
      if (ip && !joinThrottleAllow(ip)) return corsResponse('Too many joins', { status: 429 });
      const mode = url.searchParams.get('mode') ?? '';
      const map = url.searchParams.get('map') ?? '';
      const botsRaw = url.searchParams.get('bots');
      const bots = botsRaw === null ? undefined
        : Math.max(0, Math.min(24, Math.floor(Number(botsRaw) || 0)));
      if (!/^[a-z0-9_-]{0,16}$/.test(mode) || !/^[a-z0-9_-]{0,32}$/.test(map)) {
        return corsResponse('Bad mode/map', { status: 400 });
      }
      // A map that doesn't resolve must not spin up a room — bogus names
      // otherwise each built (and a tick later tore down) a full Room.
      if (map && !ctx.gameServer.hasMap(map)) {
        return corsResponse('Unknown map', { status: 400 });
      }
      const room = ctx.gameServer.quickRoom(mode, map, bots);
      return json({ room: room.name, mode: room.mode });
    },
    // WebTransport discovery: browser clients pin self-signed certs via
    // serverCertificateHashes — this is the DER SHA-256 of FPS_WT_CERT.
    '/wthash': () => json(wtInfo(ctx) ?? { enabled: false }),
    // WebRTC tier: STUN/TURN servers come from the deployment, not the
    // client build — parsed once at boot from FPS_ICE_SERVERS.
    '/rtcconfig': () => json({ iceServers: iceServers() }),
    // Open P2P lobbies — hosts that marked their room public, still waiting
    // on a guest. Quick-join picks the first (longest waiting).
    '/rtc/lobbies': () => json(ctx.rtcRelay.lobbies()),
    '/demos': async () => {
      const list = await ctx.demoStorage.listDemos();
      logger.info('Demo list requested', { count: list.length, top: list[0]?.projectileLifetime.toFixed(2) ?? 'none' });
      return json({ demos: list });
    },
  };
}

// Admin API — bearer-token guarded (FPS_ADMIN_TOKEN). Unset = closed.
//   POST /admin/reload?room=X   re-read maps/X.json into the live room
//   POST /admin/kick?player=X   boot a player
//   POST /admin/end?room=X      force-end the match (leader wins)
//   GET  /admin/rooms           detailed live dump
export function adminRoute(ctx: HttpCtx, req: Request, url: URL): Response {
  const want = CONFIG.adminToken;
  if (!want) return corsResponse('admin disabled (FPS_ADMIN_TOKEN unset)', { status: 403 });
  const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '');
  if (got !== want) return corsResponse('unauthorized', { status: 401 });

  if (url.pathname === '/admin/rooms' && req.method === 'GET') {
    return json(ctx.gameServer.listRooms());
  }
  if (req.method !== 'POST') return corsResponse('POST only', { status: 405 });

  const ADMIN_ACTIONS: Record<string, () => Response> = {
    '/admin/reload': () => {
      const r = ctx.gameServer.reloadRoom(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
    '/admin/kick': () => {
      const ok = ctx.gameServer.kickPlayer(url.searchParams.get('player') ?? '');
      return json({ ok }, { status: ok ? 200 : 404 });
    },
    '/admin/end': () => {
      const r = ctx.gameServer.forceEndMatch(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
  };
  return ADMIN_ACTIONS[url.pathname]?.() ?? corsResponse('Unknown admin route', { status: 404 });
}

// Demo endpoints: POST /demos/upload, GET /demos/:filename.
export async function demoRoute(ctx: HttpCtx, req: Request, url: URL): Promise<Response> {
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
      const meta = await ctx.demoStorage.saveDemo(body);
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
    const data = await ctx.demoStorage.loadDemo(filename);
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
export async function mapBinRoute(url: URL): Promise<Response> {
  const file = url.pathname.slice('/maps/'.length);
  // maps/-relative asset path: word-char segments, ≤3 dirs deep, bin/
  // image/model/json payload — t2/<map>/sky/px.png needs the third level.
  if (!/^(?:[\w-]{1,64}\/){0,3}[\w-]{1,64}\.(?:bin|png|jpe?g|webp|glb|json)$/.test(file)) {
    return corsResponse('Not found', { status: 404 });
  }
  const f = Bun.file(`${import.meta.dir}/../../maps/${file}`);
  if (!(await f.exists())) return corsResponse('Not found', { status: 404 });
  const ct = file.endsWith('.png') ? 'image/png'
    : file.endsWith('.webp') ? 'image/webp'
    : file.endsWith('.glb') ? 'model/gltf-binary'
    : file.match(/\.jpe?g$/) ? 'image/jpeg'
    : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return corsResponse(f, { headers: { 'Content-Type': ct } });
}
