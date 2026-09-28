/**
 * Netcode v2 tier connect — tries transports best-first and hands back a
 * GameTransport. Order (see _docs/2026-09-26_netcode-v2.md):
 *
 *   WebTransport (QUIC datagrams) → WebRTC datachannel → WebSocket
 *
 * Today only the WebSocket tier is wired — the others stub to null until
 * their server halves exist (webtransport-bun / node-datachannel). The seam
 * is what matters: adding a tier means implementing `try*` and returning
 * early — callers and game code never change.
 */

import type { ConnectionConfig } from './WebSocketConnection.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import type { GameTransport } from './transport.js';
import { ChildLogger } from '../core/Logger.js';
import { urlParams } from '../core/params.js';

const logger = new ChildLogger('NetTiers');

/** Opt-in knobs while the UDP tiers are stubbed: ?net=wt / ?net=rtc probe
 *  that tier before falling back; absent the param we go straight to WS. */
export async function connectGameTransport(config: ConnectionConfig): Promise<GameTransport> {
  const want = urlParams.net;
  if (want === 'wt') {
    const t = await tryWebTransport(config);
    if (t) return t;
    logger.warn('WebTransport unavailable — falling through');
  }
  if (want === 'wt' || want === 'rtc') {
    const t = await tryWebRTC(config);
    if (t) return t;
    logger.warn('WebRTC unavailable — falling through to WebSocket');
  }
  return new WebSocketConnection(config);
}

/**
 * WebTransport tier — QUIC session, two lanes mapped to the seam:
 * datagrams carry unreliable binary (position frames), a single
 * bidirectional stream carries reliable JSON text. The server's HTTP/3
 * endpoint doesn't exist yet — the handshake just fails and we fall through.
 */
class WebTransportGameTransport implements GameTransport {
  private wt: WebTransport | null = null;
  private open = false;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private url: string, private config: ConnectionConfig) {}

  connect(): void {
    const https = this.url.replace(/^wss?:/, 'https:');
    const wt = new WebTransport(https);
    this.wt = wt;
    wt.ready.then(async () => {
      this.open = true;
      // Reliable JSON lane: one bidi stream, newline-delimited frames.
      const stream = await wt.createBidirectionalStream();
      this.writer = stream.writable.getWriter();
      this.dgWriter = wt.datagrams.writable.getWriter();
      void this.pumpReliable(stream.readable.getReader());
      void this.pumpDatagrams(wt.datagrams.readable.getReader());
      this.config.onConnect?.();
    }).catch((e) => {
      this.config.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.config.onDisconnect?.(1006, 'webtransport failed');
    });
    wt.closed.then(() => {
      if (this.open) { this.open = false; this.config.onDisconnect?.(1006, 'webtransport closed'); }
    });
  }

  private async pumpReliable(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    // JSON frames arrive newline-delimited over the reliable stream.
    let carry = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      carry += this.decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) try { this.config.onMessage?.(JSON.parse(line)); } catch { /* malformed */ }
      }
    }
  }

  private async pumpDatagrams(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      this.config.onBinaryMessage?.(value);
    }
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    const payload = typeof data === 'string' ? data : this.decoder.decode(data);
    void this.writer?.write(this.encoder.encode(payload + '\n'));
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
  // WebTransport speaks https:, not wss: — the endpoint shares the host.
  const https = config.url.replace(/^wss?:/, 'https:');
  try {
    const probe = new WebTransport(https);
    await Promise.race([probe.ready, new Promise((_, rej) => setTimeout(rej, 3000))]);
    void probe.close();
    return new WebTransportGameTransport(config.url, config);
  } catch {
    return null;
  }
}

/**
 * WebRTC tier — client side. Opens a signaling WebSocket to the server's
 * rtc endpoint, exchanges SDP/ICE, then upgrades the game traffic to an
 * unordered+unreliable DataChannel (UDP semantics). Without a server-side
 * peer (node-datachannel) the offer never answers and we fall through.
 */
class ServerRtcTransport implements GameTransport {
  private open = false;
  constructor(private dc: RTCDataChannel, private config: ConnectionConfig) {
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      const data = ev.data;
      if (typeof data === 'string') {
        try { config.onMessage?.(JSON.parse(data)); } catch { /* malformed */ }
      } else if (data instanceof ArrayBuffer) {
        config.onBinaryMessage?.(new Uint8Array(data));
      }
    };
    dc.onopen = () => { this.open = true; config.onConnect?.(); };
    dc.onclose = () => { this.open = false; config.onDisconnect?.(1000, 'rtc closed'); };
  }
  connect(): void {
    if (this.dc.readyState === 'open') {
      this.open = true;
      queueMicrotask(() => this.config.onConnect?.());
    }
  }
  send(data: string | Uint8Array): boolean {
    if (!this.open || this.dc.readyState !== 'open') return false;
    if (typeof data === 'string') this.dc.send(data);
    else this.dc.send(new Uint8Array(data));
    return true;
  }
  // The game datachannel is created unordered+unreliable — every send rides
  // the UDP lane. JSON events lose ordering here; that's acceptable for this
  // tier (position state is the high-rate traffic; events tolerate it).
  connected(): boolean { return this.open && this.dc.readyState === 'open'; }
  disconnect(): void { this.open = false; try { this.dc.close(); } catch { /* gone */ } }
}

async function tryWebRTC(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof RTCPeerConnection === 'undefined') return null;
  try {
    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
    // Signal over the plain WS path — the relay echoes envelopes verbatim.
    const signal = new WebSocket(config.url.replace(/\/ws$/, '/rtc'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await new Promise<RTCSessionDescriptionInit>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('rtc signal timeout')), 3000);
      signal.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'answer') { clearTimeout(timer); res(m); }
        } catch { /* not ours */ }
      };
      signal.onerror = () => rej(new Error('rtc signal error'));
      signal.onopen = () => signal.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
    });
    await pc.setRemoteDescription(answer);
    signal.close();
    return new ServerRtcTransport(dc, config);
  } catch {
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

  constructor(private readonly config: ConnectionConfig) {}

  connect(url?: string): void {
    void connectGameTransport(this.config).then((t) => {
      this.inner = t;
      t.connect(url);
      for (const d of this.pending) t.send(d);
      this.pending.length = 0;
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
  disconnect(): void { this.inner?.disconnect(); }
}
