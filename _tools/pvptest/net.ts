/**
 * Headless transport adapters — give _tools bots the same three netcode-v2
 * tiers the browser negotiates (wt → rtc → ws), behind one socket shape.
 * Lets the fleet load-test each tier and verify the scoreboard NET column.
 *
 *   WS : plain WebSocket to /ws.
 *   RTC: node-datachannel PeerConnection; SDP offer/answer rides a
 *        signaling WS at /rtcs (server answers; non-trickle ICE).
 *        Channels: 'ctrl' (reliable JSON) + 'game' (unreliable binary).
 *   WT : @webtransport-bun/webtransport connect() to the /wthash-advertised
 *        QUIC port; bidi stream = newline-delimited JSON, datagrams = binary.
 *
 * The returned object mimics the slice of WebSocket the bots use:
 * readyState (1 = open), send(), close(), onopen/onmessage/onerror/onclose.
 */

import { createRequire } from 'module';

export type Tier = 'ws' | 'rtc' | 'wt';

// Native deps live in server_bun/package.json — this tree has no root
// node_modules, so resolve them from there rather than requiring a
// duplicate install.
const serverRequire = createRequire(require('path').resolve(import.meta.dir, '../../server_bun/package.json'));

export interface BotSocket {
  readyState: number; // WebSocket enum: 1 = OPEN, 3 = CLOSED
  send(data: string | Uint8Array): void;
  /** UDP-style lane where the tier has one; falls back to send(). */
  sendUnreliable?(data: string | Uint8Array): void;
  close(): void;
  onopen?: () => void;
  onmessage?: (ev: { data: string | Uint8Array }) => void;
  onerror?: (e: unknown) => void;
  onclose?: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^wss?:/, wsUrl.startsWith('wss') ? 'https:' : 'http:').replace(/\/ws$/, '');
}

// ---------- WS ----------
function wsSocket(wsUrl: string): BotSocket {
  const w = new WebSocket(wsUrl);
  w.binaryType = 'arraybuffer';
  const sock: BotSocket = {
    get readyState() { return w.readyState; },
    send: (d) => w.send(d),
    close: () => w.close(),
  };
  w.onopen = () => sock.onopen?.();
  w.onerror = (e) => sock.onerror?.(e);
  w.onclose = () => sock.onclose?.();
  w.onmessage = (ev) => {
    sock.onmessage?.({ data: typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data) });
  };
  return sock;
}

// ---------- RTC ----------
async function rtcSocket(wsUrl: string): Promise<BotSocket> {
  // Server's own dep — same native module the RtcServer loads lazily.
  const nd = serverRequire('node-datachannel');
  const signalUrl = wsUrl.replace(/\/ws$/, '/rtcs');
  let iceServers: { hostname: string; port: number; relayer?: boolean }[] = [];
  try {
    const cfg = await (await fetch(`${httpBase(wsUrl)}/rtcconfig`)).json();
    if (Array.isArray(cfg?.iceServers)) iceServers = cfg.iceServers;
  } catch { /* no config — host candidates only, fine on LAN */ }

  const pc = new nd.PeerConnection('bot', { iceServers });
  // Channels MUST exist before setLocalDescription — on a media-less PC the
  // offer has no m-section and libdatachannel segfaults (verified).
  const game = pc.createDataChannel('game', { unordered: true, maxRetransmits: 0 });
  const ctrl = pc.createDataChannel('ctrl'); // reliable+ordered — join, claims

  // Mirror the browser path: wait for ICE gathering to finish so the offer
  // carries all candidates, then answer over the signaling socket.
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => res(), 2000); // don't hang if gathering stalls
    pc.onGatheringStateChange((s: string) => { if (s === 'complete') { clearTimeout(t); res(); } });
    // NB: no-arg — explicit 'offer'/'answer' segfaults libdatachannel on
    // Windows (same trap RtcServer hits with 'answer').
    pc.setLocalDescription();
  });

  const answer = await new Promise<{ sdp: string }>((res, rej) => {
    const sig = new WebSocket(signalUrl);
    const t = setTimeout(() => rej(new Error('rtc signal timeout')), 5000);
    sig.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'answer' && typeof m.sdp === 'string') { clearTimeout(t); sig.close(); res(m); }
    };
    sig.onerror = () => { clearTimeout(t); rej(new Error('rtc signal error')); };
    sig.onopen = () => sig.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription()?.sdp }));
  });
  pc.setRemoteDescription(answer.sdp, 'answer');

  const sock: BotSocket = {
    readyState: 0,
    send: (d) => {
      const dc = ctrl.isOpen() ? ctrl : game;
      if (typeof d === 'string') dc.sendMessage(d);
      else dc.sendMessageBinary(Buffer.from(d));
    },
    sendUnreliable: (d) => {
      const dc = game.isOpen() ? game : ctrl;
      if (typeof d === 'string') dc.sendMessage(d);
      else dc.sendMessageBinary(Buffer.from(d));
    },
    close: () => { try { pc.close(); } catch { /* gone */ } },
  };

  const onMsg = (msg: string | Buffer | ArrayBuffer) => {
    if (typeof msg === 'string') sock.onmessage?.({ data: msg });
    else if (msg instanceof ArrayBuffer) sock.onmessage?.({ data: new Uint8Array(msg) });
    else sock.onmessage?.({ data: new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength) });
  };
  game.onMessage(onMsg);
  ctrl.onMessage(onMsg);

  await new Promise<void>((res, rej) => {
    // ICE completion → DTLS/SCTP handshake → channel open takes a few
    // seconds even on loopback; keep this comfortably over that.
    const t = setTimeout(() => rej(new Error('rtc channel timeout')), 12000);
    const mark = () => { if (game.isOpen() || ctrl.isOpen()) { clearTimeout(t); sock.readyState = 1; res(); } };
    game.onOpen(mark);
    ctrl.onOpen(mark);
    game.onError((e: string) => { clearTimeout(t); rej(new Error(e)); });
    ctrl.onError((e: string) => { clearTimeout(t); rej(new Error(e)); });
  });
  game.onClosed(() => { sock.readyState = 3; sock.onclose?.(); });
  return sock;
}

