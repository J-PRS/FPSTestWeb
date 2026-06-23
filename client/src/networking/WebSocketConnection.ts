/**
 * WebSocket Connection Wrapper with msgpack encoding
 * Based on Krunker.io's approach using msgpack for efficient binary communication
 * 
 * Provides a clean API for WebSocket communication with automatic msgpack encoding/decoding
 */

import msgpack from 'msgpack-lite';

export interface ConnectionConfig {
  url: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  onMessage?: (data: any) => void;
}

export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private messageQueue: any[] = [];

  constructor(config: ConnectionConfig) {
    this.config = {
      reconnectInterval: 3000,
      maxReconnectAttempts: 5,
      ...config
    };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(url?: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.warn('WebSocket already connected or connecting');
      return;
    }

    try {
      this.ws = new WebSocket(url || this.config.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        // Send queued messages
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          this.send(msg);
        }
        
        if (this.config.onConnect) {
          this.config.onConnect();
        }
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket disconnected', event.code, event.reason);
        this.isConnected = false;
        
        if (this.config.onDisconnect) {
          this.config.onDisconnect();
        }

        // Attempt reconnection
        if (this.reconnectAttempts < (this.config.maxReconnectAttempts || 5)) {
          this.reconnectAttempts++;
          console.log(`Reconnection attempt ${this.reconnectAttempts} in ${this.config.reconnectInterval}ms`);
          
          this.reconnectTimer = setTimeout(() => {
            this.connect();
          }, this.config.reconnectInterval);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        if (this.config.onError) {
          this.config.onError(new Error('WebSocket connection error'));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          // Decode msgpack message
          const data = msgpack.decode(new Uint8Array(event.data));
          
          if (this.config.onMessage) {
            this.config.onMessage(data);
          }
        } catch (error) {
          console.error('Error decoding message:', error);
          if (this.config.onError) {
            this.config.onError(error as Error);
          }
        }
      };

    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      if (this.config.onError) {
        this.config.onError(error as Error);
      }
    }
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
   * Send data using msgpack encoding
   */
  send(data: any): boolean {
    if (!this.isConnected || !this.ws) {
      console.warn('WebSocket not connected, queuing message');
      this.messageQueue.push(data);
      return false;
    }

    try {
      // Encode data using msgpack
      const encoded = msgpack.encode(data);
      this.ws.send(encoded);
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
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
