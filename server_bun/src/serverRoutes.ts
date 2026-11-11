/**
 * serverRoutes — every HTTP route handler for the game server: the
 * plain-GET table, the admin API, demo upload/download, and the map-bin
 * distribution endpoint. server.ts keeps the transport wiring
 * (Bun.serve + WS/RTC/WT sockets); this owns "what the HTTP surface
 * answers". Handlers take live refs via HttpCtx so nothing here caches
 * server state.
 */
import { parse as parseToml } from 'smol-toml';
import { timingSafeEqual, createHash } from 'node:crypto';
import { CONFIG } from './config.ts';
import { windowAllow } from './windowLimit.ts';
import type { GameServer } from './GameServer.ts';
import type { DemoStorage } from './DemoStorage.ts';
import type { RtcRelay } from './RtcRelay.ts';
import { weaponStats } from './weaponStats.ts';
import { WEAPONSTATS_PAGE } from './weaponstatsPage.ts';
import { STATUS_PAGE } from './statusPage.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';
import { wireMeterSnapshot } from './wireMeter.ts';
import { roomModsOf, type RoomMods } from '../../shared/protocol.ts';

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
  'Access-Control-Allow-Origin': CONFIG.corsOrigin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Ops surfaces (tick-lag meters, client tails, weapon telemetry) give a
// stranger a live "when is the server weakest" readout — when the admin
// token exists they require it; dev (token unset) stays open.
// ?key= rides URLs — access logs, caches, Referer all see it. Remote
// callers must send Authorization: Bearer; the query fallback stays for
// loopback curl convenience only.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Effective client IP: behind the local reverse proxy (Caddy on the
 *  same box) every peer is 127.0.0.1 — trust the LAST X-Forwarded-For
 *  hop then (the proxy appends the real client IP; a client-supplied
 *  XFF is followed by Caddy's append, so .pop() can't be spoofed into
 *  loopback). Direct loopback hits keep `ip`. */
function clientIp(req: Request | undefined, peerIp?: string): string | undefined {
  const xff = peerIp && LOOPBACK.has(peerIp) ? req?.headers.get('x-forwarded-for') : undefined;
  return xff ? xff.split(',').pop()!.trim() : peerIp;
}
// Constant-time compare — sha256 both sides first so a length mismatch
// can't trip timingSafeEqual's equal-length requirement.
function tokEq(given: string | null | undefined): boolean {
  if (!given || !CONFIG.adminToken) {return false;}
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(CONFIG.adminToken).digest());
}
function opsAllowed(req: Request | undefined, url: URL, ip?: string): boolean {
  if (!CONFIG.adminToken) {return true;}
  const ipEff = clientIp(req, ip);
  if (tokEq(req?.headers.get('authorization')?.replace(/^bearer\s+/i, ''))) {return true;}
  return tokEq(url.searchParams.get('key')) && ipEff !== undefined && LOOPBACK.has(ipEff);
}

export function corsResponse(body: BodyInit | null, init?: ResponseInit): Response {
  return new Response(body, Object.assign({}, init, {headers: Object.assign({}, CORS_HEADERS, init?.headers)}));
}


const opsClosed = (): Response => corsResponse('unauthorized', { status: 401 });

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data: unknown, init?: ResponseInit): Response =>
  corsResponse(JSON.stringify(data), Object.assign({}, init, {headers: JSON_HEADERS}));

let _ice: unknown[] | null = null;
function iceServers(): unknown[] {
  if (_ice === null) {
    try { _ice = CONFIG.iceServersJson ? JSON.parse(CONFIG.iceServersJson) : []; }
    catch { logger.warn('FPS_ICE_SERVERS is not valid JSON — RTC tier will run without STUN/TURN'); _ice = []; }
    if (!Array.isArray(_ice)) {_ice = [];}
  }
  return _ice;
}

function wtInfo(ctx: HttpCtx): { enabled: true; port: number; sha256: string } | null {
  const sha256 = ctx.wtCertHash();
  if (!sha256) {return null;}
  return { enabled: true, port: CONFIG.wtAdvertisePort, sha256 };
}

/** /join per-IP throttle — the WS handshake has one (SessionManager),
 *  but a GET flood here never reaches a handshake: each request can
 *  build a fresh Room + bot populate (empties dispose per tick, so the
 *  churn repeats every request). Mirrors the 5/min handshake budget. */
