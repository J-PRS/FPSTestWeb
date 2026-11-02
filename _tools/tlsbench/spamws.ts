// ws spam client (Bun native WebSocket): N conns, rate msgs/s each,
// payload bytes, T seconds. NODE_TLS_REJECT_UNAUTHORIZED=0 for bench certs.
// Usage: bun spamws.ts <url> [conns] [msgsPerSec] [bytes] [secs]
declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(c: number): void };

const [url, connsS, rateS, bytesS, secsS] = process.argv.slice(2);
const CONNS = Number(connsS) || 100;
const RATE = Number(rateS) || 20;
const BYTES = Number(bytesS) || 450;
const SECS = Number(secsS) || 30;
const payload = new Uint8Array(BYTES).fill(0x61);

let open = 0, sent = 0, recv = 0, errs = 0;
const sockets: WebSocket[] = [];
console.log(`connecting ${CONNS} -> ${url}`);
for (let i = 0; i < CONNS; i += 1) {
  try {
    const ws = new WebSocket(url);
    ws.onopen = () => { open += 1; };
    ws.onmessage = () => { recv += 1; };
    ws.onerror = () => { errs += 1; };
    ws.onclose = () => { open -= 1; };
    sockets.push(ws);
  } catch { errs += 1; }
  if ((i + 1) % 100 === 0) { await new Promise(r => setTimeout(r, 500)); }
}
await new Promise(r => setTimeout(r, 10000));
console.log(`open=${open}/${CONNS} errs=${errs}`);

const t0 = Date.now();
const tick = setInterval(() => {
  for (const ws of sockets) { if (ws.readyState === WebSocket.OPEN) { ws.send(payload); sent += 1; } }
}, 1000 / RATE);

let last = 0;
const rep = setInterval(() => {
  const d = sent - last; last = sent;
  console.log(`T+${((Date.now() - t0) / 1000).toFixed(0)}s sent=${sent} (+${d}/s) recv=${recv} open=${open} errs=${errs}`);
}, 5000);
await new Promise(r => setTimeout(r, SECS * 1000));
clearInterval(tick); clearInterval(rep);
console.log(`DONE open=${open} sent=${sent} recv=${recv} errs=${errs} secs=${SECS}`);
for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
await new Promise(r => setTimeout(r, 1500));
process.exit(0);
