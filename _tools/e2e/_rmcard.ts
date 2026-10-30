// Remove the DESKTOP REQUIRED card + reveal HUD on the live phone page.
const r = await fetch('http://localhost:9333/json');
const t = await r.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
const g = t.find(x => x.type === 'page' && x.url.includes('5400'));
if (!g) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(g.webSocketDebuggerUrl);
await new Promise(x => { ws.onopen = x; });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  expression: `(() => { const els = [...document.querySelectorAll('*')].filter(e => getComputedStyle(e).position === 'fixed' && +getComputedStyle(e).zIndex >= 100).map(e => ({ tag: e.tagName, z: getComputedStyle(e).zIndex, text: (e.textContent || '').slice(0, 60) })); return JSON.stringify(els); })()`,
  returnByValue: true,
}}));
ws.onmessage = (m): void => { console.log(m.data); process.exit(0); };
