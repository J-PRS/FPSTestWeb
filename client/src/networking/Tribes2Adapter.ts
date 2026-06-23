/**
 * Tribes2Adapter - Implements INetworkAdapter using new Tribes2-style networking
 * Bridges between existing NetworkManager interface and new StreamManager system
 */

import { INetworkAdapter } from './INetworkAdapter.js';
import { ChildLogger } from '../Logger.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import { StreamManager } from './StreamManager.js';
import { EventManager, Event, PositionEvent, ShotEvent, JumpEvent, JetpackEvent } from './EventManager.js';
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
  private controlObject: any = null; // For client-side prediction
  private joinHandshakeComplete: boolean = false; // Track join handshake state

  constructor() {
    this.scopeManager = new ScopeManager();
    this.ghostManager = new GhostManager(this.scopeManager);
    this.moveManager = new MoveManager();
    this.eventManager = new EventManager();
    
    // Set up reconciliation callback for client-side prediction
    this.moveManager.onReconcile((serverState: any, lastProcessedSequence: number) => {
      this.handleReconciliation(serverState, lastProcessedSequence);
    });
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wsConnection = new WebSocketConnection({
          url,
          onConnect: () => {
            logger.info('Tribes2Adapter connected');
            
            // Send JSON join message FIRST - before initializing StreamManager
            const joinMessage = JSON.stringify({
              type: 'join',
              playerId: this.localPlayerId || 'player_' + Math.random().toString(36).substr(2, 9)
            });
            this.wsConnection?.send(joinMessage);
            
            // Initialize StreamManager after join (but don't start it yet)
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
                // Only send binary data if join handshake is complete
                if (this.joinHandshakeComplete) {
                  this.wsConnection?.send(data);
                }
              }
            );
            
            // Don't start StreamManager yet - wait for join acknowledgment
            this.connectCallback?.();
            resolve();
          },
          onDisconnect: () => {
            logger.info('Tribes2Adapter disconnected');
            this.streamManager?.stop();
            this.joinHandshakeComplete = false;
            this.disconnectCallback?.();
          },
          onError: (error: Error) => {
            logger.error('Tribes2Adapter error', error);
            this.errorCallback?.(error);
            reject(error);
          },
          onMessage: (data: any) => {
            this.handleMessage(data);
          },
          onBinaryMessage: (data: Uint8Array) => {
            this.handleBinaryMessage(data);
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
      case 'inputMove':
        this.sendInputMove(data);
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
    // GhostManager handles position synchronization, so we don't need to send PositionEvent
    // This method is kept for compatibility with NetworkManager interface
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
    // Send as JumpEvent through EventManager
    const event = new JumpEvent(
      this.localPlayerId,
      Date.now(),
      (playerId) => {
        if (this.messageCallback) {
          this.messageCallback({ type: 'jump', playerId, position: data.position });
        }
      }
    );
    this.eventManager.sendEvent(event);
  }

  private sendJetpack(data: any): void {
    // Send as JetpackEvent through EventManager
    const event = new JetpackEvent(
      this.localPlayerId,
      true, // active
      Date.now(),
      (playerId, active) => {
        if (this.messageCallback) {
          this.messageCallback({ type: 'jetpack', playerId, position: data.position, active });
        }
      }
    );
    this.eventManager.sendEvent(event);
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

  private sendInputMove(data: any): void {
    // Collect move with actual input data for client-side prediction
    this.moveManager.collectMove(
      {
        forward: data.input.forward || 0,
        right: data.input.right || 0,
        jump: data.input.jump || 0,
        ski: data.input.ski || 0
      },
      {
        yaw: data.rotation.yaw || 0,
        pitch: data.rotation.pitch || 0
      }
    );
  }

  private handleMessage(data: any): void {
    // Handle join acknowledgment
    if (data.type === 'joinAck') {
      logger.info('Received join acknowledgment, starting StreamManager');
      this.joinHandshakeComplete = true;
      this.streamManager?.start();
      return;
    }

    // Handle game state with existing players
    if (data.type === 'gameState') {
      logger.info(`Received gameState with ${data.players?.length || 0} other players`);
      // Forward to message callback for player rendering
      if (this.messageCallback) {
        this.messageCallback(data);
      }
      return;
    }

    // Handle state reconciliation from server
    if (data.type === 'stateReconciliation') {
      logger.info('Received state reconciliation from server');
      this.moveManager.reconcile(
        data.lastProcessedSequence,
        {
          position: data.position,
          rotation: data.rotation,
          velocity: data.velocity
        },
        this.controlObject
      );
      return;
    }

    // Handle other messages from server
    if (this.messageCallback) {
      this.messageCallback(data);
    }
  }

  private handleBinaryMessage(data: Uint8Array): void {
    // Route binary Tribes2 packets to StreamManager
    logger.debug(`Received binary packet, size: ${data.length} bytes`);
    if (this.streamManager) {
      this.streamManager.handlePacket(data);
    } else {
      logger.warn('Received binary packet but StreamManager not initialized');
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

  setControlObject(controlObject: any): void {
    this.controlObject = controlObject;
  }

  /**
   * Handle server state reconciliation for client-side prediction
   */
  private handleReconciliation(serverState: any, lastProcessedSequence: number): void {
    if (!this.controlObject || !this.controlObject.movement) {
      return;
    }

    logger.debug(`State reconciliation: pos(${serverState.position.x.toFixed(1)},${serverState.position.y.toFixed(1)},${serverState.position.z.toFixed(1)}) seq=${lastProcessedSequence}`);

    // Snap to server position first
    this.controlObject.pos.set(serverState.position.x, serverState.position.y, serverState.position.z);
    this.controlObject.vel.set(serverState.velocity.x, serverState.velocity.y, serverState.velocity.z);
    this.controlObject.yaw = serverState.rotation.yaw;
    this.controlObject.pitch = serverState.rotation.pitch;

    // Replay unprocessed inputs from lastProcessedSequence to current
    const moveHistory = this.moveManager.getMoveHistory();
    const unprocessedMoves = moveHistory.filter(m => m.sequence > lastProcessedSequence);
    
    if (unprocessedMoves.length > 0) {
      logger.debug(`Replaying ${unprocessedMoves.length} unprocessed moves for smooth reconciliation`);
      // Replay moves at 15Hz tick rate (67ms per tick)
      const dt = 0.067;
      for (const move of unprocessedMoves) {
        // Apply input to player movement controller for proper replay
        const movementInput = {
          forward: move.input.forward,
          right: move.input.right,
          jump: move.input.jump === 1,
          ski: move.input.ski === 1
        };
        this.controlObject.movement.setInput(movementInput);
        this.controlObject.movement.update(dt);
        logger.debug(`Replaying move seq=${move.sequence} pos=${this.controlObject.pos.x.toFixed(1)},${this.controlObject.pos.y.toFixed(1)},${this.controlObject.pos.z.toFixed(1)}`);
      }
    }
  }

  getSessionId(): string {
    return this.localPlayerId;
  }
}
