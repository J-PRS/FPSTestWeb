// Resolve backend endpoints: ?server=<host> URL param wins, then public/server.json,
// else fall back to same-host:8000 for local dev.
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

// Fleet deployment: the matchmaker (fleet.ts) sits on the base port and
// hands each client its room's worker — connect straight to the worker so
// nothing relays frames. ?fleet or server.json {"fleet": true} opts in;
// any failure falls back to treating the host as a standalone server.
/** Named servers — the /<alias>/<room> path resolves through this table
 *  (populated from server.json "servers") so links read /jp/rimrock-1
 *  instead of ?server=ws://…. Empty in-repo: real hosts are deploy
 *  config, not source. */
export const NAMED_SERVERS: Record<string, string> = {
  pub: 'https://play.jprice.app',
};

export interface ServerEndpoints {
  wsUrl: string;
  httpUrl: string;
  /** Fleet only: the matchmaker's base — fleet-wide listings (/rooms,
   *  quick-join) live there; httpUrl points at your room's worker. */
  lobbyUrl?: string;
  /** Fleet resolved — live in-worker room hops can't cross processes,
   *  so room joins must go back through the matchmaker. */
  fleet?: boolean;
}

async function resolveFleet(httpUrl: string): Promise<ServerEndpoints | null> {
  try {
    const room = urlParams.get('room') ?? '';
    const r = await fetch(`${httpUrl}/join?room=${encodeURIComponent(room)}`, { cache: 'no-cache' });
    if (!r.ok) {return null;}
    const j = await r.json() as { url?: string; http?: string };
    if (!j.url || !j.http) {return null;}
    return { wsUrl: j.url, httpUrl: j.http, lobbyUrl: httpUrl, fleet: true };
  } catch { return null; }
}



/** Re-resolve a live worker URL — the reconnect path's resolveUrl hook. */
export async function fleetWorkerUrl(httpUrl: string): Promise<string | null> {
  return (await resolveFleet(httpUrl))?.wsUrl ?? null;
}

async function isUp(httpUrl: string): Promise<boolean> {
  return fetch(`${httpUrl}/health`, { signal: AbortSignal.timeout(800) }).then((r): boolean => r.ok, (): boolean => false);
}