const joinIps = new Map<string, { count: number; start: number }>();
// 20/min — same household/NAT reasoning as SessionManager.JOIN_LIMIT:
// a LAN party shares one public IP; 5/min rejected their first burst.
const JOIN_IP_LIMIT = 20;
const JOIN_IP_WINDOW_MS = 60_000;
function joinThrottleAllow(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {return true;}
  return windowAllow(joinIps, ip, wallNow(), JOIN_IP_WINDOW_MS, JOIN_IP_LIMIT, 1024);
}

interface JoinArgs extends RoomMods { mode: string; map: string; bots?: number; preferHumans: boolean }

/** /join query parse + validation. Returns the args, or a 4xx Response
 *  the route passes straight through. */
function joinArgs(url: URL, hasMap: (m: string) => boolean): JoinArgs | Response {
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
  if (map && !hasMap(map)) {
    return corsResponse('Unknown map', { status: 400 });
  }
  return {
    mode, map, bots,
    noCreatures: url.searchParams.get('nocreatures') === '1',
    noBalls: url.searchParams.get('noballs') === '1',
    instagib: url.searchParams.get('instagib') === '1',
    gungame: url.searchParams.get('gungame') === '1',
    igun: url.searchParams.get('igun') === '1',
    preferHumans: url.searchParams.get('humans') === '1',
  };
}

