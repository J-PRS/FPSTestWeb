// ws→UDP loopback shim — the same relay the Electrobun shell runs in its
// main process, standalone for browser testing:
//   bun _tools/udpShim.ts           # ws://127.0.0.1:8787 → udp 127.0.0.1:9898
//   SHIM_UDP_HOST=92.5.61.55 bun _tools/udpShim.ts
// Client UdpLane opens ws://127.0.0.1:8787/udp — every ws binary message
// becomes one datagram to the server; every datagram back becomes one ws
// message to the page.
const HOST = process.env.SHIM_UDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SHIM_UDP_PORT ?? 9898);
// Optional WAN impairment: SHIM_LOSS=0.05 drops 5% of datagrams in each
// direction; SHIM_JITTER_MS=150 holds each datagram for rand(0..150)ms —
// the hold-vs-later-arrival reorder is what exercises out-of-order lanes.
const LOSS = Number(process.env.SHIM_LOSS ?? 0);
const JITTER = Number(process.env.SHIM_JITTER_MS ?? 0);
const deliver = (fn: () => void): void => {
  if (LOSS > 0 && Math.random() < LOSS) { return; }
  if (JITTER > 0) { setTimeout(fn, Math.random() * JITTER); }
  else { fn(); }
};
const udp = await Bun.udpSocket({
  socket: {
    data(_s, buf) { deliver(() => ws?.send(buf)); },
  },
});
let ws: { send(d: string | Uint8Array): void } | null = null;
const WSPORT = Number(process.env.SHIM_WS_PORT ?? 8787);
Bun.serve({
  port: WSPORT,
  fetch(req, server) {
    if (server.upgrade(req)) { return undefined; }
    return new Response('udp shim');
  },
  websocket: {
    open(c) { ws = c; },
    message(_c, data) {
      if (typeof data !== 'string') { deliver(() => udp.send(data as Uint8Array, PORT, HOST)); }
    },
    close() { ws = null; },
  },
});
console.log(`udp shim ws://127.0.0.1:8787 → ${HOST}:${PORT}${LOSS || JITTER ? ` (loss=${LOSS} jitter<=${JITTER}ms)` : ''}`);
