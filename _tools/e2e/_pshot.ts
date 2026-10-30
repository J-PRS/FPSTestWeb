import { writeFileSync } from 'node:fs';
const r = await fetch('http://localhost:9333/json');
const t = await r.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
const g = t.find(x => x.type === 'page' && x.url.includes('5400'));
if (!g) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(g.webSocketDebuggerUrl);
await new Promise(x => { ws.onopen = x; });
ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
ws.onmessage = (m): void => {
  const d = JSON.parse(String(m.data)) as { id?: number; result?: { data?: string } };
  if (d.id === 1) { writeFileSync('_phonescreen.png', Buffer.from(d.result?.data ?? '', 'base64')); console.log('shot _phonescreen.png'); process.exit(0); }
};
setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
