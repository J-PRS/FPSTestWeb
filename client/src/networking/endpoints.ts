// Resolve backend endpoints: ?server=<host> URL param wins, then public/server.json,
// else fall back to same-host:8000 for local dev.
import { urlParams } from '../core/params.js';
import { settings } from '../core/settings.js';

export async function resolveServerEndpoints(): Promise<{ wsUrl: string; httpUrl: string }> {
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
  if (!host) {
    try {
      const cfg = await fetch('server.json', { cache: 'no-cache' }).then((r) => r.json()) as { server?: string };
      host = cfg.server?.trim() ?? '';
    } catch { /* no server.json — stay local */ }
  }
  if (!host) {return local;}
  // LAN/plain hosts — localhost, private IPs, anything with an explicit
  // port — can't ride the tunnel's wss/https rewrite; hitting them with
  // wss just fails the handshake silently (botwatch hit this on :8460).
  if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host) || host.includes(':')) {
    const h = host.replace(/^https?:\/\//, '');
    return { wsUrl: `ws://${h}/ws`, httpUrl: `http://${h}` };
  }
  // Bare name like ?server=foo-bar-baz → assume a trycloudflare quick tunnel
  if (!host.includes('.')) {host = `${host}.trycloudflare.com`;}
  return { wsUrl: `wss://${host}/ws`, httpUrl: `https://${host}` };
}
