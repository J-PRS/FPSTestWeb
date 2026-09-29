/**
 * WebSocket transport: reconnect/backoff, bounded send queue while
 * connecting, and JSON-vs-binary frame routing. Protocol lives in
 * shared/protocol.ts; the binary codec in shared/wire.ts.
 */

import { ChildLogger } from '../core/Logger.js';
import { WS_RECONNECT_INTERVAL } from '../core/config.js';
import type { ServerMessage } from '../../../shared/protocol.js';

const logger = new ChildLogger('WebSocketConnection');

export interface ConnectionConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  onConnect?: () => void;
  onDisconnect?: (code?: number, reason?: string) => void;
  onError?: (error: Error) => void;
  onMessage?: (data: ServerMessage) => void;
  onBinaryMessage?: (data: Uint8Array) => void;
}

export class WebSocketConnection {
  readonly tier = 'ws' as const;
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected: boolean = false;
  private messageQueue: (string | Uint8Array)[] = [];
  private readonly MAX_QUEUE_SIZE = 100;
  private hasLoggedConnectionError: boolean = false;

  constructor(config: ConnectionConfig) {
    this.config = {
      reconnectInterval: WS_RECONNECT_INTERVAL,
      maxReconnectAttempts: Infinity, // Unlimited reconnection attempts
      ...config
    };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(url?: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      logger.warn('WebSocket already connected or connecting');
      return;
    }

    try {
      this.ws = new WebSocket(url || this.config.url);
      // Explicitly set binaryType to handle binary frames correctly
      this.ws.binaryType = 'arraybuffer';

      this.ws.addEventListener('open', () => {
        logger.info('WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.hasLoggedConnectionError = false;
        
        // Call onConnect FIRST - let the application send its initial messages
        if (this.config.onConnect) {
          this.config.onConnect();
        }
        
        // Then send any queued messages
        while (this.messageQueue.length > 0) {
          this.send(this.messageQueue.shift()!);
        }
      });

      this.ws.addEventListener('close', (event) => {
        logger.info(`WebSocket disconnected: ${event.code} - ${event.reason}`);
        this.isConnected = false;
        
        if (this.config.onDisconnect) {
          this.config.onDisconnect(event.code, event.reason);
        }

        // Attempt reconnection
        // ?? not || — an explicit 0 means "never reconnect", not "five tries"
        if (this.reconnectAttempts < (this.config.maxReconnectAttempts ?? 5)) {
          this.reconnectAttempts++;
          logger.info(`Reconnection attempt ${this.reconnectAttempts} in ${this.config.reconnectInterval}ms`);
          
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, this.config.reconnectInterval);
        }
      });

      this.ws.addEventListener('error', (error) => {
        if (!this.hasLoggedConnectionError) {
          logger.error('WebSocket error:', error);
          this.hasLoggedConnectionError = true;
        }
        if (this.config.onError) {
          this.config.onError(new Error('WebSocket connection error'));
        }
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const data = event.data;
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
      for (let i = 0; i < data.length; i++) {
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
    logger.debug('Received binary message, onBinaryMessage:', !!this.config.onBinaryMessage);
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
      if (data instanceof Uint8Array) {
        this.messageQueue = this.messageQueue.filter(m => !(m instanceof Uint8Array));
      }
      if (this.messageQueue.length < this.MAX_QUEUE_SIZE) {
        this.messageQueue.push(data);
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