// ---------- WT ----------
async function wtSocket(wsUrl: string): Promise<BotSocket> {
  // ESM-only package — its exports map rejects require()/resolve(), so
  // point the dynamic import straight at server_bun's installed file.
  const wtb = await import(new URL('../../server_bun/node_modules/@webtransport-bun/webtransport/dist/index.js', import.meta.url).href);
  const info = await (await fetch(`${httpBase(wsUrl)}/wthash`)).json();
  if (!info?.enabled || !info.port || !info.sha256) throw new Error('wt not enabled on server');
  // 'localhost' can resolve to ::1 while the QUIC listener sits on IPv4 —
  // normalize to the literal loopback (dev boxen are always IPv4 here).
  const host = new URL(httpBase(wsUrl)).hostname === 'localhost' ? '127.0.0.1' : new URL(httpBase(wsUrl)).hostname;
  // FIXME(upstream): napi client path panics in rustls CryptoProvider
  // init on win32 without insecureSkipVerify — hash pinning is still
  // passed, and the native side may honor it even with verify off.
  const session = await wtb.connect(`https://${host}:${info.port}`, {
    tls: { insecureSkipVerify: true },
    serverCertificateHashes: [{ algorithm: 'sha-256', valueBase64: info.sha256 }],
  });
  await session.ready;

  // Node client returns a Duplex (not web streams) for bidi streams.
  const stream: any = await session.createBidirectionalStream();

  const sock: BotSocket = {
    readyState: 1,
    send: (d) => stream.write(encoder.encode((typeof d === 'string' ? d : decoder.decode(d)) + '\n')),
    sendUnreliable: (d) => void session.sendDatagram(typeof d === 'string' ? encoder.encode(d) : d).catch(() => {}),
    close: () => session.close(),
  };
  // Reliable lane: newline-delimited JSON, same framing as the browser tier.
  let carry = '';
  stream.on('data', (chunk: Uint8Array) => {
    carry += decoder.decode(chunk, { stream: true });
    if (carry.length > 65536) { sock.close(); return; }
    let nl: number;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      if (line) sock.onmessage?.({ data: line });
    }
  });
  void (async () => {
    for await (const dg of session.incomingDatagrams()) sock.onmessage?.({ data: dg });
  })();
  session.closed.then(() => { sock.readyState = 3; sock.onclose?.(); });
  return sock;
}

/** Open a socket on the requested tier — resolves only once the session is
 *  live. Throws on failure: no silent fallback, the point is exercising
 *  THAT tier. */
export async function openSocket(wsUrl: string, tier: Tier): Promise<BotSocket> {
  if (tier === 'rtc') return rtcSocket(wsUrl);
  if (tier === 'wt') return wtSocket(wsUrl);
  return new Promise((res, rej) => {
    const s = wsSocket(wsUrl);
    s.onopen = () => res(s);
    s.onerror = (e) => rej(e);
  });
}
