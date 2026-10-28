// Static host for client/public on 127.0.0.1:5500 — tailscale serve proxies
// the tailnet port here. servers.html pulls its data from play.jprice.app,
// so the static files are all this needs. Bare "/" lands on servers.html.
const ROOT = new URL('../client/public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = Number(process.env.PORT ?? 5500);

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname;
    const rel = path === '/' ? 'servers.html' : decodeURIComponent(path).replace(/^\/+/, '');
    if (rel.includes('..')) {return new Response('bad path', { status: 400 });}
    const file = Bun.file(ROOT + rel);
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
  },
});
console.log(`servers.html on http://127.0.0.1:${PORT}`);
