/**
 * Netcode v2 tier connect — tries transports best-first and hands back a
 * GameTransport. Order (see _docs/2026-09-26_netcode-v2.md):
 *
 *   WebTransport (QUIC datagrams) → WebRTC datachannel → WebSocket
 *
 * All three tiers are live. Probes run in parallel so the wait is the
 * slowest single probe (~3s cap), not the sum; WS needs no probe at all.
 * ?net=wt|rtc|ws pins one tier for testing; absent the param the best
 * available wins automatically.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import type { ServerMessage } from '../../../shared/protocol.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetTiers');

/** Best-tier selection: ?net=wt|rtc|ws pins a single tier; otherwise WT and
 *  RTC probe in parallel and the better of whatever succeeded wins. WS is
 *  always the floor. */
export async function connectGameTransport(config: ConnectionConfig): Promise<GameTransport> {
  const want = urlParams.net;
  if (want === 'ws') return new WebSocketConnection(config);
  if (want === 'wt') return (await tryWebTransport(config)) ?? new WebSocketConnection(config);
  if (want === 'rtc') return (await tryWebRTC(config)) ?? new WebSocketConnection(config);

  const now = Date.now();
  const probeWt = now >= missUntil.wt;
  const probeRtc = now >= missUntil.rtc;
  const [wt, rtc] = await Promise.all([
    probeWt ? tryWebTransport(config).catch(() => null) : null,
    probeRtc ? tryWebRTC(config).catch(() => null) : null,
  ]);
  // Only an actual probe refreshes the miss window — a skipped probe must
  // not extend the cache or the tier never gets retried.
  if (probeWt && !wt) missUntil.wt = Date.now() + MISS_CACHE_MS;
  if (probeRtc && !rtc) missUntil.rtc = Date.now() + MISS_CACHE_MS;
  if (wt) { void rtc?.disconnect(); logger.info('tier: WebTransport'); return wt; }
  if (rtc) { logger.info('tier: WebRTC'); return rtc; }
  logger.info('tier: WebSocket');
  return new WebSocketConnection(config);
}

/**
 * WebTransport tier — QUIC session, two lanes mapped to the seam:
 * datagrams carry unreliable binary (position frames), a single
 * bidirectional stream carries reliable JSON text. The server's HTTP/3
 * endpoint doesn't exist yet — the handshake just fails and we fall through.
 */
