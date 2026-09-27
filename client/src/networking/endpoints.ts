// Resolve backend endpoints: ?server=<host> URL param wins, then public/server.json,
// else fall back to same-host:8000 for local dev.
export async function resolveServerEndpoints(): Promise<{ wsUrl: string; httpUrl: string }> {
  const local = {
    wsUrl: `ws://${window.location.hostname || 'localhost'}:8000/ws`,
    httpUrl: `http://${window.location.hostname || 'localhost'}:8000`,
  };
  let host = new URLSearchParams(window.location.search).get('server')?.trim() ?? '';
  if (!host) {
    try {
      const cfg = await fetch('server.json', { cache: 'no-cache' }).then((r) => r.json()) as { server?: string };
      host = cfg.server?.trim() ?? '';
    } catch { /* no server.json — stay local */ }
  }
  if (!host) return local;
  // Bare name like ?server=foo-bar-baz → assume a trycloudflare quick tunnel
  if (!host.includes('.')) host = `${host}.trycloudflare.com`;
  return { wsUrl: `wss://${host}/ws`, httpUrl: `https://${host}` };
}
