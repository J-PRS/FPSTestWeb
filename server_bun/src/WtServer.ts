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
 * JSON lane (newline-delimited, matching the client transport) — ALL
 * outbound traffic rides it: measured datagram loss on loopback was
 * ~47%, so the unreliable lane buys nothing. Presents the
 * ServerWebSocket shape GameServer uses — send/close/readyState/data.
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
    void this.acceptReliable().catch(() => this.die());
    void this.pumpDatagrams().catch(() => {}); // session death ends the iterator
    // Every lane here rejects with E_SESSION_CLOSED when the peer drops —
    // an unhandled rejection in the native addon's stream callbacks kills
    // the whole bun process, so each one is caught at its boundary.
    session.closed.then(() => this.die()).catch(() => this.die());
  }

  private asSocket(): ServerWebSocket<WebSocketData> {
    return this as unknown as ServerWebSocket<WebSocketData>;
  }

  private die(): void {
    if (!this.open) return;
    this.open = false;
    this.game.onClose(this.asSocket());
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
      if (readDone) break;
      carry += this.decoder.decode(value, { stream: true });
      // A peer that never sends '\n' grows this buffer forever — cap it.
      if (carry.length > 65536) { this.close(1009, 'oversize frame'); return; }
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) this.deliverLine(line);
      }
    }
    // Reliable stream ended while the session lives — the lane is dead,
    // treat the socket as closed rather than leaving a zombie.
    this.die();
  }

  /** One newline-delimited frame. Binary frames arrive base64-wrapped
   *  (see send) — decode before the game sees them so position claims
   *  keep their binary shape. */
  private deliverLine(line: string): void {
    if (line.length > 8 && line.charCodeAt(0) === 123 && line.charCodeAt(9) === 98) {
      try {
        const m = JSON.parse(line) as { type?: string; d?: string };
        if (m?.type === 'bin' && typeof m.d === 'string') {
          this.game.onMessage(this.asSocket(), new Uint8Array(Buffer.from(m.d, 'base64')));
          return;
        }
      } catch { /* fall through to raw line */ }
    }
    this.game.onMessage(this.asSocket(), line);
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
    // The reliable stream is newline-delimited TEXT — raw binary has no
    // '\n' and corrupts the framing (it glued onto the next JSON line and
    // ate ballSpawn messages — creatures that existed but never spawned).
    // Binary rides as base64 in a JSON envelope; the client unwraps it.
    const line = typeof msg === 'string' ? msg
      : `{"type":"bin","d":"${Buffer.from(msg).toString('base64')}"}`;
    const bytes = this.encoder.encode(line + '\n');
    void this.writer.write(bytes).catch(() => {});
    return bytes.byteLength;
  }

  close(_code = 1000, reason = ''): void {
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
const swallow = (err: unknown): boolean => String(err).includes('E_SESSION_CLOSED');

export class WtServer {
  private static sessionCloseGuardInstalled = false;
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
      // The native addon throws E_SESSION_CLOSED inside its stream-start
      // callbacks on peer drop — if any of those escape our adapter
      // catches they'd take down the whole process, so filter that one
      // known-benign code at the boundary. Anything else still crashes.
      if (!WtServer.sessionCloseGuardInstalled) {
        WtServer.sessionCloseGuardInstalled = true;
        process.on('unhandledRejection', (err) => { if (!swallow(err)) throw err; });
        // The addon also throws E_SESSION_CLOSED synchronously inside
        // stream-start callbacks — that lands as uncaughtException, not a
        // rejection, so the rejection-only guard used to miss it.
        process.on('uncaughtException', (err) => {
          if (swallow(err)) { logger.warn('WT session died mid-stream (E_SESSION_CLOSED)', {}); return; }
          // Preserve crash-on-unknown semantics — throwing from inside an
          // uncaughtException handler just recurses, so exit directly.
          logger.error('Uncaught exception', { error: String(err), stack: (err as Error).stack });
          process.exit(1);
        });
      }
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
