/**
 * ServerAuthoritativeHandler - Wraps existing Tribes2Networking logic
 * Server validates moves, simulates game state, sends authoritative positions
 */

import { BitStream } from './BitStream.js';
import { NetworkModeHandler } from './NetworkModeHandler.js';
import { NetworkMode } from './config.js';
import { Tribes2Networking } from './Tribes2Networking.js';
import { Logger } from './Logger.js';

export class ServerAuthoritativeHandler implements NetworkModeHandler {
  private tribes2Networking: Tribes2Networking;

  constructor(
    private onEventCallback?: (connectionId: string, event: any) => void,
    private onMoveCallback?: (connectionId: string, move: any) => void,
    private getControlObjectCallback?: (connectionId: string) => any
  ) {
    this.tribes2Networking = new Tribes2Networking();
  }

  initializeConnection(connectionId: string, onSend: (connectionId: string, data: Uint8Array) => void): void {
    // Wire callbacks before initializing
    if (this.onEventCallback) {
      this.tribes2Networking.onEvent(this.onEventCallback);
    }
    if (this.onMoveCallback) {
      this.tribes2Networking.onMove(this.onMoveCallback);
    }

    // Set control object provider
    if (this.getControlObjectCallback) {
      this.tribes2Networking.setControlObjectProvider(this.getControlObjectCallback);
    }

    this.tribes2Networking.initializeConnection(connectionId, onSend);
  }

  handlePacket(connectionId: string, data: Uint8Array): void {
    this.tribes2Networking.handlePacket(connectionId, data);
  }

  startConnection(connectionId: string): void {
    // Connection is already started in initializeConnection via StreamManager
    // This is a no-op for Tribes2Networking
  }

  stopConnection(connectionId: string): void {
    // Tribes2Networking doesn't have a separate stopConnection
    // Use removeConnection to fully clean up
  }

  removeConnection(connectionId: string): void {
    this.tribes2Networking.removeConnection(connectionId);
  }

  isConnectionInitialized(connectionId: string): boolean {
    return this.tribes2Networking.isConnectionInitialized(connectionId);
  }

  markJoinHandshakeComplete(connectionId: string): void {
    this.tribes2Networking.markJoinHandshakeComplete(connectionId);
  }

  getMode(): NetworkMode {
    return NetworkMode.SERVER_AUTHORITATIVE;
  }

  /**
   * Send position update to a specific connection
   */
  sendPosition(connectionId: string, playerId: string, position: any, rotation: any): void {
    this.tribes2Networking.sendPosition(connectionId, playerId, position, rotation);
  }

  /**
   * Send shot event to a specific connection
   */
  sendShot(connectionId: string, playerId: string, targetId: string | null): void {
    this.tribes2Networking.sendShot(connectionId, playerId, targetId);
  }

  /**
   * Set control object provider
   */
  setControlObjectProvider(callback: (connectionId: string) => any): void {
    this.tribes2Networking.setControlObjectProvider(callback);
  }

  /**
   * Set callback for events from clients
   */
  onEvent(callback: (connectionId: string, event: any) => void): void {
    this.tribes2Networking.onEvent(callback);
  }

  /**
   * Set callback for moves from clients
   */
  onMove(callback: (connectionId: string, move: any) => void): void {
    this.tribes2Networking.onMove(callback);
  }
}