class WebTransportGameTransport implements GameTransport {
  readonly tier = 'wt' as const;
  private open = false;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private preOpen: string[] = [];
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private config: ConnectionConfig, private wt: WebTransport) {}

  connect(): void {
    const wt = this.wt;
    wt.ready.then(async () => {
      this.open = true;
      // Reliable JSON lane: one bidi stream, newline-delimited frames.
      const stream = await wt.createBidirectionalStream();
      this.writer = stream.writable.getWriter();
      this.dgWriter = wt.datagrams.writable.getWriter();
      void this.pumpReliable(stream.readable.getReader());
      void this.pumpDatagrams(wt.datagrams.readable.getReader());
      for (const d of this.preOpen) void this.writer.write(this.encoder.encode(d + '\n')).catch(() => {});
      this.preOpen.length = 0;
      this.config.onConnect?.();
    }).catch((e) => {
      this.config.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.config.onDisconnect?.(1006, 'webtransport failed');
    });
    // wt.closed REJECTS on abnormal close — an unhandled rejection for
    // every failed probe (the log-spam bug). Rejection = closed.
    wt.closed.then(
      () => { if (this.open) { this.open = false; this.config.onDisconnect?.(1006, 'webtransport closed'); } },
      () => { if (this.open) { this.open = false; this.config.onDisconnect?.(1006, 'webtransport closed'); } },
    );
  }

  private async pumpReliable(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    // JSON frames arrive newline-delimited over the reliable stream.
    let carry = '';
    try {
      for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      carry += this.decoder.decode(value, { stream: true });
      // Server sending a never-terminated line would grow this forever.
      if (carry.length > 65536) { this.disconnect(); return; }
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) this.dispatchLine(line);
      }
      }
    } catch { /* stream reset on close — expected teardown */ }
  }

  // One complete JSON frame from the reliable stream. The server wraps
  // reliable-binary frames in a JSON envelope — the stream is text-framed
  // so raw bytes would corrupt it (how ball segments arrive on wt).
  private dispatchLine(line: string): void {
    let m: ServerMessage | { type: 'bin'; d: string };
    try { m = JSON.parse(line); } catch { return; /* malformed */ }
    if (m.type === 'bin' && typeof (m as { d?: string }).d === 'string') {
      this.config.onBinaryMessage?.(Uint8Array.from(atob((m as { d: string }).d), (c) => c.charCodeAt(0)));
    } else {
      this.config.onMessage?.(m as ServerMessage);
    }
  }

  private async pumpDatagrams(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        this.config.onBinaryMessage?.(value);
      }
    } catch { /* datagrams drop with the session — expected teardown */ }
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    // Binary must be enveloped too — decoding arbitrary bytes as UTF-8
    // mangled them before this ever worked.
    const payload = typeof data === 'string' ? data
      : `{"type":"bin","d":"${btoa(Array.from(data, (b) => String.fromCharCode(b)).join(''))}"}`;
    // onConnect fires only after the stream is live, but a same-tick send
    // can still race the writer assignment — hold those briefly.
    if (!this.writer) { this.preOpen.push(payload); return true; }
    // A write can outlive the session — teardown rejects it; that's a
    // normal close, not an error.
    void this.writer.write(this.encoder.encode(payload + '\n')).catch(() => {});
    return true;
  }

  sendUnreliable(data: string | Uint8Array): boolean {
    if (!this.open || !this.dgWriter) return this.send(data);
    const bytes = new Uint8Array(typeof data === 'string' ? this.encoder.encode(data) : data);
    this.dgWriter.write(bytes).catch(() => {}); // UDP semantics: drop on backpressure
    return true;
  }

  connected(): boolean { return this.open; }
  disconnect(): void { this.open = false; void this.wt?.close(); }
}

async function tryWebTransport(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof WebTransport === 'undefined') return null;
  // WT runs on its own QUIC port — ask /wthash (plain HTTP on the WS port)
  // for the port + the cert's DER SHA-256 so self-signed dev certs pin
  // without a CA install. Absent/disabled → no tier.
  try {
    const httpBase = config.url.replace(/^wss?:/, 'http' + (config.url.startsWith('wss') ? 's' : '') + ':').replace(/\/ws$/, '');
    const info = await (await fetch(`${httpBase}/wthash`)).json();
    if (!info?.enabled || !info.port || !info.sha256) return null;
    // Chrome resolves `localhost` to ::1 but the QUIC listener is IPv4 —
    // normalized here (the pvptest adapter does the same) or loopback WT
    // dies with ERR_CONNECTION_RESET before the handshake starts.
    const rawHost = new URL(httpBase).hostname;
    const host = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
    const hashBytes = Uint8Array.from(atob(info.sha256), (c) => c.charCodeAt(0));
    const wt = new WebTransport(`https://${host}:${info.port}`, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes }],
    });
    // Failed probes leave wt.closed rejected with no subscriber —
    // unhandledrejection noise. Swallow it here; the winning session's
    // close is handled by WebTransportGameTransport's own subscription.
    void wt.closed.catch(() => {});
    try {
      // The probe IS the session — don't handshake twice.
      await Promise.race([wt.ready, new Promise((_, rej) => setTimeout(rej, 3000))]);
    } catch {
      // A losing probe otherwise leaks a pending session (Chrome caps at
      // 64 — reconnects exhausted it before the miss cache existed).
      wt.close();
      return null;
    }
    return new WebTransportGameTransport(config, wt);
  } catch {
    return null;
  }
}

