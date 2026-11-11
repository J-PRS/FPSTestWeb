/**
 * fleet.ts — matchmaker + worker-fleet supervisor. The deployment plane
 * for spreading rooms across processes: each worker is a plain
 * server.ts instance on its own port; this process owns the public port
 * and answers "which worker hosts room X" — clients connect straight to
 * the worker, so nothing relays frames in the hot path.
 *
 *   bun src/fleet.ts            # matchmaker on FPS_PORT, workers on +1..+N
 *   FPS_FLEET_WORKERS=4         # default: cpuCount-1, clamped 1..16
 *
 * Routes:
 *   GET  /join?room=X       → { url, http, room, worker } — claim-by-name,
 *                             least-CCU placement; omit room for any seat.
 *   GET  /join?mode=&map=   → { room, mode } — quick-join, same shape the
 *                             workers answer standalone: emptiest matching
 *                             room across the FLEET, else a minted name.
 *   GET  /rooms         → aggregated lobby rows across live workers.
 *   GET  /fleet         → worker/roster status JSON.
 *   POST /fleet/report  → worker heartbeat (loopback only).
 */
import { cpus } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import { FleetDirectory } from './fleetDir.ts';
import { corsResponse } from './serverRoutes.ts';
import { clientLogRoute } from './clientLogs.ts';
import { matchResultsRoute } from './matchResults.ts';
import { windowAllow } from './windowLimit.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';
import { readFileSync } from 'node:fs';

// Manifest version — same source the workers read (server_bun/package.json).
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const FLEET_VERSION = readVersion();

const WORKERS = Math.max(1, Math.min(16, Number(process.env.FPS_FLEET_WORKERS) || cpus().length - 1 || 1));
const BASE = CONFIG.port;

const dir = new FleetDirectory();
interface LobbyRow {
  name: string;
  mode?: string;
  map?: string;
  players?: number;
  humans?: number;
  maxPlayers?: number;
  names?: { id: string; name?: string }[];
}

// Lobby rows the last heartbeat carried per worker — the directory only
// tracks names/ccu; /rooms and quick-join serve the richer rows verbatim.
const lobbyRows = new Map<string, LobbyRow[]>();

// /join per-IP throttle — same flood concern as the workers' own join
// route: a GET spammer could mint unlimited pending claims / room names.
const joinIps = new Map<string, { count: number; start: number }>();
const JOIN_IP_LIMIT = 30; // every client load calls this once — looser than the workers' minting 5/min
const JOIN_IP_WINDOW_MS = 60_000;
/** Least-full reported room across live workers - the no-mint fallback
 *  seat when a joiner names nothing and minting is off (FPS_CLIENT_ROOMS=0). */
function leastFullRoom(): LobbyRow | undefined {
  let best: LobbyRow | undefined;
  for (const [id, rows] of lobbyRows) {
    if (!dir.workers.get(id)?.up) {continue;}
    for (const r of rows) {
      if ((r.players ?? 0) >= (r.maxPlayers ?? CONFIG.maxPlayers)) {continue;}
      if (!best || (r.players ?? 0) < (best.players ?? 0)) {best = r;}
    }
  }
  return best;
}

/** Busiest reported room with seats - the named-miss landing spot when
 *  minting is off. A joiner who asked for something should land where
 *  the game already is, not in the emptiest room. */
function busiestRoom(): LobbyRow | undefined {
  let best: LobbyRow | undefined;
  for (const [id, rows] of lobbyRows) {
    if (!dir.workers.get(id)?.up) {continue;}
    for (const r of rows) {
      if ((r.players ?? 0) >= (r.maxPlayers ?? CONFIG.maxPlayers)) {continue;}
      if (!best || (r.players ?? 0) > (best.players ?? 0)) {best = r;}
    }
  }
  return best;
}

function joinThrottleAllow(ip: string | undefined | null): boolean {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {return true;}
  return windowAllow(joinIps, ip, wallNow(), JOIN_IP_WINDOW_MS, JOIN_IP_LIMIT, 1024);
}

// ---- worker supervision -------------------------------------------------

interface Child { id: string; port: number; proc: ReturnType<typeof Bun.spawn> }
const children = new Map<string, Child>();
const crashStreak = new Map<string, number>();

