import { describe, it, expect, afterEach } from 'bun:test';
import { makeRoutes } from '../src/serverRoutes.ts';
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
  it('/join throttles one IP to 5 mints per minute', async () => {
    const routes = makeRoutes(ctx('9.9.9.1'));
    const join = routes['/join']!;
    let last!: Response;
    for (let i = 0; i < 5; i++) {
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
    // Bearer or ?key= both open it.
    expect((await routes['/metrics']!(url('/metrics'), req('/metrics', { authorization: 'Bearer tok' }))).status).toBe(200);
    expect((await routes['/metrics']!(url('/metrics?key=tok'), req('/metrics'))).status).toBe(200);
    expect((await routes['/metrics']!(url('/metrics?key=wrong'), req('/metrics'))).status).toBe(401);
  });

  it('ops routes stay open in dev when the token is unset', async () => {
    const routes = makeRoutes(ctx('9.9.9.4'));
    expect((await routes['/metrics']!(url('/metrics'), req('/metrics'))).status).toBe(200);
  });
});
