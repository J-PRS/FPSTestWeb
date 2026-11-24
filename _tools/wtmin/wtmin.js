// Minimal WT repro — same code for worker and main-thread control.
// Query: ?w=0 no writes after join | ?mt=1 run on main thread (control).
self.runWtMin = async function runWtMin(log) {
  const q = new URLSearchParams(self.location.search);
  const WRITE = q.get('w') !== '0';
  try {
    const info = await (await fetch('http://localhost:8000/wthash')).json();
    const hash = Uint8Array.from(atob(info.sha256), (c) => c.charCodeAt(0));
    const wt = new WebTransport(`https://127.0.0.1:${info.port}`, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
    });
    wt.closed.then(() => log('CLOSED ok'), (e) => log(`CLOSED err ${e.name} ${e.message}`));
    await wt.ready;
    log('READY');
    const stream = await wt.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    (async () => {
      try {
        for (;;) { const { done } = await reader.read(); if (done) { log('RELIABLE done'); return; } }
      } catch (e) { log(`RELIABLE reset ${e.name} ${e.message}`); }
    })();
    (async () => {
      try { for await (const dg of wt.datagrams.readable) { void dg; } log('DG done'); }
      catch (e) { log(`DG reset ${e.name} ${e.message}`); }
    })();
    const enc = new TextEncoder();
    const write = (s) => writer.write(enc.encode(s + '\n'))
      .then(() => log('wrote', s.slice(0, 30)))
      .catch((e) => log(`WRITE fail ${e.name} ${e.message}`));
    await write(JSON.stringify({ type: 'join', playerId: `wtmin-${Date.now() % 1e6}`, room: 'wtminroom' }));
    log(`WRITE=${WRITE}`);
    const dg = q.get('dg') === '1';
    let dgWriter = null;
    if (dg) { try { dgWriter = wt.datagrams.writable.getWriter(); } catch (e) { log(`dgWriter fail ${e.message}`); } }
    const RATE = parseInt(q.get('rate') ?? '2500', 10);
    let n = 0;
    if (dgWriter) setInterval(() => {
      const frame = new Uint8Array(64);
      frame[0] = 0x54; frame[1] = 0x02;
      dgWriter.write(frame).then(() => { if ((++n % 20) === 0) log('dg wrote'); })
        .catch((e) => log(`DG WRITE fail ${e.name} ${e.message}`));
    }, RATE);
    setInterval(() => {
      if (!WRITE) { log('idle tick'); return; }
      write(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }, 2500);
  } catch (e) { log(`FATAL ${e.name} ${e.message}`); }
};
