import type { ConnectionConfig } from './WebSocketConnection.js';
import type { ServerMessage } from '../../../shared/protocol.js';
import type { GameTransport } from './transport.js';

/**
 * WebTransport tier — QUIC session, two lanes mapped to the seam:
 * datagrams carry unreliable binary (position frames), a single
 * bidirectional stream carries reliable JSON text. The server's HTTP/3
 * endpoint doesn't exist yet — the handshake just fails and we fall through.
 */
export class WebTransportGameTransport implements GameTransport {
  readonly tier = 'wt' as const;
  private open = false;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
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
      () => this.declareDead('webtransport closed'),
      () => this.declareDead('webtransport closed'),
    );
  }

  /** The one place a dead lane becomes a disconnect event — EVERY death
   *  detector (wt.closed, either pump ending, a pathological carry, a
   *  reset stream) must land here. The old pump path called disconnect()
   *  directly, which sets open=false WITHOUT onDisconnect — so
   *  TieredTransport never learned the lane died, never reprobed, and
   *  the session just black-holed sends forever. */
  private declareDead(reason: string): void {
    if (!this.open) return; // first detector wins; deliberate disconnect() leaves open=false
    this.open = false;
    this.config.onDisconnect?.(1006, reason);
  }

  private async pumpReliable(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    // JSON frames arrive newline-delimited over the reliable stream.
    let carry = '';
    try {
      for (;;) {
      const { done, value } = await reader.read();
      // Reliable lane ended while the session was expected live — same
      // verdict as wt.closed: dead, reconnect.
      if (done) { this.declareDead('wt reliable stream ended'); return; }
      carry += this.decoder.decode(value, { stream: true });
      // Bound a pathological never-terminated line — but 64K was too
      // tight: a full map gameState (or a 'bin'-wrapped segment burst)
      // legitimately exceeds it. 4MB keeps the guard without killing
      // real frames.
      if (carry.length > 4 * 1024 * 1024) { this.declareDead('wt line overflow'); void this.wt.close(); return; }
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) this.dispatchLine(line);
      }
      }
    } catch { this.declareDead('wt reliable stream reset'); }
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
        if (done) { this.declareDead('wt datagrams ended'); return; }
        this.config.onBinaryMessage?.(value);
      }
    } catch { this.declareDead('wt datagrams reset'); }
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

  connected(): boolean { return this.open; }
  /** Deliberate teardown ONLY — losing probe / NetworkManager shutdown.
   *  Internal failures must use declareDead() so the tier manager learns
   *  the lane died and reprobes. */
  disconnect(): void { this.open = false; void this.wt?.close(); }
}

export async function tryWebTransport(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof WebTransport === 'undefined') return null;
  // WT runs on its own QUIC port — ask /wthash (plain HTTP on the WS port)
  // for the port + the cert's DER SHA-256 so self-signed dev certs pin
  // without a CA install. Absent/disabled → no tier.
  try {
    const httpBase = config.url.replace(/^wss?:/, 'http' + (config.url.startsWith('wss') ? 's' : '') + ':').replace(/\/ws$/, '');
    // Bounded — a flapping tunnel left this fetch hanging forever, which
    // stalled the whole re-probe and the session never recovered.
    const info = await (await fetch(`${httpBase}/wthash`, { signal: AbortSignal.timeout(4000) })).json();
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

