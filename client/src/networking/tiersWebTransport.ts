import type { ConnectionConfig } from './WebSocketConnection.js';
import type { ServerMessage } from '../../../shared/protocol.js';
import type { GameTransport } from './transport.js';
import { netLogger } from './netLog.js';

const logger = netLogger('NetWt');

// QUIC datagrams don't fragment — anything past the path MTU (~1200B) is
// dropped ENTIRELY, so "unreliable" there means "never arrives". Small
// binary frames (position reports) are safe to send unreliably; anything
// bigger must ride the reliable stream. Matches the server's cap.
const WT_MAX_DATAGRAM = 1200;

/**
 * WebTransport tier — QUIC session, two lanes mapped to the seam:
 * datagrams carry unreliable binary (position frames), a single
 * bidirectional stream carries reliable JSON text.
 */
export class WebTransportGameTransport implements GameTransport {
  readonly tier = 'wt' as const;
  private open = false;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dgWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  // Retained for the session's life: a GC'd stream/reader wrapper can be
  // finalized into a stream close server-side (worker GC timing made this
  // sporadic — the reliable pump then reads a reset that looks like a
  // peer kill). Only reader/writer halves being referenced is NOT enough.
  private stream: WebTransportBidirectionalStream | null = null;
  // Stream-2 (caps.binLane): u16-framed raw binary, HoL-isolated from the
  // JSON lane — opened only when the server advertises it on gameState.
  private binStream: WebTransportBidirectionalStream | null = null;
  private rr: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private dr: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private preOpen: string[] = [];
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private config: ConnectionConfig, private wt: WebTransport) {}

  connect(): void {
    const {wt} = this;
    wt.ready.then(async (): Promise<void> => {
      this.open = true;
      // Reliable JSON lane: one bidi stream, newline-delimited frames.
      const stream = await wt.createBidirectionalStream();
      this.stream = stream;
      this.writer = stream.writable.getWriter();
      // Datagram uplink is an optimization — a session whose writable is
      // unavailable still works fully reliable.
      try { this.dgWriter = wt.datagrams.writable?.getWriter() ?? null; } catch { this.dgWriter = null; }
      this.rr = stream.readable.getReader();
      this.dr = wt.datagrams.readable.getReader();
      this.pumpReliable(this.rr);
      this.pumpDatagrams(this.dr);
      for (const d of this.preOpen) {this.writer.write(this.encoder.encode(`${d  }\n`)).catch((): void => { return; });}
      this.preOpen.length = 0;
      this.config.onConnect?.();
    }).catch((error): void => {
      logger.warn(`wt connect failed mid-setup: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`);
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.config.onDisconnect?.(1006, 'webtransport failed');
    });
    // wt.closed REJECTS on abnormal close — an unhandled rejection for
    // every failed probe (the log-spam bug). Rejection = closed.
    wt.closed.then(
      (): void => this.declareDead('webtransport closed'),
      (error): void => this.declareDead(`webtransport closed: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`),
    );
  }

  /** The one place a dead lane becomes a disconnect event — EVERY death
   *  detector (wt.closed, either pump ending, a pathological carry, a
   *  reset stream) must land here. The old pump path called disconnect()
   *  directly, which sets open=false WITHOUT onDisconnect — so
   *  TieredTransport never learned the lane died, never reprobed, and
   *  the session just black-holed sends forever. */
  private declareDead(reason: string): void {
    if (!this.open) {return;} // first detector wins; deliberate disconnect() leaves open=false
    logger.warn(`wt declareDead: ${reason}`);
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
      if (carry.length > 4 * 1024 * 1024) { this.declareDead('wt line overflow'); this.wt.close(); return; }
      let nl = 0;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) {this.dispatchLine(line);}
      }
      }
    } catch (error) { this.declareDead(`wt reliable stream reset: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`); }
  }

  // One complete JSON frame from the reliable stream. The server wraps
  // reliable-binary frames in a JSON envelope — the stream is text-framed
  // so raw bytes would corrupt it (how ball segments arrive on wt).
  private dispatchLine(line: string): void {
    // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
    let m: ServerMessage | { type: 'bin'; d: string };
    try { m = JSON.parse(line); } catch { return; /* malformed */ }
    if (m.type === 'gameState' && (m as { caps?: { binLane?: number } }).caps?.binLane && !this.binStream) {
      this.openBinLane();
    }
    if (m.type === 'bin' && typeof (m as { d?: string }).d === 'string') {
      this.config.onBinaryMessage?.(Uint8Array.from(atob((m as { d: string }).d), (c): number => c.charCodeAt(0)));
    } else {
      this.config.onMessage?.(m as ServerMessage);
    }
  }

  private async openBinLane(): Promise<void> {
    try {
      const stream = await this.wt.createBidirectionalStream();
      // A second stream could have been opened by a later gameState
      // (resync replays the caps) — keep the first, drop the extra.
      if (this.binStream) { stream.readable.cancel().catch((): void => { return; }); stream.writable.close().catch((): void => { return; }); return; }
      this.binStream = stream;
      const rr = stream.readable.getReader();
      let carry = new Uint8Array(0);
      for (;;) {
        const { done, value } = await rr.read();
        if (done) {break;}
        const merged = new Uint8Array(carry.length + value.length);
        merged.set(carry); merged.set(value);
        carry = merged;
        while (carry.length >= 2) {
          const n = carry[0]! | (carry[1]! << 8);
          if (carry.length < 2 + n) {break;}
          this.config.onBinaryMessage?.(carry.subarray(2, 2 + n));
          carry = carry.subarray(2 + n);
        }
      }
    } catch { /* lane reset */ }
    // Bin lane dying degrades to base64 on stream 1 — never kills the
    // session (same rule as the datagram lane).
    this.binStream = null;
  }

  private async pumpDatagrams(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        this.config.onBinaryMessage?.(value);
      }
    } catch { /* lane reset */ }
    // The datagram lane is an optimization — its death degrades the
    // session to reliable-only, it must not kill the connection (a
    // dead lane declared the whole session dead, flapping reconnects
    // every few seconds and desyncing remotes by hundreds of meters).
    // Real session death is owned by wt.closed and the reliable pump.
    this.dgWriter = null;
    logger.warn('wt datagram lane ended — degrading to reliable-only');
  }

  send(data: string | Uint8Array): boolean {
    if (!this.open) {return false;}
    // Seq'd binary frames (position reports) that fit a datagram take the
    // unreliable lane — each is superseding state, so a drop costs the
    // next frame's worth of staleness, never a stall. Oversized frames
    // would be dropped WHOLESALE past the path MTU — they must stay on
    // the reliable stream (enveloped).
    if (data instanceof Uint8Array && data.byteLength <= WT_MAX_DATAGRAM) {
      if (this.dgWriter) {
        this.dgWriter.write(data).catch((): void => { return; });
        return true;
      }
    }
    // Binary must be enveloped too — decoding arbitrary bytes as UTF-8
    // mangled them before this ever worked.
    const payload = typeof data === 'string' ? data
      : `{"type":"bin","d":"${btoa(Array.from(data, (b): string => String.fromCharCode(b)).join(''))}"}`;
    // onConnect fires only after the stream is live, but a same-tick send
    // can still race the writer assignment — hold those briefly.
    if (!this.writer) { this.preOpen.push(payload); return true; }
    // A write can outlive the session — teardown rejects it; that's a
    // normal close, not an error.
    this.writer.write(this.encoder.encode(`${payload  }\n`)).catch((error): void => {
      logger.warn(`wt reliable write failed: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`);
    });
    return true;
  }

  connected(): boolean { return this.open; }
  /** Deliberate teardown ONLY — losing probe / NetworkManager shutdown.
   *  Internal failures must use declareDead() so the tier manager learns
   *  the lane died and reprobes. */
  disconnect(): void {
    this.open = false;
    this.stream = null; this.rr = null; this.dr = null; this.binStream = null;
    this.wt?.close();
  }
}

