/**
 * WebSocket transport: reconnect/backoff, bounded send queue while
 * connecting, and JSON-vs-binary frame routing. Protocol lives in
 * shared/protocol.ts; the binary codec in shared/wire.ts.
 */

import { netLogger } from './netLog.js';
import { WS_RECONNECT_INTERVAL } from '../core/config.js';
import type { ServerMessage } from '../../../shared/protocol.js';

// netLogger, not ChildLogger — this file also runs inside the net worker,
// where Logger's settings/urlParams imports would crash on load.
const logger = netLogger('WebSocketConnection');

export interface ConnectionConfig {
  url: string;
  /** Fleet hook: re-resolve the connect target before a retry — a dead
   *  worker's direct URL would otherwise be retried forever while the
   *  room already re-homed elsewhere. null → keep config.url. */
  resolveUrl?: () => Promise<string | null>;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  onConnect?: () => void;
  onDisconnect?: (code?: number, reason?: string) => void;
  onError?: (error: Error) => void;
  onMessage?: (data: ServerMessage) => void;
  onBinaryMessage?: (data: Uint8Array) => void;
  /** Worker transports report their own ping RTT (measured off the main
   *  thread — the honest wire number). */
  onRtt?: (rttMs: number) => void;
}

export class WebSocketConnection {
  readonly tier = 'ws' as const;
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;
  private messageQueue: { data: string | Uint8Array; type?: string; at: number }[] = [];
  private readonly MAX_QUEUE_SIZE = 100;
  // Queue-staleness policy (mirrors the server journal's volatile split):
  // KEEP_NEWEST types only ever flush the freshest entry — a reconnect
  // shouldn't replay 100 stale positions. KEEP_ALWAYS types are durable
  // intents that survive any gap (a chat line, a loadout pick). Everything
  // else — claims and one-shot intents like deploy/shot/skillUse — is only
  // worth sending inside STALE_MS; older than that it references a sim
  // moment that no longer exists and the server would reject it anyway.
  // No 'shotFired': it's NOT a replaceable state update — each queued
  // fire is a distinct shell the server must either spawn or reject.
  // KEEP_NEWEST evicted earlier fires when a newer one queued behind a
  // dead lane: the ghost-shell class (predicted hit, server never saw
  // the intent). It rides the default STALE_MS window like aoeShot.
  private static readonly KEEP_NEWEST = new Set(['inputMove', 'position', 'teleport', 'jump', 'jetpack']);
  // No 'pong': a queued pong's timestamp goes stale in the queue — the
  // echo arrives with seconds of phantom transit and poisons the server's
  // transit EMA; a missing RTT sample costs nothing by comparison.
  // No 'respawn'/'switchRoom'/'throwFlag' either — same rule NM's QUEUEABLE
  // applies: a suicide or room-hop queued pre-flap and flushed into the
  // next session is worse than losing the click. They fall under STALE_MS.
  private static readonly KEEP_ALWAYS = new Set(['join', 'chat', 'classUpdate', 'perkUpdate', 'snapshotRequest', 'resync']);
  private static readonly STALE_MS = 3000;
  private hasLoggedConnectionError = false;
  // 'close' fires asynchronously — a deliberate disconnect() would
  // otherwise reach the close handler below and schedule a reconnect,
  // resurrecting a session the caller wanted gone.
  private closedIntentionally = false;
  // minUptime damper (Colyseus): a session that dies before it ever
  // stabilized is a flap candidate — immediate retry just loops connect →
  // die → connect. Uptime <5s gets a 4x backoff instead of the base tick.
  private openedAt = 0;
  private static readonly MIN_UPTIME_MS = 5000;
  /** A black-holed connect (host up, port filtered, server dead) sits in
   *  CONNECTING for the OS TCP timeout (~2min) firing NO events — the
   *  reconnect loop starves that whole window. Bound the handshake; the
   *  close it triggers feeds the normal retry path. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly CONNECT_MS = 10_000;

  constructor(config: ConnectionConfig) {
    this.config = Object.assign({}, {reconnectInterval: WS_RECONNECT_INTERVAL,maxReconnectAttempts: Infinity}, config);
  }

  /**
   * Connect to the WebSocket server
   */
  connect(url?: string): void {
    this.closedIntentionally = false;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      logger.warn('WebSocket already connected or connecting');
      return;
    }