// Plain GET endpoints — a new JSON route is one table entry. Handlers
// get (url, req) — req is only needed by /join for the client IP.
export function makeRoutes(ctx: HttpCtx): Record<string, (url: URL, req?: Request) => Response | Promise<Response>> {
  return {
    '/': (): Response => json(ctx.gameServer.getHealthStatus()),
    '/health': (): Response => json(ctx.gameServer.getHealthStatus()),
    // Bare round-trip target — no state, so the browser's timing is the ping.
    '/ping': (): Response => json({ pong: true }),
    // Ops metrics — uptime, players, balls, tick-lag stats. Ops-gated.
    '/metrics': (url, req): Response => opsAllowed(req, url, req && ctx.requestIP?.(req)?.address) ? json(ctx.gameServer.getMetrics()) : opsClosed(),
    // Cumulative wire bytes per connection + total — diff two reads for
    // a rate. Ops-gated like metrics.
    '/wire': (url, req): Response => opsAllowed(req, url, req && ctx.requestIP?.(req)?.address) ? json(wireMeterSnapshot((pid) => ctx.gameServer.playerName(pid))) : opsClosed(),
    // Server-browser card — identity + occupancy for master lists / LAN.
    '/serverinfo': (): Response => json(ctx.gameServer.getServerInfo()),
    // Lobby browse — live matches with occupancy. The admin key adds
    // the id→name roster (ops lookup "who's in there" — public callers
    // get counts only; names are cosmetic, not secret, but listing them
    // for anonymous internet traffic is a stalk-by-lobby surface).
    '/rooms': (url, req): Response => json(ctx.gameServer.listRooms(opsAllowed(req, url, req && ctx.requestIP?.(req)?.address))),
    // Match history ring (also journaled to logs/matches.jsonl).
    '/matches': (): Response => json(ctx.gameServer.listMatches()),
    // Lifetime per-player aggregates off the match journal.
    '/stats': async (): Promise<Response> => json(await ctx.gameServer.getStats()),
    // Balance telemetry — per-mode damage/hits/kills by weapon source,
    // bot-authored share split out (also journaled to weaponstats.jsonl).
    '/weaponstats': (url, req): Response => opsAllowed(req, url, req && ctx.requestIP?.(req)?.address) ? json(weaponStats.snapshot()) : opsClosed(),
    // Readable dashboard over the same ledger — tables, bars, funnel pcts.
    '/weaponstats.html': (url, req): Response => opsAllowed(req, url, req && ctx.requestIP?.(req)?.address)
      ? corsResponse(WEAPONSTATS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : opsClosed(),
    // Live ops dashboard over /metrics + /health — degraded banner,
    // per-phase tick bars, per-room bot CPU + client tails.
    '/status': (url, req): Response => opsAllowed(req, url, req && ctx.requestIP?.(req)?.address)
      ? corsResponse(STATUS_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      : opsClosed(),
    // Map list for the menu's match setup — name + mode + default bots.
    '/maps': (): Response => json(ctx.gameServer.listMaps()),
    // Quick-join: /join?mode=ctf&map=raindance&bots=6 → emptiest live
    // match fitting the request (or a fresh room built from that spec).
    '/join': (url, req): Response => {
      const ip = req ? req && ctx.requestIP?.(req)?.address : undefined;
      if (ip && !joinThrottleAllow(ip)) {return corsResponse('Too many joins', { status: 429 });}
      const args = joinArgs(url, (m): boolean => ctx.gameServer.hasMap(m));
      if (args instanceof Response) {return args;}
      // Sim gates ride the mint — a bare roomFor'd room ignores the
      // flags the follow-up join carries (creation-time only).
      const room = ctx.gameServer.quickRoom(args.mode, args.map, args.bots, roomModsOf(args), args.preferHumans, CONFIG.clientRooms);
      if (!room) {return corsResponse('Server full', { status: 503 });}
      return json({ room: room.name, mode: room.mode });
    },
    // WebTransport discovery: browser clients pin self-signed certs via
    // serverCertificateHashes — this is the DER SHA-256 of FPS_WT_CERT.
    '/wthash': (): Response => json(wtInfo(ctx) ?? { enabled: false }),
    // WebRTC tier: STUN/TURN servers come from the deployment, not the
    // client build — parsed once at boot from FPS_ICE_SERVERS.
    '/rtcconfig': (): Response => json({ iceServers: iceServers() }),
    // Open P2P lobbies — hosts that marked their room public, still waiting
    // on a guest. Quick-join picks the first (longest waiting).
    '/rtc/lobbies': (): Response => json(ctx.rtcRelay.lobbies()),
    '/demos': async (): Promise<Response> => {
      const list = await ctx.demoStorage.listDemos();
      logger.info('Demo list requested', { count: list.length, top: list[0]?.projectileLifetime.toFixed(2) ?? 'none' });
      return json({ demos: list });
    },
  };
}

// Admin API — bearer-token guarded (FPS_ADMIN_TOKEN). Unset = closed.
//   POST /admin/reload?room=X   re-read maps/X.json into the live room
//   POST /admin/kick?player=X   boot a player
//   POST /admin/dropsock?player=X  kill the socket, keep the seat (reclaim test)
//   POST /admin/end?room=X      force-end the match (leader wins)
//   POST /admin/heapdump        write a JSC heapsnapshot to _heapdumps/
//   GET  /admin/rooms           detailed live dump
export function adminRoute(ctx: HttpCtx, req: Request, url: URL): Response | Promise<Response> {
  const want = CONFIG.adminToken;
  if (!want) {return corsResponse('admin disabled (FPS_ADMIN_TOKEN unset)', { status: 403 });}
  const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '');
  if (got !== want) {return corsResponse('unauthorized', { status: 401 });}

  if (url.pathname === '/admin/rooms' && req.method === 'GET') {
    return json(ctx.gameServer.listRooms(true));
  }
  if (req.method !== 'POST') {return corsResponse('POST only', { status: 405 });}

  const ADMIN_ACTIONS: Record<string, () => Response | Promise<Response>> = {
    '/admin/reload': (): Response => {
      const r = ctx.gameServer.reloadRoom(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
    // Drain-deploys: mark the server draining — SessionManager refuses
    // new joins, /health flips to 'draining', the deploy checker exits
    // the process once the last human leaves. Reclaims still land.
    '/admin/drain': (): Response => {
      ctx.gameServer.draining = true;
      return json({ ok: true, draining: true });
    },
    '/admin/kick': (): Response => {
      const ok = ctx.gameServer.kickPlayer(url.searchParams.get('player') ?? '');
      return json({ ok }, { status: ok ? 200 : 404 });
    },
    // Socket drop WITHOUT seat removal — kicks the wire, keeps the
    // player record so grace/reclaim replay runs. The real-socket
    // reconnect test needs this; kick would delete the seat.
    '/admin/dropsock': (): Response => {
      const ok = ctx.gameServer.dropSocket(url.searchParams.get('player') ?? '');
      return json({ ok }, { status: ok ? 200 : 404 });
    },
    '/admin/close': (): Response => {
      const r = ctx.gameServer.closeRoom(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
    '/admin/end': (): Response => {
      const r = ctx.gameServer.forceEndMatch(url.searchParams.get('room') ?? '');
      return json({ ok: r === 'ok', result: r }, { status: r === 'ok' ? 200 : 404 });
    },
    // Live authoritative capture — the server's own demo of a room,
    // flushed mid-match without teardown. Needs FPS_DEMO at boot.
    '/admin/demodump': (): Response => {
      const r = ctx.gameServer.dumpDemo(url.searchParams.get('room') ?? '');
      return json(typeof r === 'string' ? { ok: false, result: r } : { ok: true, ...r },
        { status: r === 'ok' || typeof r === 'object' ? 200 : 404 });
    },
    // Leak forensics — JSC-format heapsnapshot, opens in Safari Web
    // Inspector's comparison view (two dumps ~30min apart → retained-type
    // deltas name the leaking Map). Trigger Bun.gc() first so the diff
    // counts live objects only.
    '/admin/heapdump': async (): Promise<Response> => {
      const b = globalThis.Bun;
      if (!b) {return json({ ok: false, error: 'bun-only' }, { status: 501 });}
      b.gc(true);
      const snap = b.generateHeapSnapshot('jsc');
      const file = `_heapdumps/heap-${Date.now()}.heapsnapshot`;
      await b.write(file, JSON.stringify(snap));
      return json({ ok: true, file });
    },
  };
  return ADMIN_ACTIONS[url.pathname]?.() ?? corsResponse('Unknown admin route', { status: 404 });
}

// Demo endpoints: POST /demos/upload, GET /demos/:filename.
//
// Upload is the server's only unauthenticated write path — anyone can
// POST 16MB. The storage cap bounds the disk (~100 clips), but an
// unthrottled poster still churns 16MB writes + index churn forever.
// Per-IP budget mirrors the client-log rate: generous for real play,
// useless for a filler script.
const demoIps = new Map<string, { count: number; start: number }>();
const DEMO_IP_LIMIT = 12;
const DEMO_IP_WINDOW_MS = 60_000;

// Leaderboard — submit rides the same IP budget as demo uploads (it's
// the same body size class); the gates live in leaderboard.ts.
export async function leaderboardRoute(ctx: HttpCtx, req: Request, url: URL): Promise<Response> {
  const lb = await import('./leaderboard.ts');
  if (url.pathname === '/leaderboard/submit' && req.method === 'POST') {
    const ip = req && ctx.requestIP?.(req)?.address;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1' &&
        !windowAllow(demoIps, ip, wallNow(), DEMO_IP_WINDOW_MS, DEMO_IP_LIMIT, 1024)) {
      return json({ ok: false, error: 'Too many submissions' }, { status: 429 });
    }
    const body = await req.arrayBuffer();
    if (body.byteLength > 16 * 1024 * 1024) {
      return json({ ok: false, error: 'Upload too large' }, { status: 413 });
    }
    let chal = null;
    const chalParam = url.searchParams.get('chal');
    if (chalParam) {
      try { chal = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(chalParam), c => c.charCodeAt(0)))); }
      catch { return json({ ok: false, error: 'bad challenge param' }, { status: 400 }); }
    }
    const r = await lb.submitDemo(body, chal);
    return json(r, { status: r.ok ? 200 : 422 });
  }
  if (url.pathname === '/challenge' && req.method === 'GET') {
    const c = await lb.mintChallenge();
    return c ? json(c) : json({ error: 'signing disabled (KRIBES_SIGN_KEY unset)' }, { status: 503 });
  }
  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    return json({ board: lb.board(url.searchParams.get('mode') ?? undefined) });
  }
  return corsResponse('Not found', { status: 404 });
}

