// Endpoint smoke: do the three socket paths accept connections?
//   bun tools/_relaycheck.ts                          (localhost)
//   bun tools/_relaycheck.ts accommodate-rna-pads-fired   (tunnel host)
const host = process.argv[2] ?? 'localhost:8000';
const base = host.includes('://') ? host.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  : host.includes('.') ? `wss://${host.includes('trycloudflare') ? host : host + '.trycloudflare.com'}`
    : `ws://${host}`;
for (const path of ['/ws', '/rtc?room=abc', '/rtcs']) {
  const ws = new WebSocket(`${base}${path}`);
  ws.onopen = () => { console.log(path, 'OPEN'); ws.close(); };
  ws.onerror = () => console.log(path, 'ERR');
  ws.onclose = (e) => console.log(path, 'CLOSE', e.code, e.reason);
}
await new Promise(r => setTimeout(r, 3000));
