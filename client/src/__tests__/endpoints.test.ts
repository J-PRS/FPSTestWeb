// Endpoint-resolution regressions for the mixed-content poison chain:
// a public-host page with no explicit server must read server.json's
// cfg.server, and must never produce ws://+http:// endpoints on https.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { resolveServerEndpoints } from '../networking/endpoints.js';
import { invalidateUrlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

const loc = window as unknown as { location: { search: string; pathname: string; hostname: string; host: string; protocol: string } };
const realFetch = globalThis.fetch;

const setLoc = (opts: { hostname: string; host?: string; protocol?: string; pathname?: string; search?: string }): void => {
  loc.location.hostname = opts.hostname;
  loc.location.host = opts.host ?? opts.hostname;
  loc.location.protocol = opts.protocol ?? 'http:';
  loc.location.pathname = opts.pathname ?? '/';
  loc.location.search = opts.search ?? '';
  invalidateUrlParams();
};

/** fetch stub keyed on URL substring; unmatched URLs fail like dead routes. */
const stubFetch = (table: Record<string, unknown>): void => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [k, body] of Object.entries(table)) {
      if (url.includes(k)) {return new Response(JSON.stringify(body), { status: 200 });}
    }
    return new Response('not found', { status: 404 });
  });
};

beforeEach((): void => {
  settings.set('fps-server', '');
});

afterEach((): void => {
  vi.stubGlobal('fetch', realFetch);
  setLoc({ hostname: 'localhost' });
});

describe('resolveServerEndpoints', (): void => {
  it('https page, no explicit host: reads cfg.server from /server.json (was dead config)', async (): Promise<void> => {
    setLoc({ hostname: 'jp-oooff.tailaba354.ts.net', host: 'jp-oooff.tailaba354.ts.net:10000', protocol: 'https:', pathname: '/quickplay' });
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes('/server.json')) {return new Response(JSON.stringify({ server: 'https://play.jprice.app' }), { status: 200 });}
      if (url.includes('/join')) {return new Response(JSON.stringify({ url: 'wss://play.jprice.app:8443/ws', http: 'https://play.jprice.app:8443' }), { status: 200 });}
      return new Response('not found', { status: 404 });
    });
    const ep = await resolveServerEndpoints();
    // The dead-config regression: early return skipped /server.json for
    // empty host and the whole session landed on same-host:8000 poison.
    expect(calls.some((u) => u.includes('/server.json'))).toBe(true);
    expect(ep.wsUrl).toBe('wss://play.jprice.app:8443/ws');
    expect(ep.httpUrl).toBe('https://play.jprice.app:8443');
  });

  it('https page, no config at all: same-origin wss/https, never ws://host:8000', async (): Promise<void> => {
    setLoc({ hostname: 'jp-oooff.tailaba354.ts.net', host: 'jp-oooff.tailaba354.ts.net:10000', protocol: 'https:', pathname: '/quickplay' });
    stubFetch({}); // everything 404s - no server.json, no dev server
    const ep = await resolveServerEndpoints();
    // Mixed-content poison: http:// API on an https page died silently.
    expect(ep.httpUrl.startsWith('https://')).toBe(true);
    expect(ep.wsUrl.startsWith('wss://')).toBe(true);
    // Port survives - hostname alone lands the funnel's :443 listener.
    expect(ep.httpUrl).toBe('https://jp-oooff.tailaba354.ts.net:10000');
    expect(ep.wsUrl).toBe('wss://jp-oooff.tailaba354.ts.net:10000/ws');
  });

  it('http localhost dev page: same-host:8000 convention preserved', async (): Promise<void> => {
    setLoc({ hostname: 'localhost' });
    stubFetch({}); // dev server down AND no server.json
    const ep = await resolveServerEndpoints();
    expect(ep.wsUrl).toBe('ws://localhost:8000/ws');
    expect(ep.httpUrl).toBe('http://localhost:8000');
  });

  it('localhost dev down but server.json names a host: prod is the fallback', async (): Promise<void> => {
    setLoc({ hostname: 'localhost' });
    stubFetch({ '/server.json': { server: 'https://play.jprice.app' }, '/join': { url: 'wss://play.jprice.app:8443/ws', http: 'https://play.jprice.app:8443' } });
    const ep = await resolveServerEndpoints();
    expect(ep.wsUrl).toBe('wss://play.jprice.app:8443/ws');
  });

  it('explicit ?server= wins over server.json', async (): Promise<void> => {
    setLoc({ hostname: 'jp-oooff.tailaba354.ts.net', host: 'jp-oooff.tailaba354.ts.net:10000', protocol: 'https:', pathname: '/', search: '?server=play.jprice.app' });
    stubFetch({ '/server.json': { server: 'https://other.example' }, '/join': { url: 'wss://play.jprice.app:8443/ws', http: 'https://play.jprice.app:8443' } });
    const ep = await resolveServerEndpoints();
    expect(ep.wsUrl).toBe('wss://play.jprice.app:8443/ws');
    expect(ep.httpUrl).toBe('https://play.jprice.app:8443');
  });
});
