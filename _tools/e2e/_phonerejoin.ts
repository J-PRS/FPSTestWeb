// Persist the mobile-gate bypass on the phone, reload, wait for the match
// seat, reveal HUD, screenshot. Raw page-target CDP (page attach can't
// stall on wedged workers).
import { writeFileSync } from 'node:fs';
const r = await fetch('http://localhost:9333/json');
const t = await r.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
const g = [...t].reverse().find(x => x.type === 'page' && x.url.includes('5400'));
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

// Set the persistent gate bypass, then reload into the match.
console.log(await evalJs(`(localStorage.setItem('fps-nomobile','1'), 'flag set')`));
await send('Page.enable');
await send('Page.reload');
// Wait for the seat (poll — no waitForFunction in raw CDP)
{
  const t0 = Date.now(); let ok = false;
  while (Date.now() - t0 < 120000) {
    ok = await evalJs('!!(window.__test && window.__test.player)').catch(() => false) as boolean;
    if (ok) { break; }
    await new Promise(x => setTimeout(x, 1000));
  }
  console.log(ok ? 'seat landed' : 'WARN no seat in 120s');
}
// Reveal HUD (pointerlock can't fire on touch).
console.log(await evalJs(`(() => { const o = document.getElementById('overlay'); if (o) { o.style.display = 'none'; } document.body.classList.remove('menu-open'); return 'hud'; })()`));
await new Promise(x => setTimeout(x, 8000));
const shot = await send('Page.captureScreenshot', { format: 'png' }) as { data: string } | undefined;
if (shot?.data) { writeFileSync('_phonescreen.png', Buffer.from(shot.data, 'base64')); console.log('shot _phonescreen.png'); }
process.exit(0);
