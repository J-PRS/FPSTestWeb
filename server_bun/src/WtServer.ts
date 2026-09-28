import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import type { GameServer } from './GameServer.ts';

// @webtransport-bun/webtransport is a native (napi-rs/wtransport) module.
// Loaded lazily like node-datachannel — if the native addon fails, WT is
// disabled and /ws keeps serving rather than killing the process.
type WtDuplex = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
type WtSession = {
  ready: Promise<void>;
  closed: Promise<{ closeCode?: number; reason?: string }>;
  close(info?: { closeCode?: number; reason?: string }): void;
  sendDatagram(data: Uint8Array): Promise<void>;
  incomingDatagrams(): AsyncIterable<Uint8Array>;
  incomingBidirectionalStreams: ReadableStream<WtDuplex>;
  createBidirectionalStream(): Promise<WtDuplex>;
};
type WtModule = {
  createServer(opts: {
    host?: string;
    port: number;
    tls: { certPem: string | Uint8Array; keyPem: string | Uint8Array; allowSelfSigned?: boolean };
    onSession(session: WtSession): void;
  }): { address: { host: string; port: number }; close(): Promise<void> };
};

/**
 * Socket adapter: a WT session's first bidi stream carries the reliable
 * JSON lane (newline-delimited, matching the client transport), datagrams
 * carry the binary position frames. Presents the ServerWebSocket shape
 * GameServer uses — send/close/readyState/data.
 */
class WtSocketAdapter {
  readonly data: WebSocketData = { playerId: '', connectedAt: Date.now() };
  readonly remoteAddress = 'webtransport';
  private open = true;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    private session: WtSession,
    private game: GameServer,
  ) {
    // The client's first action after connect is creating THE reliable
    // bidi stream — grab it and start pumping both lanes.
    void this.acceptReliable();
    void this.pumpDatagrams();
    session.closed.then(() => {
      if (this.open) {
        this.open = false;
        this.game.onClose(this.asSocket());
      }
    });
  }

  private asSocket(): ServerWebSocket<WebSocketData> {
    return this as unknown as ServerWebSocket<WebSocketData>;
  }

  private async acceptReliable(): Promise<void> {
    const reader = this.session.incomingBidirectionalStreams.getReader();
    const { value: stream, done: streamDone } = await reader.read();
    if (streamDone || !stream) return;
    this.writer = stream.writable.getWriter();
    // Reliable lane is newline-delimited JSON (same framing as the
    // client's WebTransportGameTransport produces).
    let carry = '';
    const rr = stream.readable.getReader();
    for (;;) {
      const { done: readDone, value } = await rr.read();
      if (readDone) return;
      carry += this.decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) this.game.onMessage(this.asSocket(), line);
      }
    }
  }

  private async pumpDatagrams(): Promise<void> {
    for await (const dg of this.session.incomingDatagrams()) {
      // Feed the same binary path /ws frames take.
      this.game.onMessage(this.asSocket(), new Uint8Array(dg));
    }
  }

  get readyState(): number { return this.open ? 1 : 3; }

  send(msg: string | Uint8Array): number {
    if (!this.open || !this.writer) return 0;
    const bytes = typeof msg === 'string' ? this.encoder.encode(msg + '\n') : new Uint8Array(msg);
    void this.writer.write(bytes);
    return bytes.byteLength;
  }

  sendUnreliable(data: Uint8Array): number {
    if (!this.open) return 0;
    void this.session.sendDatagram(data).catch(() => {});
    return data.byteLength;
  }

  close(code = 1000, reason = ''): void {
    this.open = false;
    try { this.session.close({ closeCode: 0, reason }); } catch { /* gone */ }
  }
}

/**
 * WebTransport game endpoint — a separate QUIC/HTTP3 UDP listener sharing
 * GameServer via the socket adapter. Needs a TLS cert+key (QUIC has no
 * plaintext mode); a self-signed pair works for dev since browser clients
 * can pin `serverCertificateHashes`. Disabled when FPS_WT_PORT / cert env
 * are unset or the native addon won't load.
 */
export class WtServer {
  private server: { close(): Promise<void> } | null = null;

  constructor(private game: GameServer) {}

  async start(opts: { port: number; certPem: string; keyPem: string }): Promise<boolean> {
    let mod: WtModule;
    try {
      const m = await import('@webtransport-bun/webtransport');
      mod = m as unknown as WtModule;
    } catch (e) {
      logger.warn('WebTransport addon unavailable — WT tier disabled', { error: (e as Error).message });
      return false;
    }
    try {
      this.server = mod.createServer({
        port: opts.port,
        tls: { certPem: opts.certPem, keyPem: opts.keyPem, allowSelfSigned: true },
        onSession: (session) => this.onSession(session),
      });
      logger.info('WebTransport listening', { port: opts.port });
      return true;
    } catch (e) {
      logger.warn('WebTransport server failed to start', { error: (e as Error).message });
      return false;
    }
  }

  private onSession(session: WtSession): void {
    const adapter = new WtSocketAdapter(session, this.game);
    // Mirror onOpen semantics — the handshake still happens over the
    // reliable lane as the first JSON message, same as /ws.
    this.game.onOpen(adapter as unknown as ServerWebSocket<WebSocketData>);
  }

  async stop(): Promise<void> {
    await this.server?.close().catch(() => {});
    this.server = null;
  }
}
