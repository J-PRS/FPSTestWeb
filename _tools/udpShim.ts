// ws→UDP loopback shim — the same relay the Electrobun shell runs in its
// main process, standalone for browser testing:
//   bun _tools/udpShim.ts           # ws://127.0.0.1:8787 → udp 127.0.0.1:9898
//   SHIM_UDP_HOST=92.5.61.55 bun _tools/udpShim.ts
// Client UdpLane opens ws://127.0.0.1:8787/udp — every ws binary message
// becomes one datagram to the server; every datagram back becomes one ws
// message to the page.
const HOST = process.env.SHIM_UDP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SHIM_UDP_PORT ?? 9898);
const udp = await Bun.udpSocket({
  socket: {
    data(_s, buf) { ws?.send(buf); },
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
      if (typeof data !== 'string') { udp.send(data, PORT, HOST); }
    },
    close() { ws = null; },
  },
});
console.log(`udp shim ws://127.0.0.1:8787 → ${HOST}:${PORT}`);