    try {
      this.ws = new WebSocket(url || this.config.url);
      // Explicitly set binaryType to handle binary frames correctly
      this.ws.binaryType = 'arraybuffer';

      const sock = this.ws;
      if (this.connectTimer) {clearTimeout(this.connectTimer);}
      this.connectTimer = setTimeout((): void => {
        if (this.ws === sock && sock.readyState === WebSocket.CONNECTING) {
          logger.warn(`connect handshake stuck ${WebSocketConnection.CONNECT_MS}ms — closing to retry`);
          sock.close();
        }
      }, WebSocketConnection.CONNECT_MS);

      this.ws.addEventListener('open', (): void => {
        logger.info('WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.hasLoggedConnectionError = false;
        this.openedAt = Date.now();
        
        // Call onConnect FIRST - let the application send its initial messages
        if (this.config.onConnect) {
          this.config.onConnect();
        }
        
        // Then flush the queue, dropping entries whose moment is gone.
        const now = Date.now();
        let stale = 0;
        while (this.messageQueue.length > 0) {
          const e = this.messageQueue.shift()!;
          if (e.type !== undefined && !WebSocketConnection.KEEP_ALWAYS.has(e.type)
              && now - e.at > WebSocketConnection.STALE_MS) {stale += 1; continue; }
          this.send(e.data);
        }
        if (stale > 0) {logger.info(`reconnect flush dropped ${stale} stale queued message(s)`);}
      });

      this.ws.addEventListener('close', (event): void => {
        logger.info(`WebSocket disconnected: ${event.code} - ${event.reason}`);
        this.isConnected = false;
        
        if (this.config.onDisconnect) {
          this.config.onDisconnect(event.code, event.reason);
        }

        if (this.closedIntentionally) {return;}

        // Attempt reconnection
        // ?? not || — an explicit 0 means "never reconnect", not "five tries"
        if (this.reconnectAttempts < (this.config.maxReconnectAttempts ?? 5)) {
this.reconnectAttempts += 1;
          const uptime = this.openedAt ? Date.now() - this.openedAt : 0;
          const delay = uptime < WebSocketConnection.MIN_UPTIME_MS
            ? (this.config.reconnectInterval ?? 1000) * 4
            : this.config.reconnectInterval;
          if (uptime < WebSocketConnection.MIN_UPTIME_MS) {
            logger.warn(`session died at ${Math.round(uptime)}ms uptime (${event.code}) — backoff ${delay}ms (flap damper)`);
          } else {
            logger.info(`Reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
          }
          this.reconnectTimer = setTimeout((): void => {
            // Fleet: re-resolve through the matchmaker — the room may
            // have re-homed onto a live worker since this URL died. Only
            // async when a resolver exists: an unconditional await pushed
            // plain-WS reconnects past the timer tick for no benefit.
            const resolve = this.config.resolveUrl;
            if (!resolve) { this.connect(); return; }
            (async (): Promise<void> => {
              try {
                const next = await resolve();
                if (next && next !== this.config.url) {
                  logger.info(`reconnect re-resolved ${this.config.url} -> ${next}`);
                  this.config.url = next;
                }
              } catch { /* keep the last URL — matchmaker hiccup isn't fatal */ }
              this.connect();
            })();
          }, delay);
        }
      });

      this.ws.addEventListener('error', (error): void => {
        if (!this.hasLoggedConnectionError) {
          logger.error('WebSocket error:', error);
          this.hasLoggedConnectionError = true;
        }
        if (this.config.onError) {
          this.config.onError(new Error('WebSocket connection error'));
        }
      });

      this.ws.addEventListener('message', (event): void => {
        try {
          const {data} = event;
          if (typeof data === 'string') {
            this.handleTextMessage(data);
          } else if (data instanceof ArrayBuffer) {
            this.handleBinaryMessage(data);
          }
        } catch (error) {
          logger.error('Error processing message:', error);
          this.config.onError?.(error as Error);
        }
      });

    } catch (error) {
      logger.error('Failed to create WebSocket:', error);
      this.config.onError?.(error as Error);
    }
  }

  private handleTextMessage(data: string): void {
    // Binary data can arrive as a string — non-printable first char means it's
    // really binary; convert and route to the binary handler
    if (data.charCodeAt(0) < 32 || data.charCodeAt(0) > 126) {
      logger.warn('Binary data received as string, converting to Uint8Array');
      const uint8Array = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        uint8Array[i] = data.charCodeAt(i);
      }
      if (this.config.onBinaryMessage) {
        this.config.onBinaryMessage(uint8Array);
      } else {
        logger.warn('No onBinaryMessage callback for binary data received as string');
      }
      return;
    }

    // JSON message (join, joinAck, etc.)
    try {
      this.config.onMessage?.(JSON.parse(data));
    } catch (error) {
      logger.error('Error parsing JSON message:', error);
      this.config.onError?.(error as Error);
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    logger.debug('Received binary message, onBinaryMessage:', Boolean(this.config.onBinaryMessage));
    if (this.config.onBinaryMessage) {
      try {
        this.config.onBinaryMessage(new Uint8Array(data));
      } catch (error) {
        logger.error('Error in onBinaryMessage:', error);
        this.config.onError?.(error as Error);
      }
      return;
    }
    logger.warn('Binary frame with no onBinaryMessage callback — dropped');
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.closedIntentionally = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.messageQueue = [];
  }

  /**
   * Send data - handles JSON strings, objects (msgpack), and binary data
   */
  send(data: string | Uint8Array): boolean {
    if (!this.isConnected || !this.ws) {
      // Binary frames are volatile state (position) — only the newest one
      // is worth flushing after reconnect; drop queued predecessors instead
      // of replaying 100 stale positions into the live socket.
      let type: string | undefined = undefined;
      if (typeof data === 'string') {
        try { ({type} = JSON.parse(data) as { type?: string }); } catch { /* unparseable: queue anyway */ }
      }
      if (data instanceof Uint8Array) {
        this.messageQueue = this.messageQueue.filter((m): boolean => !(m.data instanceof Uint8Array));
      } else if (type !== undefined && WebSocketConnection.KEEP_NEWEST.has(type)) {
        this.messageQueue = this.messageQueue.filter((m): boolean => m.type !== type);
      }
      if (this.messageQueue.length < this.MAX_QUEUE_SIZE) {
        this.messageQueue.push({ data, type, at: Date.now() });
      }
      return false;
    }

    try {
      if (typeof data === 'string') {
        // JSON frame as-is
        this.ws.send(data);
      } else if (data instanceof Uint8Array) {
        // Binary wire frame (shared/wire.ts).
        // Fresh copy: Uint8Array<ArrayBufferLike> isn't a valid BufferSource
        // under newer TS DOM types (SharedArrayBuffer possibility)
        this.ws.send(new Uint8Array(data));
      } else {
        logger.warn('send() called with non-string/non-binary data — dropped');
        return false;
      }
      return true;
    } catch (error) {
      logger.error('Error sending message:', error);
      if (this.config.onError) {
        this.config.onError(error as Error);
      }
      return false;
    }
  }

  /**
   * Check if connected
   */
  connected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection state
   */
  getState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}
