// Thin ws sink for the TLS-vs-proxy bench: receives frames, counts
// bytes, discards (a tiny echo back every Nth to model the reply path).
// Usage: bun echow.ts [port] [certPem keyPem]
const [portS, certPath, keyPath] = process.argv.slice(2);
const port = Number(portS) || 8401;
let rx = 0, msgs = 0, conns = 0;
const ECHO_EVERY = 20;
const srv = Bun.serve<{ n: number }>({
  port,
  hostname: '0.0.0.0',
  tls: certPath && keyPath ? { cert: Bun.file(certPath), key: Bun.file(keyPath) } : undefined,
  websocket: {
    data: {} as { n: number },
    maxPayloadLength: 1 << 20,
    open(ws) { conns += 1; ws.data.n = 0; },
    message(ws, m) {
      msgs += 1; rx += typeof m === 'string' ? m.length : (m as ArrayBuffer).byteLength;
      if (((ws.data.n += 1) % ECHO_EVERY) === 0) { ws.sendBinary(m as ArrayBuffer); }
    },
    close() { conns -= 1; },
    drain() { /* sink keeps draining */ },
  },
  fetch(req, s) {
    if (s.upgrade(req, { data: { n: 0 } })) { return; }
    if (new URL(req.url).pathname === '/benchstats') {
      return Response.json({ msgs, rx, conns });
    }
    return new Response('e');
  },
});
console.log(`echow on :${srv.port} tls=${!!certPath}`);
setInterval(() => {
  const u = process.cpuUsage();
  console.log(`STATS conns=${conns} msgs=${msgs} rxMB=${(rx / 1e6).toFixed(1)} cpuMs=${((u.user + u.system) / 1000).toFixed(0)}`);
  msgs = 0; rx = 0;
}, 5000);
