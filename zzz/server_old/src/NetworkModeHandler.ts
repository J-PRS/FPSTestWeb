/**
 * NetworkModeHandler - Base interface for different network mode implementations
 * Allows switching between server-authoritative and relay modes
 */

import { NetworkMode } from './config.js';

export interface NetworkModeHandler {
  /**
   * Initialize the handler for a connection
   */
  initializeConnection(connectionId: string, onSend: (connectionId: string, data: Uint8Array) => void): void;

  /**
   * Handle incoming packet from a connection
   */
  handlePacket(connectionId: string, data: Uint8Array): void;

  /**
   * Start packet transmission for a connection
   */
  startConnection(connectionId: string): void;

  /**
   * Stop packet transmission for a connection
   */
  stopConnection(connectionId: string): void;

  /**
   * Remove a connection and cleanup resources
   */
  removeConnection(connectionId: string): void;

  /**
   * Check if a connection is initialized
   */
  isConnectionInitialized(connectionId: string): boolean;

  /**
   * Mark join handshake as complete for a connection
   */
  markJoinHandshakeComplete(connectionId: string): void;

  /**
   * Get the network mode this handler implements
   */
  getMode(): NetworkMode;
}
