/**
 * RelayModeHandler - Simple packet forwarding between clients
 * Server acts as a relay without processing game state
 */

import { NetworkModeHandler } from './NetworkModeHandler.js';
import { NetworkMode } from './config.js';
import { Logger } from './Logger.js';

export class RelayModeHandler implements NetworkModeHandler {
  private connections: Map<string, {
    onSend: (connectionId: string, data: Uint8Array) => void;
    initialized: boolean;
    handshakeComplete: boolean;
  }> = new Map();

  private roomId: string = 'default';

  setRoomId(roomId: string): void {
    this.roomId = roomId;
  }

  initializeConnection(connectionId: string, onSend: (connectionId: string, data: Uint8Array) => void): void {
    this.connections.set(connectionId, {
      onSend,
      initialized: true,
      handshakeComplete: false
    });
    Logger.info(`RelayMode: Initialized connection ${connectionId}`);
  }

  handlePacket(connectionId: string, data: Uint8Array): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.handshakeComplete) {
      Logger.warn(`RelayMode: Ignoring packet from ${connectionId} - handshake not complete`);
      return;
    }

    // Forward to all other connections in the same room
    for (const [otherId, otherConn] of this.connections.entries()) {
      if (otherId !== connectionId && otherConn.handshakeComplete) {
        otherConn.onSend(otherId, data);
      }
    }
  }

  startConnection(connectionId: string): void {
    // In relay mode, we don't need to start a packet transmission loop
    // Clients send packets when they want, we just forward them
    Logger.info(`RelayMode: Connection ${connectionId} ready to relay`);
  }

  stopConnection(connectionId: string): void {
    Logger.info(`RelayMode: Stopped connection ${connectionId}`);
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
    Logger.info(`RelayMode: Removed connection ${connectionId}`);
  }

  isConnectionInitialized(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    return connection?.initialized || false;
  }

  markJoinHandshakeComplete(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.handshakeComplete = true;
      Logger.info(`RelayMode: Handshake complete for ${connectionId}`);
    }
  }

  getMode(): NetworkMode {
    return NetworkMode.CLIENT_RELAY;
  }

  /**
   * Broadcast a message to all connections (for join ack, etc.)
   */
  broadcastToAll(data: Uint8Array, excludeConnectionId?: string): void {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connectionId !== excludeConnectionId && connection.handshakeComplete) {
        connection.onSend(connectionId, data);
      }
    }
  }

  /**
   * Send to a specific connection
   */
  sendTo(connectionId: string, data: Uint8Array): void {
    const connection = this.connections.get(connectionId);
    if (connection && connection.handshakeComplete) {
      connection.onSend(connectionId, data);
    }
  }
}