export async function resolveServerEndpoints(): Promise<ServerEndpoints> {
  const pick = await pickHost();
  if ('ep' in pick) {return pick.ep;}
  const { host, fleet } = pick;
  const done = async (ep: ServerEndpoints): Promise<ServerEndpoints> => (fleet ? await resolveFleet(ep.httpUrl) : null) ?? ep;

  // Explicit ws(s) URL wins outright — devs targeting a plain-ws box on a
  // public IP (no TLS cert for a bare IP) get the exact scheme they typed
  // instead of the hostname heuristics guessing TLS.
  if (/^wss?:\/\//i.test(host)) {return done(explicitWsEp(host));}
  // LAN/plain hosts — localhost, private IPs — can't ride the tunnel's
  // wss/https rewrite; hitting them with wss just fails the handshake
  // silently (botwatch hit this on :8460). Judge the HOSTNAME, not the
  // port: a public FQDN with an explicit port (tailscale funnel :10000)
  // is still TLS — ws:// on it just gets the handshake reset.
  if (lanHost(host)) {
    const h = host.replace(/^https?:\/\//, '');
    return done({ wsUrl: `ws://${h}/ws`, httpUrl: `http://${h}` });
  }
  return done(publicHostEp(host));
}

/** Host resolution chain: origin/pool/saved/server.json/named-path into
 *  a bare host + fleet flag - or an early {ep} when the answer is local
 *  (loopback dev server up, or no host anywhere). */
async function pickHost(): Promise<{ ep: ServerEndpoints } | { host: string; fleet: boolean }> {
  const hn = window.location.hostname || 'localhost';
  // Served through the cloudflared preview tunnel: the API rides the same
  // origin via the vite proxy (see vite.config.js server.proxy).
  const local = localEp(hn);
  let host = savedHost();
  // A remote host is a fleet matchmaker unless it answers no /join, which
  // falls back to the direct URL below — so default on, not behind ?fleet.
  let fleet = urlParams.has('fleet') || host.length > 0;
  // Localhost pages prefer the dev server when it answers; prod is the fallback.
  if (!host && !urlParams.serverPath && localPage(hn) && await isUp(local.httpUrl)) {return { ep: local };}
  const { host: cfgHost, fleet: cfgFleet } = await hostConfig(host, urlParams.serverPath);
  host = cfgHost;
  if (cfgFleet) {fleet = true;}
  if (urlParams.serverPath) {host = NAMED_SERVERS[urlParams.serverPath] ?? '';}
  // Any non-empty host from any source (?server, saved, server.json,
  // named path) is remote-of-some-sort — resolve it through the fleet
  // matchmaker first; resolveFleet's failure falls back to the direct
  // URL below, so non-fleet boxes are unaffected.
  if (host.length > 0) {fleet = true;}
  if (!host) {return { ep: (fleet ? await resolveFleet(local.httpUrl) : null) ?? local };}
  return { host, fleet };
}
/** ?server= wins (shareable link); the lobby's saved host is the
 *  standing choice so nobody has to edit a URL to switch servers.
 *  /quickplay|/quickjoin mean "the public pool" — a saved localhost
 *  pick would send friends to a server that only exists on the
 *  host's own machine, so those paths ignore the saved host. */
function savedHost(): string {
  const publicPool = /^\/(quickplay|quickjoin)\b/.test(window.location.pathname);
  return urlParams.get('server')?.trim() || (publicPool ? '' : settings.get('fps-server').trim());
}

/** Local endpoints from the page hostname: same-origin API on any https
 *  page (tunnels/proxies route /ws - host keeps the :port, hostname drops
 *  it and funnels land on the wrong listener; ws://host:8000 is a
 *  dev-page guess - on https it's unreachable AND mixed-content poison). */
function localEp(hn: string): ServerEndpoints {
  return window.location.protocol === 'https:'
    ? { wsUrl: `wss://${window.location.host}/ws`, httpUrl: `https://${window.location.host}` }
    : { wsUrl: `ws://${hn}:8000/ws`, httpUrl: `http://${hn}:8000` };
}

/** Page origin is the loopback dev host. */
function localPage(hn: string): boolean {
  return hn === 'localhost' || hn === '127.0.0.1';
}

/** Host string points at a LAN/plain box: localhost, private IPs, or a
 *  port-only tail with no dots. */
function lanHost(host: string): boolean {
  return /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host)
      || (host.includes(':') && !host.includes('.'));
}

/** server.json override: fetched only when no stronger host source
 *  (?server=, saved pick) and used for ?serverPath named routes. */
async function hostConfig(host: string, serverPath: string | null): Promise<{ host: string; fleet: boolean }> {
  let fleet = false;
  // Fetch /server.json whenever a host is still needed: cfg.server is the
  // documented prod fallback ("prefer dev server; prod is the fallback")
  // and the fleet flag/servers table ride the same file. Early-returning
  // on empty host left cfg.server dead - a tunnel page with no explicit
  // server fell to same-host:8000 guessing instead of its real backend.
  if (host && !serverPath) {return { host, fleet };}
  let out = host;
  try {
    const cfg = await fetch('/server.json', { cache: 'no-cache' }).then((r): Promise<{ server?: string; fleet?: boolean; servers?: Record<string, string> }> => r.json());
    // ?server=/saved pick is the stronger source: server.json only fills
    // a host nobody asked for. Unconditionally overwriting here silently
    // re-routed every ?server= link (and every e2e stack) to the deploy's
    // public box the moment public/server.json gained a "server" field.
    out = host || cfg.server?.trim() || '';
    if (cfg.fleet) {fleet = true;}
    if (cfg.servers) {Object.assign(NAMED_SERVERS, cfg.servers);}
  } catch { /* no server.json — stay local */ }
  return { host: out, fleet };
}

/** Explicit ws(s)://host[:port][/path] → endpoints verbatim. */
function explicitWsEp(host: string): ServerEndpoints {
  const u = new URL(host);
  const base = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return {
    wsUrl: `${u.protocol}//${base}${u.pathname === '/' ? '/ws' : u.pathname}`,
    httpUrl: `${u.protocol === 'wss:' ? 'https' : 'http'}://${base}`,
  };
}

/** Public host:port — TLS regardless of port (tailscale funnel etc.);
 *  a bare name like ?server=foo-bar-baz assumes a trycloudflare quick
 *  tunnel. */
function publicHostEp(host: string): ServerEndpoints {
  let h = host.replace(/^https?:\/\//, '');
  if (!h.includes(':') && !h.includes('.')) {h = `${h}.trycloudflare.com`;}
  return { wsUrl: `wss://${h}/ws`, httpUrl: `https://${h}` };
}
