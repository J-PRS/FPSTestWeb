import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';
import { logger } from './logger.ts';
import type { GameServer } from './GameServer.ts';
import { wallNow } from './wallClock.ts';
import { WIRE_TICK, WIRE_TICK_V3, WIRE_TICK_V4 } from '../../shared/wire.ts';

// QUIC datagrams have no fragmentation — frames past the path MTU are
// dropped wholesale (measured: 1400B datagrams → 0% delivered on
// loopback while 32B frames landed 100%; the old "47% loss" reading was
// exactly this size cliff). Only volatile seq'd frames below the cap may
// ride the datagram lane; anything else takes the reliable stream.
export const WT_MAX_DATAGRAM = 1200;

// @webtransport-bun/webtransport is a native (napi-rs/wtransport) module.
// Loaded lazily like node-datachannel — if the native addon fails, WT is
// disabled and /ws keeps serving rather than killing the process.
type WtDuplex = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
type WtSession = {
  readonly peer?: { ip: string; port: number };
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
 * JSON lane (newline-delimited, matching the client transport). Lane
 * route mirrors the RTC adapter: seq'd WIRE_TICK frames small enough for
 * a datagram take the unreliable lane (a superseded tick must not stall
 * the reliable stream behind it), everything else is reliable.
 * Presents the ServerWebSocket shape GameServer uses —
 * send/close/readyState/data.
 */
export class WtSocketAdapter {
  readonly data: WebSocketData = { playerId: '', connectedAt: wallNow() };
  // The session knows its peer — a literal string put EVERY WT client in
  // one per-IP join-throttle bucket (the same bug the RTC adapter had).
  readonly remoteAddress: string;
  private open = true;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** Stream-2 reliable-binary lane: length-prefixed u16 frames, no
   *  base64/newline tax, and HoL-isolated from the JSON stream — a big
   *  oversized tick frame can't stall an event behind it. Set when the
   *  client's second bidi stream arrives (caps.binLane handshake). */
  private binWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private binScratch = new ArrayBuffer(2);
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(
    private session: WtSession,
    private game: GameServer,
  ) {
    this.remoteAddress = session.peer?.ip ?? 'webtransport';
    // The client's first action after connect is creating THE reliable
    // bidi stream — grab it and start pumping both lanes.
    this.acceptReliable().catch((error): void => this.die(`reliable pump: ${error instanceof Error ? error.message : error}`));
    this.pumpDatagrams().catch((error): void => { logger.warn('wt dg lane ended', { e: String(error) }); }); // session death ends the iterator
    // Every lane here rejects with E_SESSION_CLOSED when the peer drops —
    // an unhandled rejection in the native addon's stream callbacks kills
    // the whole bun process, so each one is caught at its boundary.
    session.closed.then((): void => this.die('session.closed')).catch((error): void => this.die(`session.closed err: ${error instanceof Error ? error.message : error}`));
  }

  private asSocket(): ServerWebSocket<WebSocketData> {
    return this as unknown as ServerWebSocket<WebSocketData>;
  }

  private die(reason = 'unspecified'): void {
    if (!this.open) {return;}
    this.open = false;
    logger.warn('wt session died', { reason });
    this.game.onClose(this.asSocket());
  }

  private async acceptReliable(): Promise<void> {
    const reader = this.session.incomingBidirectionalStreams.getReader();
    // Stream index 0 is the JSON text lane (existing contract). Any later
    // stream is the caps.binLane client opting into the raw-binary lane.
    let idx = 0;
    for (;;) {
      const { value: stream, done: streamDone } = await reader.read();
      if (streamDone || !stream) {return;}
      if (((idx += 1) - 1) === 0) {this.pumpText(stream).catch((error): void => this.die(`reliable pump: ${error instanceof Error ? error.message : error}`));}
      else {this.pumpBin(stream).catch((): void => { return; });}
    }
  }

  /** Stream-2+: u16-length-prefixed binary both ways. Uplink feeds the
   *  same binary path as datagrams; downlink is this.binWriter. */
  private async pumpBin(stream: WtDuplex): Promise<void> {
    this.binWriter = stream.writable.getWriter();
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
        this.game.onMessage(this.asSocket(), carry.subarray(2, 2 + n));
        carry = carry.subarray(2 + n);
      }
    }
    // Bin lane ending while JSON lives degrades to base64 — don't die.
    this.binWriter = null;
  }

  private async pumpText(stream: WtDuplex): Promise<void> {
    this.writer = stream.writable.getWriter();
    // Reliable lane is newline-delimited JSON (same framing as the
    // client's WebTransportGameTransport produces).
    let carry = '';
    const rr = stream.readable.getReader();
    for (;;) {
      const { done: readDone, value } = await rr.read();
      if (readDone) {break;}
      carry += this.decoder.decode(value, { stream: true });
      // A peer that never sends '\n' grows this buffer forever — cap it.
      if (carry.length > 65_536) { this.close(1009, 'oversize frame'); return; }
      // oxlint-disable-next-line init-declarations -- assigned later
      let nl!: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line) {this.deliverLine(line);}
      }
    }
    // Reliable stream ended while the session lives — the lane is dead,
    // treat the socket as closed rather than leaving a zombie.
    this.die('reliable stream ended');
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

  // desiredSize goes negative once the writable's internal queue is
  // backlogged — report the negative magnitude as buffered bytes.
  getBufferedAmount(): number {
    // Both lanes' queues count toward the drown check — a client
    // backlogging on the bin lane alone would otherwise escape it.
    return Math.max(0, -(this.writer?.desiredSize ?? 0)) + Math.max(0, -(this.binWriter?.desiredSize ?? 0));
  }

  send(msg: string | Uint8Array): number {
    if (!this.open) {return 0;}
    // Volatile seq'd tick frames → datagram lane when they fit the MTU.
    // An oversized tick stays reliable: datagrams over the path MTU are
    // dropped ENTIRELY, so "best effort" there is actually "never".
    // This lane must not wait on the reliable writer — the streams are
    // independent and the tick fanout starts before the bidi attaches.
    if (typeof msg !== 'string' &&
        msg.length >= 2 && msg[0] === 0x54 &&
        (msg[1] === WIRE_TICK || msg[1] === WIRE_TICK_V3 || msg[1] === WIRE_TICK_V4) &&
        msg.byteLength <= WT_MAX_DATAGRAM) {
      this.session.sendDatagram(msg).catch((): void => { return; });
      return msg.byteLength;
    }
    // Stream-2 (caps.binLane opt-in): oversized TICK frames only — raw
    // u16-framed, no base64 tax, and HoL-isolated so a 1300B tick can't
    // stall an event behind it. Tick frames were already unordered vs
    // events on the datagram lane, so the second stream changes nothing
    // about ordering. Other binary (ballSeg etc.) must STAY on stream 1:
    // its relative order against JSON spawn/roster events is load-bearing
    // (a segment beating its ballSpawn left stale regimes — the BALL
    // DESYNC churn on enraged/targetId).
    if (typeof msg !== 'string' && this.binWriter &&
        msg.length >= 2 && msg[0] === 0x54 &&
        (msg[1] === WIRE_TICK || msg[1] === WIRE_TICK_V3 || msg[1] === WIRE_TICK_V4) &&
        msg.byteLength <= 0xFF_FF) {
      const v = new DataView(this.binScratch);
      v.setUint16(0, msg.byteLength);
      this.binWriter.write(new Uint8Array(this.binScratch)).catch((): void => { return; });
      this.binWriter.write(msg).catch((): void => { return; });
      return msg.byteLength;
    }
    if (!this.writer) {return 0;}
    // The reliable stream is newline-delimited TEXT — raw binary has no
    // '\n' and corrupts the framing (it glued onto the next JSON line and
    // ate ballSpawn messages — creatures that existed but never spawned).
    // Binary rides as base64 in a JSON envelope; the client unwraps it.
    const line = typeof msg === 'string' ? msg
      : `{"type":"bin","d":"${Buffer.from(msg).toString('base64')}"}`;
    const bytes = this.encoder.encode(`${line  }\n`);
    this.writer.write(bytes).catch((): void => { return; });
    return bytes.byteLength;
  }

  close(_code = 1000, reason = ''): void {
    logger.warn('wt close() called', { code: _code, reason, by: new Error().stack?.split('\n').slice(1, 4).join(' | ') });
    try { this.session.close({ closeCode: 0, reason }); } catch { /* gone */ }
    // A locally-initiated close can't be assumed to re-enter through
    // session.closed — without die() here, kicks/idle reaps never reach
    // onClose and the player stays registered as a zombie forever.
    this.die();
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
    // oxlint-disable-next-line init-declarations -- assigned later (callback/beforeEach)
    let mod!: WtModule;
    try {
      const m = await import('@webtransport-bun/webtransport');
      mod = m as unknown as WtModule;
    } catch (error) {
      logger.warn('WebTransport addon unavailable — WT tier disabled', { error: (error as Error).message });
      return false;
    }
    try {
      this.server = mod.createServer({
        port: opts.port,
        tls: { certPem: opts.certPem, keyPem: opts.keyPem, allowSelfSigned: true },
        onSession: (session): void => this.onSession(session),
      });
      // The native addon throws E_SESSION_CLOSED inside its stream-start
      // callbacks on peer drop — if any of those escape our adapter
      // catches they'd take down the whole process, so filter that one
      // known-benign code at the boundary. Anything else still crashes.
      if (!WtServer.sessionCloseGuardInstalled) {
        WtServer.sessionCloseGuardInstalled = true;
        process.on('unhandledRejection', (err): void => { if (!swallow(err)) {throw err;} });
        // The addon also throws E_SESSION_CLOSED synchronously inside
        // stream-start callbacks — that lands as uncaughtException, not a
        // rejection, so the rejection-only guard used to miss it.
        process.on('uncaughtException', (err): void => {
          if (swallow(err)) { logger.warn('WT session died mid-stream (E_SESSION_CLOSED)', {}); return; }
          // Preserve crash-on-unknown semantics — throwing from inside an
          // uncaughtException handler just recurses, so exit directly.
          logger.error('Uncaught exception', { error: String(err), stack: (err as Error).stack });
          process.exit(1);
        });
      }
      logger.info('WebTransport listening', { port: opts.port });
      return true;
    } catch (error) {
      logger.warn('WebTransport server failed to start', { error: (error as Error).message });
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
    await this.server?.close().catch((): void => { return; });
    this.server = null;
  }
}
