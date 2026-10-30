const r = await fetch('http://localhost:9333/json');
const t = await r.json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
const g = t.find(x => x.type === 'page' && x.url.includes('5400'));
if (!g) { console.log('no page'); process.exit(1); }
const ws = new WebSocket(g.webSocketDebuggerUrl);
await new Promise(x => { ws.onopen = x; });
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  expression: `(() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return JSON.stringify({ renderer: gl.getParameter(e.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(e.UNMASKED_VENDOR_WEBGL), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE) }); })()`,
  returnByValue: true,
}}));
ws.onmessage = (m): void => { console.log(m.data); process.exit(0); };
