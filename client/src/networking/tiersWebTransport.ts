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

  connected(): boolean { return this.open; }
  disconnect(): void { this.open = false; void this.wt?.close(); }
}

export async function tryWebTransport(config: ConnectionConfig): Promise<GameTransport | null> {
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

