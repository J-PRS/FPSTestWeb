// Launch an OFFLINE match on the phone — solo modes (?mode=X) need no
// server, no reconnect veil, instant retries. Reveals the HUD.
//   bun _tools/e2e/_phonego.ts [url]
const url = process.argv[2] ?? 'http://localhost:5400/?mode=ctf&bots=8&nomobile=1';
const r = await fetch('http://localhost:9333/json');
const t = await r.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
const g = [...t].reverse().find(x => x.type === 'page' && x.url.includes('5400'))
  ?? [...t].reverse().find(x => x.type === 'page');
if (!g) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(g.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map<number, (v: unknown) => void>();
ws.onmessage = (m): void => {
  const d = JSON.parse(String(m.data)) as { id?: number; result?: unknown };
  if (d.id && pend.has(d.id)) { pend.get(d.id)!(d.result); pend.delete(d.id); }
};
const send = (method: string, params: Record<string, unknown> = {}): Promise<never> =>
  new Promise(res => { const id = ++seq; pend.set(id, res as never); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr: string): Promise<unknown> =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true }) as { result: { value: unknown } }).result.value;
await new Promise(x => { ws.onopen = x; });
await send('Page.enable');
await send('Page.navigate', { url });
const t0 = Date.now(); let ok = false;
while (Date.now() - t0 < 90000) {
  ok = await evalJs('!!(window.__test && window.__test.player)').catch(() => false) as boolean;
  if (ok) { break; }
  await new Promise(x => setTimeout(x, 1000));
}
console.log(ok ? 'seat landed' : 'WARN no seat in 90s');
// HUD: overlay can't dismiss itself on touch; veil is absent offline.
console.log(await evalJs(`(() => { const o = document.getElementById('overlay'); if (o) { o.style.display = 'none'; } document.body.classList.remove('menu-open'); const v = document.getElementById('session-veil'); if (v) { v.style.display = 'none'; } return 'hud on'; })()`));
process.exit(0);
