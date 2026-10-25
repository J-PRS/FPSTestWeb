import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { makeRoutes, adminRoute } from '../src/serverRoutes.ts';
import type { HttpCtx } from '../src/serverRoutes.ts';
import { CONFIG } from '../src/config.ts';
import type { Room } from '../src/Room.ts';

// Public-route guards, pinned black-box through makeRoutes: the /join
// per-IP throttle (re-opens the room-mint flood if it regresses), the
// ops gate on metrics/status/weaponstats, and the join validators.
const gameServer = {
  getHealthStatus: () => ({}),
  getMetrics: () => ({}),
  getServerInfo: () => ({}),
  listRooms: () => [],
  listMatches: () => [],
  getStats: async () => [],
  listMaps: () => [],
  hasMap: (m: string) => m === 'ok',
  quickRoom: () => ({ name: 'r1', mode: 'ctf' }) as unknown as Room,
} as unknown as HttpCtx['gameServer'];

function ctx(ip?: string): HttpCtx {
  return {
    gameServer,
    rtcRelay: { lobbies: () => [] } as unknown as HttpCtx['rtcRelay'],
    demoStorage: { listDemos: async () => [] } as unknown as HttpCtx['demoStorage'],
    wtCertHash: () => null,
    requestIP: () => ip ? { address: ip } : null,
  };
}

const url = (p: string) => new URL(`http://srv${p}`);
const req = (p: string, headers?: Record<string, string>) => new Request(`http://srv${p}`, { headers });

afterEach(() => {
  (CONFIG as unknown as { adminToken: string }).adminToken = '';
});

describe('route guards', () => {
  it('/join throttles one IP to 20 mints per minute', async () => {
    const routes = makeRoutes(ctx('9.9.9.1'));
    const join = routes['/join']!;
    let last!: Response;
    for (let i = 0; i < 20; i++) {
      last = await join(url('/join?mode=ctf&map=ok'), req('/join'));
      expect(last.status).toBe(200);
    }
    last = await join(url('/join?mode=ctf&map=ok'), req('/join'));
    expect(last.status).toBe(429);
  });

  it('/join never throttles localhost', async () => {
    const routes = makeRoutes(ctx('127.0.0.1'));
    const join = routes['/join']!;
    for (let i = 0; i < 8; i++) {
      expect((await join(url('/join?mode=ctf'), req('/join'))).status).toBe(200);
    }
  });

  it('/join rejects bad mode and unknown maps', async () => {
    const routes = makeRoutes(ctx('9.9.9.2'));
    const join = routes['/join']!;
    expect((await join(url('/join?mode=ctf!!'), req('/join'))).status).toBe(400);
    expect((await join(url('/join?map=notreal'), req('/join'))).status).toBe(400);
  });

  it('ops routes need the admin token when one is set', async () => {
    (CONFIG as unknown as { adminToken: string }).adminToken = 'tok';
    const routes = makeRoutes(ctx('9.9.9.3'));
    for (const p of ['/metrics', '/status', '/weaponstats']) {
      expect((await routes[p]!(url(p), req(p))).status).toBe(401);
    }
    // Bearer opens it from anywhere; ?key= only from loopback — remote
    // query tokens leak through logs/caches/Referer.
    expect((await routes['/metrics']!(url('/metrics'), req('/metrics', { authorization: 'Bearer tok' }))).status).toBe(200);
    expect((await routes['/metrics']!(url('/metrics?key=tok'), req('/metrics'))).status).toBe(401);
    expect((await routes['/metrics']!(url('/metrics?key=wrong'), req('/metrics'))).status).toBe(401);
    const local = makeRoutes(ctx('127.0.0.1'));
    expect((await local['/metrics']!(url('/metrics?key=tok'), req('/metrics'))).status).toBe(200);
  });

  it('ops routes stay open in dev when the token is unset', async () => {
    const routes = makeRoutes(ctx('9.9.9.4'));
    expect((await routes['/metrics']!(url('/metrics'), req('/metrics'))).status).toBe(200);
  });

  it('admin API is closed without a token and 401s on a wrong one', async () => {
    const post = (auth?: string) => adminRoute(ctx('9.9.9.5'),
      req('/admin/rooms', auth ? { authorization: `Bearer ${auth}` } : undefined),
      url('/admin/rooms'));
    expect((await post('tok')).status).toBe(403); // token unset = disabled
    (CONFIG as unknown as { adminToken: string }).adminToken = 'tok';
    expect((await post()).status).toBe(401);
    expect((await post('wrong')).status).toBe(401);
    expect((await post('tok')).status).toBe(200);
  });

  it('/admin/heapdump writes a JSC snapshot and stays token-gated', async () => {
    const heapReq = () => adminRoute(ctx('127.0.0.1'),
      new Request('http://srv/admin/heapdump', { method: 'POST', headers: { authorization: 'Bearer tok' } }),
      url('/admin/heapdump'));
    (CONFIG as unknown as { adminToken: string }).adminToken = 'tok';
    const res = await heapReq();
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; file: string };
    expect(body.file).toMatch(/^_heapdumps\/heap-\d+\.heapsnapshot$/);
    rmSync(body.file);
    // GET is POST-only on admin actions.
    const get = await adminRoute(ctx(), req('/admin/heapdump', { authorization: 'Bearer tok' }), url('/admin/heapdump'));
    expect(get.status).toBe(405);
  });
});
