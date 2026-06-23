/**
 * Tribes2Networking - Server-side integration of new Tribes2-style networking
 * Bridges between existing Server/MessageHandler and new StreamManager system
 */

import { StreamManager } from './StreamManager.js';
import { EventManager, Event, PositionEvent, ShotEvent } from './EventManager.js';
import { GhostManager, ScopeManager } from './GhostManager.js';
import { MoveManager } from './MoveManager.js';
import { BitStream } from './BitStream.js';
import { Logger } from './Logger.js';

export class Tribes2Networking {
  private streamManagers: Map<string, StreamManager> = new Map();
  private eventManagers: Map<string, EventManager> = new Map();
  private ghostManagers: Map<string, GhostManager> = new Map();
  private moveManagers: Map<string, MoveManager> = new Map();
  private scopeManagers: Map<string, ScopeManager> = new Map();
  private onEventCallback: ((connectionId: string, event: any) => void) | null = null;
  private onMoveCallback: ((connectionId: string, move: any) => void) | null = null;

  constructor() {
    // Empty constructor
  }

  /**
   * Initialize networking for a connection
   */
  initializeConnection(connectionId: string, onSend: (connectionId: string, data: Uint8Array) => void): void {
    const scopeManager = new ScopeManager();
    const ghostManager = new GhostManager(scopeManager);
    const moveManager = new MoveManager();
    const eventManager = new EventManager();

    const streamManager = new StreamManager(
      eventManager,
      ghostManager,
      moveManager,
      {
        maxPacketSize: 1400,
        packetsPerSecond: 30,
        maxBytesPerSecond: 42000
      },
      onSend
    );

    this.scopeManagers.set(connectionId, scopeManager);
    this.ghostManagers.set(connectionId, ghostManager);
    this.moveManagers.set(connectionId, moveManager);
    this.eventManagers.set(connectionId, eventManager);
    this.streamManagers.set(connectionId, streamManager);

    streamManager.startConnection(connectionId);
    Logger.info(`Initialized Tribes2 networking for connection: ${connectionId}`);
  }

  /**
   * Handle incoming packet from a connection
   */
  handlePacket(connectionId: string, data: Uint8Array): void {
    const streamManager = this.streamManagers.get(connectionId);
    if (streamManager) {
      streamManager.handlePacket(connectionId, data);
    }
  }

  /**
   * Send position update for a connection
   */
  sendPosition(connectionId: string, playerId: string, position: any, rotation: any): void {
    const eventManager = this.eventManagers.get(connectionId);
    if (eventManager) {
      const event = new PositionEvent(playerId, position, rotation, Date.now());
      eventManager.sendEvent(connectionId, event);
    }
  }

  /**
   * Send shot event for a connection
   */
  sendShot(connectionId: string, playerId: string, targetId: string | null): void {
    const eventManager = this.eventManagers.get(connectionId);
    if (eventManager) {
      const event = new ShotEvent(playerId, targetId, Date.now());
      eventManager.sendEvent(connectionId, event);
    }
  }

  /**
   * Set callback for events from clients
   */
  onEvent(callback: (connectionId: string, event: Event) => void): void {
    this.onEventCallback = callback;
  }

  /**
   * Set callback for moves from clients
   */
  onMove(callback: (connectionId: string, move: any) => void): void {
    this.onMoveCallback = callback;
  }

  /**
   * Update ghost for a connection
   */
  updateGhost(connectionId: string, ghost: any): void {
    const ghostManager = this.ghostManagers.get(connectionId);
    if (ghostManager) {
      ghostManager.updateGhost(connectionId, ghost);
    }
  }

  /**
   * Remove a connection
   */
  removeConnection(connectionId: string): void {
    const streamManager = this.streamManagers.get(connectionId);
    if (streamManager) {
      streamManager.removeConnection(connectionId);
    }

    this.streamManagers.delete(connectionId);
    this.eventManagers.delete(connectionId);
    this.ghostManagers.delete(connectionId);
    this.moveManagers.delete(connectionId);
    this.scopeManagers.delete(connectionId);

    Logger.info(`Removed Tribes2 networking for connection: ${connectionId}`);
  }

  /**
   * Get statistics for a connection
   */
  getStats(connectionId: string): any {
    const streamManager = this.streamManagers.get(connectionId);
    if (streamManager) {
      return streamManager.getStats(connectionId);
    }
    return null;
  }
}