function spawnWorker(id: string, port: number): void {
  const proc = Bun.spawn([process.execPath, join('src', 'server.ts')], {
    cwd: join(import.meta.dir, '..'),
    env: Object.assign({}, process.env, {FPS_PORT: String(port), FPS_WORKER_ID: id, FPS_FLEET_REPORT: `http://127.0.0.1:${BASE}/fleet/report`, FPS_WORKERS: String(WORKERS),
      // One UDP lane can't be shared by N workers on one box — each gets
      // its own port (9898→w0, 9899→w1, …) or the lane stays off.
      ...(process.env.FPS_UDP_PORT ? {FPS_UDP_PORT: String(Number(process.env.FPS_UDP_PORT) + (port - BASE - 1))} : {}),
      // Public WT is single-port: the box firewall forwards 443→BASE+1443,
      // and a QUIC session can't cross workers - only w0 can serve it.
      // Other workers would advertise a port that lands on w0's listener
      // and reject their tokens, so their WT stays off and /wthash
      // honestly reports disabled.
      FPS_WT_PORT: id === 'w0' ? String(BASE + 1443) : '0'}),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.set(id, { id, port, proc });
  const spawnedAt = wallNow();
  logger.info(`[fleet] worker ${id} spawned on :${port} (pid ${proc.pid})`);
  // Surviving a beat interval counts as healthy — crash-looping children
  // back off exponentially (cap 60s) instead of respawn-storming.
  proc.exited.then((code): void => {
    const lived = wallNow() - spawnedAt;
    const streak = (crashStreak.get(id) ?? 0);
    crashStreak.set(id, lived > FleetDirectory.BEAT_STALE_MS ? 0 : streak + 1);
    const delay = Math.min(60_000, 1000 << Math.min(streak, 6));
    logger.warn(`[fleet] worker ${id} exited (${code}) — respawning in ${delay}ms`);
    // The next beat gap flips it down in the directory; respawn quickly
    // so rooms it held re-open for placement rather than dangling.
    setTimeout((): void => spawnWorker(id, port), delay);
  return; }).catch((): void => undefined);
}

for (let i = 0; i < WORKERS; i += 1) {
  const id = `w${i}`;
  dir.register(id, BASE + 1 + i);
  spawnWorker(id, BASE + 1 + i);
}

// ---- matchmaker ----------------------------------------------------------

const FLEET_CAP = Number(process.env.FPS_FLEET_MAX_PLAYERS) || Infinity;
const fleetSeats = (): number => [...dir.workers.values()].reduce((a, w) => a + (w.up ? w.ccu : 0), 0);

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data: unknown, init?: ResponseInit): Response =>
  corsResponse(JSON.stringify(data), Object.assign({}, init, {headers: JSON_HEADERS}));

/** The scheme the client spoke to us — behind TLS the ws upgrade wants
 *  wss; behind the vite/cloudflare proxy the request arrives https. */
function clientSchemes(req: Request): { ws: string; http: string } {
  const secure = req.url.startsWith('https:')
    || req.headers.get('x-forwarded-proto') === 'https';
  return secure ? { ws: 'wss', http: 'https' } : { ws: 'ws', http: 'http' };
}

Bun.serve({
  port: BASE,
  hostname: '0.0.0.0',
  async fetch(req, srv): Promise<Response> {
    const url = new URL(req.url);
    const now = wallNow();

    if (req.method === 'OPTIONS') {return corsResponse(null, { status: 204 });}

    // Fleet-fronted clients (?server=host, no /wN path) resolve their
    // ship URL to the matchmaker - without this their WARN/ERROR stream
    // 404s and prod telemetry goes silent exactly when the fleet is used.
    if (url.pathname === '/client-log' && req.method === 'POST') {
      return clientLogRoute(req, corsResponse, srv.requestIP(req)?.address ?? '');
    }

    if (url.pathname === '/results' && req.method === 'POST') {
      return matchResultsRoute(req, corsResponse);
    }

    if (url.pathname === '/fleet/report' && req.method === 'POST') {
      const ip = srv.requestIP(req)?.address;
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return json({ error: 'loopback only' }, { status: 403 });
      }
      const body = await req.json().catch((): null => null) as
        { port?: number; ccu?: number; rooms?: unknown; list?: unknown; tlsPort?: number; draining?: boolean } | null;
      const w = [...dir.workers.values()].find((x): boolean => x.port === body?.port);
      if (!body || !w) {return json({ error: 'unknown worker' }, { status: 400 });}
      const names = Array.isArray(body.rooms) ? body.rooms.filter((r): r is string => typeof r === 'string') : [];
      dir.beat(w.id, names, typeof body.ccu === 'number' ? body.ccu : 0, now,
        typeof body.tlsPort === 'number' ? body.tlsPort : undefined,
        body.draining === true ? true : undefined);
      lobbyRows.set(w.id, Array.isArray(body.list) ? body.list as LobbyRow[] : []);
      return json({ ok: true });
    }

    if (url.pathname === '/join' && req.method === 'GET') {
      if (!joinThrottleAllow(srv.requestIP(req)?.address)) {
        return corsResponse('Too many joins', { status: 429 });
      }
      dir.sweep(now);
      // Each worker caps its own seats (FPS_GLOBAL_MAX_PLAYERS); only the sum needs this gate.
      if (fleetSeats() >= FLEET_CAP) {return json({ error: 'fleet full' }, { status: 503 });}
      // Quick-join shape (the worker's /join answers this standalone):
      // pick the emptiest matching room fleet-wide, else mint a name.
      // humans=1 (the client's /quickjoin) flips the pick to the busiest
      // room with humans in it — a live match, not the emptiest seat.
      const preferHumans = url.searchParams.get('humans') === '1';
      if (url.searchParams.has('mode') || url.searchParams.has('map') || preferHumans) {
        const mode = url.searchParams.get('mode') ?? '';
        const map = url.searchParams.get('map') ?? '';
        if (!/^[a-z0-9_-]{0,16}$/.test(mode) || !/^[a-z0-9_-]{0,32}$/.test(map)) {
          return corsResponse('Bad mode/map', { status: 400 });
        }
        let best: LobbyRow | undefined = undefined;
        let bestHumans = -1;
        for (const [id, rows] of lobbyRows) {
          if (!dir.workers.get(id)?.up) {continue;}
          for (const r of rows) {
            if (map && r.map !== map) {continue;}
            if (mode && r.mode !== mode) {continue;}
            if ((r.players ?? 0) >= (r.maxPlayers ?? CONFIG.maxPlayers)) {continue;}
            if (preferHumans) {
              const h = r.humans ?? 0;
              if (h === 0) {continue;}
              if (h > bestHumans) {best = r; bestHumans = h;}
              continue;
            }
            if (!best || (r.players ?? 0) < (best.players ?? 0)) {best = r;}
          }
        }
        let room = best?.name;
        if (!room && !CONFIG.clientRooms) {room = leastFullRoom()?.name;}
        if (!room && !CONFIG.clientRooms) {return json({ room: undefined, mode });}
        if (!room) {
          // Mint fleet-wide-unique — a name that exists on ANY worker or
          // sits in a pending claim would silently land joiners there.
          const base = map || mode || 'arena';
          const names = dir.roomNames();
          for (const rows of lobbyRows.values()) {for (const r of rows) {names.add(r.name);}}
          let n = 1;
          while (names.has(`${base}-${n}`)) {n += 1;}
          room = `${base}-${n}`;
        }
        const w = dir.resolve(room, now);
        if (!w) {return json({ error: 'no workers up' }, { status: 503 });}
        return json({ room, mode });
      }
      let room = url.searchParams.get('room') ?? undefined;
      // No-mint fleets: a bare join must reach a worker that HAS rooms -
      // least-CCU resolve can hand out an empty worker and the worker's
      // no-mint join then has nothing to land in ('Server full'). Same
      // for a client-supplied name that isn't a live room: substitute an
      // existing room instead of routing the name to a worker that
      // would mint it. Busiest-with-seats: a drop-in lands where the
      // game already is, not alone in the emptiest room.
      if (!CONFIG.clientRooms) {
        const names = dir.roomNames();
        for (const rows of lobbyRows.values()) {for (const r of rows) {names.add(r.name);}}
        if (!room || !names.has(room)) {room = busiestRoom()?.name ?? leastFullRoom()?.name;}
      }
      const w = dir.resolve(room, now);
      if (!w) {return json({ error: 'no workers up' }, { status: 503 });}
      const host = url.hostname;
      const s = clientSchemes(req);
      // A worker reporting a live direct-TLS listener gets its clients
      // straight there (wss://host:tlsPort/ws) - the path route's Caddy
      // decrypt+proxy hop disappears for game frames. Beats stop
      // reporting the port and routing falls back automatically.
      if (w.tlsPort) {
        return json({ url: `wss://${host}:${w.tlsPort}/ws`, http: `https://${host}:${w.tlsPort}`, room, worker: w.id });
      }
      // FPS_FLEET_PATH=1: workers sit behind an edge path route (/w0/ws →
      // :8001) — the public host only exposes 443. Default keeps
      // host:port for LAN/direct deployment.
      if (process.env.FPS_FLEET_PATH) {
        return json({ url: `${s.ws}://${host}/${w.id}/ws`, http: `${s.http}://${host}/${w.id}`, room, worker: w.id });
      }
      return json({ url: `${s.ws}://${host}:${w.port}/ws`, http: `${s.http}://${host}:${w.port}`, room, worker: w.id });
    }

    // /health aggregates what a single server.ts would report — the deploy
    // script and server browser expect this shape on the public port.
    if (url.pathname === '/health' && req.method === 'GET') {
      dir.sweep(now);
      let players = 0, workersUp = 0;
      for (const w of dir.workers.values()) {
        if (w.up) {workersUp++; players += w.ccu;}
      }
      let build: string | null = null;
      try { build = (await Bun.file(join(import.meta.dir, '..', 'build.txt')).text()).trim(); } catch { /* no stamp */ }
      return json({ status: workersUp > 0 ? 'running' : 'degraded', players, maxPlayers: Number.isFinite(FLEET_CAP) ? FLEET_CAP : WORKERS * CONFIG.globalMaxPlayers, tickRate: 20, version: FLEET_VERSION, build, bun: Bun.version, workers: workersUp, fleet: WORKERS });
    }

    if (url.pathname === '/rooms' && req.method === 'GET') {
      dir.sweep(now);
      const rows = [...lobbyRows.entries()]
        .filter(([id]): boolean | undefined => dir.workers.get(id)?.up)
        .flatMap(([, list]): LobbyRow[] => list);
      return json(rows);
    }

    if (url.pathname === '/fleet' && req.method === 'GET') {
      dir.sweep(now);
      return json({ workers: dir.status() });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
});

logger.info(`[fleet] matchmaker on :${BASE}, ${WORKERS} worker(s) on :${BASE + 1}..:${BASE + WORKERS}`);
