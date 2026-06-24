/**
 * WebSocket Connection Wrapper with msgpack encoding (Server)
 * Based on Krunker.io's approach using msgpack for efficient binary communication
 *
 * Provides a clean API for WebSocket communication with automatic msgpack encoding/decoding
 * Designed for uWebSockets.js integration
 */

import msgpack from 'msgpack-lite';
import { Logger } from './Logger.js';

export interface ServerConnectionConfig {
  onMessage?: (data: any) => void;
  onBinaryMessage?: (data: Uint8Array) => void;
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
      Logger.error('Error sending message:', error);
      if (this.config.onError) {
        this.config.onError(error as Error);
      }
      return false;
    }
  }

  /**
   * Send raw binary data without msgpack encoding (for Tribes2 packets)
   */
  sendBinary(data: Uint8Array): boolean {
    if (!this.isConnected) {
      return false;
    }

    try {
      this.ws.send(data);
      return true;
    } catch (error) {
      Logger.error('Error sending binary message:', error);
      if (this.config.onError) {
        this.config.onError(error as Error);
      }
      return false;
    }
  }

  /**
   * Handle incoming message
   * Detects JSON strings vs binary data (msgpack or Tribes2 bit-packed)
   */
  handleMessage(data: ArrayBuffer): void {
    try {
      const uint8Array = new Uint8Array(data);

      // Try to detect if this is a JSON string (UTF-8)
      // Check for common JSON starting characters
      const firstByte = uint8Array[0];
      const isLikelyJSON = firstByte === 0x7B || // '{'
                           firstByte === 0x5B || // '['
                           firstByte === 0x22 || // '"'
                           firstByte === 0x7D || // '}'
                           firstByte === 0x5D;  // ']'

      if (isLikelyJSON) {
        // Try to decode as UTF-8 string and parse as JSON
        const text = new TextDecoder().decode(uint8Array);
        const parsed = JSON.parse(text);
        if (this.config.onMessage) {
          this.config.onMessage(parsed);
        }
      } else {
        // Binary data - route to onBinaryMessage callback
        if (this.config.onBinaryMessage) {
          this.config.onBinaryMessage(uint8Array);
        } else {
          // Fallback: try msgpack decode
          const decoded = msgpack.decode(uint8Array);
          if (this.config.onMessage) {
            this.config.onMessage(decoded);
          }
        }
      }
    } catch (error) {
      Logger.error('Error handling message:', error);
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