export async function tryWebTransport(config: ConnectionConfig): Promise<GameTransport | null> {
  if (typeof WebTransport === 'undefined') {return null;}
  // WT runs on its own QUIC port — ask /wthash (plain HTTP on the WS port)
  // for the port + the cert's DER SHA-256 so self-signed dev certs pin
  // without a CA install. Absent/disabled → no tier.
  try {
    const httpBase = config.url.replace(/^wss?:/, `http${  config.url.startsWith('wss') ? 's' : ''  }:`).replace(/\/ws$/, '');
    // Bounded — a flapping tunnel left this fetch hanging forever, which
    // stalled the whole re-probe and the session never recovered.
    const info = await (await fetch(`${httpBase}/wthash`, { signal: AbortSignal.timeout(4000) })).json();
    if (!info?.enabled || !info.port || !info.sha256) {return null;}
    // Chrome resolves `localhost` to ::1 but the QUIC listener is IPv4 —
    // normalized here (the pvptest adapter does the same) or loopback WT
    // dies with ERR_CONNECTION_RESET before the handshake starts.
    const rawHost = new URL(httpBase).hostname;
    const host = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
    const hashBytes = Uint8Array.from(atob(info.sha256), (c): number => c.charCodeAt(0));
    const wt = new WebTransport(`https://${host}:${info.port}`, {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes }],
    });
    // Failed probes leave wt.closed rejected with no subscriber —
    // unhandledrejection noise. Swallow it here; the winning session's
    // close is handled by WebTransportGameTransport's own subscription.
    wt.closed.catch((): void => { return; });
    try {
      // The probe IS the session — don't handshake twice.
      await Promise.race([wt.ready, new Promise((_, rej): NodeJS.Timeout => setTimeout(rej, 3000))]);
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