export async function demoRoute(ctx: HttpCtx, req: Request, url: URL): Promise<Response> {
  // Chunked game stream: POST /demos/stream?session=<id>&seq=<n> —
  // each body is a complete .demo slice; files land as stream_<id>_<seq>.
  if (url.pathname === '/demos/stream' && req.method === 'POST') {
    const ip = req && ctx.requestIP?.(req)?.address;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1' &&
        !windowAllow(demoIps, ip, wallNow(), DEMO_IP_WINDOW_MS, DEMO_IP_LIMIT * 10, 1024)) {
      return json({ success: false, error: 'Too many uploads' }, { status: 429 });
    }
    const body = await req.arrayBuffer();
    if (body.byteLength > 16 * 1024 * 1024) {
      return json({ success: false, error: 'Chunk too large' }, { status: 413 });
    }
    try {
      const meta = await ctx.demoStorage.saveStream(body, url.searchParams.get('session') ?? '', Number(url.searchParams.get('seq') ?? 0));
      return json(Object.assign({}, {success: true}, meta));
    } catch (error) {
      return json({ success: false, error: (error as Error).message }, { status: 400 });
    }
  }
  if (url.pathname === '/demos/upload' && req.method === 'POST') {
    const ip = req && ctx.requestIP?.(req)?.address;
    if (ip && ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1' &&
        !windowAllow(demoIps, ip, wallNow(), DEMO_IP_WINDOW_MS, DEMO_IP_LIMIT, 1024)) {
      return json({ success: false, error: 'Too many uploads' }, { status: 429 });
    }
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
      return json(Object.assign({}, {success: true}, meta));
    } catch (error) {
      const msg = (error as Error).message;
      logger.warn('Demo upload failed', { error: msg });
      // Malformed input is the uploader's fault (400); a storage fault is
      // ours (500) — and its internals don't belong in the response.
      const bad = msg.startsWith('Malformed demo');
      return json({ success: false, error: bad ? msg : 'Upload failed' }, { status: bad ? 400 : 500 });
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

// Clip-feed deep links: GET /clips/<file> returns a static OG/Twitter card
// for crawlers and chat unfurls (the .demo binary can't render there), then
// meta-refreshes humans into the feed. FPS_CLIENT_URL points the refresh at
// wherever the static client lives; empty = same origin (co-hosted deploy).
const esc = (s: string): string => s.replace(/[&<>"']/g, (c): string => `&#${c.charCodeAt(0)};`);
export async function clipRoute(ctx: HttpCtx, url: URL): Promise<Response> {
  const name = url.pathname.slice('/clips/'.length);
  const base = (CONFIG.clientUrl ?? '').replace(/\/$/, '');
  const path = name ? `/clips/${encodeURIComponent(name)}` : '/clips';
  let title = 'Best shots';
  let desc = 'Watch the top plays';
  if (name) {
    const meta = (await ctx.demoStorage.listDemos()).find((m): boolean => m.filename === name);
    if (meta) {
      title = meta.description || title;
      desc = `${meta.projectileLifetime.toFixed(2)}s air`;
    } else {
      title = 'Clip not found';
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base + path)}">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0;url=${esc(base + path)}">
</head><body style="background:#060a12;color:#cfe3ff;font-family:monospace;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div><div style="color:#3aa7ff;letter-spacing:.2em;margin-bottom:8px">BEST SHOTS</div>
<div>${esc(title)}</div><div style="opacity:.7;margin-top:4px">${esc(desc)}</div>
<a style="color:#3aa7ff" href="${esc(base + path)}">Watch in player</a></div></body></html>`;
  return corsResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Heightfield distribution — gameState names maps/<file>.bin; clients fetch
// the same bytes the room's sims consume so terrain matches bit-for-bit.
export async function mapBinRoute(url: URL): Promise<Response> {
  const file = url.pathname.slice('/maps/'.length);
  // T2 ports carry rights-restricted assets — a public-beta deploy never
  // serves them, even when the catalog flag leaked a name through.
  if (CONFIG.publicBeta && (file.startsWith('t2/') || file.startsWith('t1/'))) {
    return corsResponse('Not found', { status: 404 });
  }
  // maps/-relative asset path: word-char segments, ≤3 dirs deep, bin/
  // image/model/json payload — t2/<map>/sky/px.png needs the third level.
  if (!/^(?:[\w-]{1,64}\/){0,3}[\w-]{1,64}\.(?:bin|png|jpe?g|webp|glb|json)$/.test(file)) {
    return corsResponse('Not found', { status: 404 });
  }
  const f = Bun.file(`${import.meta.dir}/../../maps/${file}`);
  if (!(await f.exists())) {
    // TOML-authored spec requested as .json — solo boot, thumbs and
    // maplab only speak JSON; translate on the fly so the toml stays
    // the single source of truth.
    if (file.endsWith('.json')) {
      const toml = Bun.file(`${import.meta.dir}/../../maps/${file.slice(0, -5)}.toml`);
      if (await toml.exists()) {
        const body = JSON.stringify(parseToml(await toml.text()));
        return corsResponse(body, { headers: { 'Content-Type': 'application/json' } });
      }
    }
    return corsResponse('Not found', { status: 404 });
  }
  let ct = 'application/octet-stream';
  if (file.endsWith('.png')) {ct = 'image/png';}
  else if (file.endsWith('.webp')) {ct = 'image/webp';}
  else if (file.endsWith('.glb')) {ct = 'model/gltf-binary';}
  else if (file.match(/\.jpe?g$/)) {ct = 'image/jpeg';}
  else if (file.endsWith('.json')) {ct = 'application/json';}
  // Rejoins and room hops re-request the same terrain — a 1h cache turns
  // those into local hits. Bounded, not immutable: map bins do get edited,
  // and a stale heightfield is a real divergence, not a cosmetic miss.
  return corsResponse(f, { headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' } });
}