// Negative tier cache — a failed WT probe leaves the QUIC session pending
// in Chrome (cap: 64 per profile). Retrying every reconnect tick exhausts
// it ("Too many pending WebTransport sessions") and the transport starts
// failing for unrelated reasons. Cache the miss for 30s.
const missUntil = { wt: 0, rtc: 0 };
const MISS_CACHE_MS = 30_000;

/**
 * WebRTC tier — client side. Opens a signaling WebSocket to the server's
 * rtc endpoint, exchanges SDP/ICE, then upgrades the game traffic to an
 * unordered+unreliable DataChannel (UDP semantics). Without a server-side
 * peer (node-datachannel) the offer never answers and we fall through.
 */
class ServerRtcTransport implements GameTransport {
  readonly tier = 'rtc' as const;
  private open = false;
  // `pc` is kept so a losing probe can be fully torn down — closing only
  // the datachannel leaves the ICE/DTLS machinery running server-side.
  constructor(
    private dc: RTCDataChannel,
    private config: ConnectionConfig,
    private pc?: RTCPeerConnection,
    // Reliable control channel for JSON events — the 'game' channel is
    // unordered+unreliable so join/claims sent over it could be lost.
    private ctrl?: RTCDataChannel,
  ) {
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('message', (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) config.onBinaryMessage?.(new Uint8Array(data));
      else if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      }
    });
    dc.addEventListener('open', () => { this.open = true; config.onConnect?.(); });
    dc.addEventListener('close', () => { this.open = false; config.onDisconnect?.(1000, 'rtc closed'); });
    ctrl?.addEventListener('message', (ev) => {
      const data = ev.data;
      // Binary CAN arrive here — the server pushes ball segments down the
      // reliable lane, which is this channel on RTC. Dropping them was a
      // silent desync source.
      if (data instanceof ArrayBuffer) { config.onBinaryMessage?.(new Uint8Array(data)); return; }
      if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      }
    });
  }
  connect(): void {
    if (this.dc.readyState === 'open') {
      this.open = true;
      queueMicrotask(() => this.config.onConnect?.());
    }
  }
  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    if (this.ctrl?.readyState === 'open') {
      if (typeof data === 'string') this.ctrl.send(data);
      else this.ctrl.send(new Uint8Array(data));
      return true;
    }
    if (this.dc.readyState !== 'open') return false;
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }
  sendUnreliable(data: string | Uint8Array): boolean {
    if (this.dc.readyState !== 'open') return this.send(data);
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }
  connected(): boolean { return this.open && this.dc.readyState === 'open'; }
  disconnect(): void {
    this.open = false;
    try { this.dc.close(); } catch { /* gone */ }
    try { this.pc?.close(); } catch { /* gone */ }
  }
}

