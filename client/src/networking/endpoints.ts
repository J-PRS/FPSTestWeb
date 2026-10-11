// Resolve backend endpoints: ?server=<host> URL param wins, then public/server.json,
// else fall back to same-host:8000 for local dev.
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

// Fleet deployment: the matchmaker (fleet.ts) sits on the base port and
// hands each client its room's worker — connect straight to the worker so
// nothing relays frames. ?fleet or server.json {"fleet": true} opts in;
// any failure falls back to treating the host as a standalone server.
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

/** Re-resolve a live worker URL — the reconnect path's resolveUrl hook. */
export async function fleetWorkerUrl(httpUrl: string): Promise<string | null> {
  return (await resolveFleet(httpUrl))?.wsUrl ?? null;
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

export async function resolveServerEndpoints(): Promise<ServerEndpoints> {
  const hn = window.location.hostname || 'localhost';
  // Served through the cloudflared preview tunnel: the API rides the same
  // origin via the vite proxy (see vite.config.js server.proxy).
  const local = hn.endsWith('.trycloudflare.com')
    ? { wsUrl: `wss://${hn}/ws`, httpUrl: `https://${hn}` }
    : {
      wsUrl: `ws://${hn}:8000/ws`,
      httpUrl: `http://${hn}:8000`,
    };
  // ?server= wins (shareable link); the lobby's saved host is the
  // standing choice so nobody has to edit a URL to switch servers.
  let host = (urlParams.get('server')?.trim() || settings.get('fps-server').trim());
  let fleet = urlParams.has('fleet');
  if (!host) {
    try {
      const cfg = await fetch('server.json', { cache: 'no-cache' }).then((r): Promise<any> => r.json()) as { server?: string; fleet?: boolean };
      host = cfg.server?.trim() ?? '';
      if (cfg.fleet) {fleet = true;}
    } catch { /* no server.json — stay local */ }
  }
  if (!host) {return (fleet ? await resolveFleet(local.httpUrl) : null) ?? local;}

  // LAN/plain hosts — localhost, private IPs, anything with an explicit
  // port — can't ride the tunnel's wss/https rewrite; hitting them with
  // wss just fails the handshake silently (botwatch hit this on :8460).
  if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host) || host.includes(':')) {
    const h = host.replace(/^https?:\/\//, '');
    const ep = { wsUrl: `ws://${h}/ws`, httpUrl: `http://${h}` };
    return (fleet ? await resolveFleet(ep.httpUrl) : null) ?? ep;
  }
  // Bare name like ?server=foo-bar-baz → assume a trycloudflare quick tunnel
  if (!host.includes('.')) {host = `${host}.trycloudflare.com`;}
  const ep = { wsUrl: `wss://${host}/ws`, httpUrl: `https://${host}` };
  return (fleet ? await resolveFleet(ep.httpUrl) : null) ?? ep;
}
