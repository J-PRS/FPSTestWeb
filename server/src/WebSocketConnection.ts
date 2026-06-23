/**
 * WebSocket Connection Wrapper with msgpack encoding (Server)
 * Based on Krunker.io's approach using msgpack for efficient binary communication
 * 
 * Provides a clean API for WebSocket communication with automatic msgpack encoding/decoding
 * Designed for uWebSockets.js integration
 */

import msgpack from 'msgpack-lite';

export interface ServerConnectionConfig {
  onMessage?: (data: any) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export class WebSocketConnection {
  private ws: any; // uWebSockets.js WebSocket
  private config: ServerConnectionConfig;
  private isConnected: boolean = false;

  constructor(ws: any, config: ServerConnectionConfig) {
    this.ws = ws;
    this.config = config;
    this.isConnected = true;
  }

  /**
   * Send data using msgpack encoding
   */
  send(data: any): boolean {
    if (!this.isConnected) {
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
   * Handle incoming message
   */
  handleMessage(data: ArrayBuffer): void {
    try {
      // Decode msgpack message
      const decoded = msgpack.decode(new Uint8Array(data));
      
      if (this.config.onMessage) {
        this.config.onMessage(decoded);
      }
    } catch (error) {
      console.error('Error decoding message:', error);
      if (this.config.onError) {
        this.config.onError(error as Error);
      }
    }
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.isConnected) {
      this.ws.close();
      this.isConnected = false;
    }
  }

  /**
   * Check if connected
   */
  connected(): boolean {
    return this.isConnected;
  }

  /**
   * Get the underlying WebSocket
   */
  getWebSocket(): any {
    return this.ws;
  }
}
