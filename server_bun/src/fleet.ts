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
 *   GET  /join?room=X   → { url, http, room, worker } — claim-by-name,
 *                         least-CCU placement; omit room for any seat.
 *   GET  /rooms         → aggregated lobby rows across live workers.
 *   GET  /fleet         → worker/roster status JSON.
 *   POST /fleet/report  → worker heartbeat (loopback only).
 */
import { cpus } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import { FleetDirectory } from './fleetDir.ts';
import { corsResponse } from './serverRoutes.ts';
import { logger } from './logger.ts';
import { wallNow } from './wallClock.ts';

const WORKERS = Math.max(1, Math.min(16, Number(process.env.FPS_FLEET_WORKERS) || cpus().length - 1 || 1));
const BASE = CONFIG.port;

const dir = new FleetDirectory();
// Lobby rows the last heartbeat carried per worker — the directory only
// tracks names/ccu; /rooms serves the richer rows verbatim.
const lobbyRows = new Map<string, unknown[]>();

// ---- worker supervision -------------------------------------------------

interface Child { id: string; port: number; proc: ReturnType<typeof Bun.spawn> }
const children = new Map<string, Child>();

function spawnWorker(id: string, port: number): void {
  const proc = Bun.spawn(['bun', join('src', 'server.ts')], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      FPS_PORT: String(port),
      FPS_FLEET_REPORT: `http://127.0.0.1:${BASE}/fleet/report`,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.set(id, { id, port, proc });
  logger.info(`[fleet] worker ${id} spawned on :${port} (pid ${proc.pid})`);
  void proc.exited.then((code) => {
    logger.warn(`[fleet] worker ${id} exited (${code}) — respawning in 1s`);
    // The next beat gap flips it down in the directory; respawn quickly
    // so rooms it held re-open for placement rather than dangling.
    setTimeout(() => spawnWorker(id, port), 1_000);
  });
}

for (let i = 0; i < WORKERS; i++) {
  const id = `w${i}`;
  dir.register(id, BASE + 1 + i);
  spawnWorker(id, BASE + 1 + i);
}

// ---- matchmaker ----------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const json = (data: unknown, init?: ResponseInit) =>
  corsResponse(JSON.stringify(data), { ...init, headers: JSON_HEADERS });

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
  async fetch(req, srv) {
    const url = new URL(req.url);
    const now = wallNow();

    if (req.method === 'OPTIONS') {return corsResponse(null, { status: 204 });}

    if (url.pathname === '/fleet/report' && req.method === 'POST') {
      const ip = srv.requestIP(req)?.address;
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return json({ error: 'loopback only' }, { status: 403 });
      }
      const body = await req.json().catch(() => null) as
        { port?: number; ccu?: number; rooms?: string[]; list?: unknown[] } | null;
      const w = [...dir.workers.values()].find((x) => x.port === body?.port);
      if (!body || !w) {return json({ error: 'unknown worker' }, { status: 400 });}
      dir.beat(w.id, Array.isArray(body.rooms) ? body.rooms : [], body.ccu ?? 0, now);
      lobbyRows.set(w.id, Array.isArray(body.list) ? body.list : []);
      return json({ ok: true });
    }

    if (url.pathname === '/join' && req.method === 'GET') {
      const room = url.searchParams.get('room') ?? undefined;
      const w = dir.resolve(room, now);
      if (!w) {return json({ error: 'no workers up' }, { status: 503 });}
      const host = url.hostname;
      const s = clientSchemes(req);
      return json({ url: `${s.ws}://${host}:${w.port}/ws`, http: `${s.http}://${host}:${w.port}`, room, worker: w.id });
    }

    if (url.pathname === '/rooms' && req.method === 'GET') {
      dir.resolve(undefined, now); // sweep stale workers first
      const rows = [...lobbyRows.entries()]
        .filter(([id]) => dir.workers.get(id)?.up)
        .flatMap(([, list]) => list);
      return json(rows);
    }

    if (url.pathname === '/fleet' && req.method === 'GET') {
      dir.resolve(undefined, now);
      return json({ workers: dir.status() });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
});

logger.info(`[fleet] matchmaker on :${BASE}, ${WORKERS} worker(s) on :${BASE + 1}..:${BASE + WORKERS}`);