async function tryWebRTC(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof RTCPeerConnection === 'undefined') return null;
  let pc: RTCPeerConnection | undefined;
  try {
    // ICE servers come from the server itself (/rtcconfig) — STUN/TURN is a
    // deployment property, not a client constant; LAN/dev needs neither.
    const httpBase = config.url.replace(/^wss?:/, 'http' + (config.url.startsWith('wss') ? 's' : '') + ':').replace(/\/ws$/, '');
    const iceServers = await fetch(`${httpBase}/rtcconfig`)
      .then((r) => r.json())
      .then((j) => (Array.isArray(j?.iceServers) ? j.iceServers : []))
      .catch(() => []);
    pc = new RTCPeerConnection({ iceServers });
    const conn = pc;
    const dc = conn.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    const ctrl = conn.createDataChannel('ctrl'); // reliable+ordered — join, claims, events
    // Signal over the dedicated /rtcs socket — one offer in, one answer out.
    // The offer is sent only after ICE gathering completes so candidates
    // are embedded in the SDP (non-trickle — the server doesn't accept
    // trickle candidates; on LAN/host scenarios that's sufficient).
    const signal = new WebSocket(config.url.replace(/\/ws$/, '/rtcs'));
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (conn.iceGatheringState !== 'complete') {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 2500);
        conn.addEventListener('icegatheringstatechange', () => {
          if (conn.iceGatheringState === 'complete') { clearTimeout(t); res(); }
        });
      });
    }
    const sdp = conn.localDescription?.sdp ?? offer.sdp;
    const answer = await new Promise<RTCSessionDescriptionInit>((res, rej) => {
      // Server gathers its own ICE (STUN) before answering — that window
      // is seconds, so a LAN-era 3s timeout would always fall back to ws
      // for internet peers. 10s covers a slow srflx gather.
      const timer = setTimeout(() => rej(new Error('rtc signal timeout')), 10000);
      signal.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'answer') { clearTimeout(timer); res(m); }
        } catch { /* not ours */ }
      });
      signal.addEventListener('error', () => rej(new Error('rtc signal error')));
      // The signal ws can already be OPEN here — it connected while we
      // were awaiting createOffer+ICE gather, so 'open' never refires and
      // the probe would sit out its 3s timeout. Send immediately when so.
      if (signal.readyState === WebSocket.OPEN) {
        signal.send(JSON.stringify({ type: 'offer', sdp }));
      } else {
        signal.addEventListener('open', () => signal.send(JSON.stringify({ type: 'offer', sdp })));
      }
    });
    await conn.setRemoteDescription(answer);
    signal.close();
    return new ServerRtcTransport(dc, config, conn, ctrl);
  } catch {
    // Failed probe — the ICE/DTLS machinery keeps running without this.
    try { pc?.close(); } catch { /* gone */ }
    return null;
  }
}

/**
 * GameTransport that runs the tier probe on connect() and delegates to the
 * winner. NetworkManager's factory hook is synchronous, so the probe is
 * lazy: sends made before resolution queue briefly (the winner flushes
 * them right after its own connect — same guarantee WebSocketConnection
 * already gives for pre-open sends).
 */
export class TieredTransport implements GameTransport {
  private inner: GameTransport | null = null;
  private pending: (string | Uint8Array)[] = [];
  private url: string | undefined;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BACKOFF_MS = 1000;

  constructor(private readonly config: ConnectionConfig) {}

  get tier() { return this.inner?.tier; }

  connect(url?: string): void {
    this.url = url;
    // Re-probe on each (re)connect: the previous best tier may be gone.
    // Inner transports see wrapped callbacks — a drop re-arms the probe
    // here, mirroring WebSocketConnection's own reconnect loop so a WT/RTC
    // session survives a blip instead of dying on first packet loss.
    const innerConfig: ConnectionConfig = {
      ...this.config,
      onDisconnect: (code, reason) => {
        this.config.onDisconnect?.(code, reason);
        if (this.closed) return;
        // WebSocketConnection runs its own reconnect loop — reprobing here
        // would double-schedule connections.
        if (this.inner instanceof WebSocketConnection) return;
        if (this.attempts < (this.config.maxReconnectAttempts ?? Infinity)) {
          this.attempts++;
          this.reconnectTimer = setTimeout(() => {
            if (!this.closed) this.connect(this.url);
          }, TieredTransport.BACKOFF_MS);
        }
      },
      onConnect: () => {
        this.attempts = 0;
        this.config.onConnect?.();
      },
    };
    void connectGameTransport(innerConfig).then((t) => {
      if (this.closed) { t.disconnect(); return; }
      this.inner = t;
      t.connect(url);
      for (const d of this.pending) t.send(d);
      this.pending.length = 0;
    }).catch((e) => {
      this.config.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
  }

  send(data: string | Uint8Array): boolean {
    if (this.inner) return this.inner.send(data);
    this.pending.push(data);
    return false;
  }

  sendUnreliable(data: string | Uint8Array): boolean {
    return this.inner?.sendUnreliable?.(data) ?? this.send(data);
  }

  connected(): boolean { return this.inner?.connected() ?? false; }
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.inner?.disconnect();
  }
}
