import { INetworkAdapter } from './INetworkAdapter';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('WSAdapter');

/**
 * WebSocket-based networking adapter
 * Implements INetworkAdapter using the ws library
 */
export class WSAdapter implements INetworkAdapter {
  private ws: WebSocket | null = null;
  private messageCallback: ((data: any) => void) | null = null;
  private binaryMessageCallback: ((data: Uint8Array) => void) | null = null;
  private connectCallback: (() => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;
  private reconnectCallback: (() => void) | null = null;

  private url: string = '';
  private reconnectTimer: number | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000; // 1 second
  private maxReconnectDelay: number = 30000; // 30 seconds
  private shouldReconnect: boolean = true;
  private lastWarningTime: number = 0;
  private readonly WARNING_COOLDOWN_MS = 1000; // Only log warnings once per second

  async connect(url: string): Promise<void> {
    this.url = url;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          logger.info('Connected to server');
          this.reconnectAttempts = 0; // Reset on successful connect
          this.connectCallback?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            // Binary message
            if (this.binaryMessageCallback) {
              this.binaryMessageCallback(new Uint8Array(event.data));
            }
          } else {
            // JSON message (for compatibility with control messages)
            if (this.messageCallback) {
              try {
                const data = JSON.parse(event.data);
                this.messageCallback(data);
              } catch (e) {
                logger.error('Failed to parse message', e);
              }
            }
          }
        };

        this.ws.onclose = () => {
          logger.info('Disconnected from server');
          this.disconnectCallback?.();
          
          // Auto-reconnect if enabled
          if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          logger.error('WebSocket error', error);
          this.errorCallback?.(new Error('WebSocket error'));
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }

    // Exponential backoff: delay = base * 2^attempts
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;
      logger.debug(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch((error) => {
        logger.error('Reconnect failed', error);
      });
    }, delay) as unknown as number;
  }

  disconnect(): void {
    this.shouldReconnect = false; // Disable auto-reconnect on explicit disconnect
    
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (error) {
        logger.error('Failed to send message', error);
      }
    } else {
      const now = Date.now();
      if (now - this.lastWarningTime >= this.WARNING_COOLDOWN_MS) {
        logger.warn('Cannot send: WebSocket not connected');
        this.lastWarningTime = now;
      }
    }
  }

  sendBinary(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data);
      } catch (error) {
        logger.error('Failed to send binary message', error);
      }
    } else {
      const now = Date.now();
      if (now - this.lastWarningTime >= this.WARNING_COOLDOWN_MS) {
        logger.warn('Cannot send binary: WebSocket not connected');
        this.lastWarningTime = now;
      }
    }
  }

  onMessage(callback: (data: any) => void): void {
    this.messageCallback = callback;
  }

  onBinaryMessage(callback: (data: Uint8Array) => void): void {
    this.binaryMessageCallback = callback;
  }

  onConnect(callback: () => void): void {
    this.connectCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallback = callback;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
