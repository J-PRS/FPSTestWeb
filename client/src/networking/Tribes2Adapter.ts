/**
 * Tribes2Adapter - Implements INetworkAdapter using new Tribes2-style networking
 * Bridges between existing NetworkManager interface and new StreamManager system
 */

import { INetworkAdapter } from './INetworkAdapter.js';
import { ChildLogger } from '../Logger.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import { StreamManager } from './StreamManager.js';
import { EventManager, Event, PositionEvent, ShotEvent } from './EventManager.js';
import { GhostManager, ScopeManager } from './GhostManager.js';
import { MoveManager } from './MoveManager.js';

const logger = new ChildLogger('Tribes2Adapter');

export class Tribes2Adapter implements INetworkAdapter {
  private wsConnection: WebSocketConnection | null = null;
  private streamManager: StreamManager | null = null;
  private eventManager: EventManager;
  private ghostManager: GhostManager;
  private moveManager: MoveManager;
  private scopeManager: ScopeManager;
  private messageCallback: ((data: any) => void) | null = null;
  private binaryMessageCallback: ((data: Uint8Array) => void) | null = null;
  private connectCallback: (() => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;
  private localPlayerId: string = '';

  constructor() {
    this.scopeManager = new ScopeManager();
    this.ghostManager = new GhostManager(this.scopeManager);
    this.moveManager = new MoveManager();
    this.eventManager = new EventManager();
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wsConnection = new WebSocketConnection({
          url,
          onConnect: () => {
            logger.info('Tribes2Adapter connected');
            
            // Send JSON join message first
            const joinMessage = JSON.stringify({
              type: 'join',
              playerId: this.localPlayerId || 'player_' + Math.random().toString(36).substr(2, 9)
            });
            this.wsConnection?.send(joinMessage);
            
            // Initialize StreamManager after join
            this.streamManager = new StreamManager(
              this.eventManager,
              this.ghostManager,
              this.moveManager,
              {
                maxPacketSize: 1400,
                packetsPerSecond: 30,
                maxBytesPerSecond: 42000
              },
              (data: Uint8Array) => {
                this.wsConnection?.send(data);
              }
            );
            
            // Don't start StreamManager yet - wait for join acknowledgment
            this.connectCallback?.();
            resolve();
          },
          onDisconnect: () => {
            logger.info('Tribes2Adapter disconnected');
            this.streamManager?.stop();
            this.disconnectCallback?.();
          },
          onError: (error: Error) => {
            logger.error('Tribes2Adapter error', error);
            this.errorCallback?.(error);
            reject(error);
          },
          onMessage: (data: any) => {
            this.handleMessage(data);
          }
        });

        this.wsConnection.connect(url);
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.streamManager?.stop();
    this.wsConnection?.disconnect();
  }

  send(data: any): void {
    if (!this.streamManager) return;

    // Convert existing message format to new event system
    switch (data.type) {
      case 'move':
        this.sendPosition(data);
        break;
      case 'shot':
        this.sendShot(data);
        break;
      case 'jump':
        this.sendJump(data);
        break;
      case 'jetpack':
        this.sendJetpack(data);
        break;
      case 'input':
        this.sendInput(data);
        break;
      default:
        logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  sendBinary(data: Uint8Array): void {
    if (this.wsConnection) {
      this.wsConnection.send(data);
    }
  }

  private sendPosition(data: any): void {
    // Position updates are sent via MoveManager as part of input
    // The actual position is sent with the move for client-side prediction
    if (this.streamManager) {
      // For now, send as a guaranteed event
      const event = new PositionEvent(
        this.localPlayerId,
        { x: data.x, y: data.y, z: data.z },
        { yaw: data.yaw, pitch: data.pitch },
        Date.now(),
        (playerId, position, rotation) => {
          // Callback for position updates from server
          if (this.messageCallback) {
            this.messageCallback({
              type: 'position',
              playerId,
              position,
              rotation
            });
          }
        }
      );
      this.eventManager.sendEvent(event);
    }
  }

  private sendShot(data: any): void {
    // Send shot as guaranteed event
    const event = new ShotEvent(
      this.localPlayerId,
      data.targetId || null,
      Date.now(),
      (playerId, targetId) => {
        // Callback for shot confirmation from server
        if (this.messageCallback) {
          this.messageCallback({
            type: 'shot',
            playerId,
            targetId
          });
        }
      }
    );
    this.eventManager.sendEvent(event);
  }

  private sendJump(data: any): void {
    // Send as move event with jump flag
    this.moveManager.collectMove(
      { forward: 0, right: 0, jump: 1, ski: 0 },
      { yaw: 0, pitch: 0 }
    );
  }

  private sendJetpack(data: any): void {
    // Send as move event with ski flag
    this.moveManager.collectMove(
      { forward: 0, right: 0, jump: 0, ski: 1 },
      { yaw: 0, pitch: 0 }
    );
  }

  private sendInput(data: any): void {
    // Collect move with actual input data
    this.moveManager.collectMove(
      {
        forward: data.input.forward || 0,
        right: data.input.right || 0,
        jump: data.input.jump ? 1 : 0,
        ski: data.input.ski ? 1 : 0
      },
      {
        yaw: data.input.yaw || 0,
        pitch: data.input.pitch || 0
      }
    );
  }

  private handleMessage(data: any): void {
    // Handle join acknowledgment
    if (data.type === 'joinAck') {
      logger.info('Received join acknowledgment, starting StreamManager');
      this.streamManager?.start();
      return;
    }

    // Handle other messages from server
    if (this.messageCallback) {
      this.messageCallback(data);
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
    return this.wsConnection?.connected() || false;
  }

  setPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  getSessionId(): string {
    return this.localPlayerId;
  }
}
