/**
 * FastAPI WebSocket Adapter
 * Simple JSON-based WebSocket adapter for FastAPI server
 */

import { INetworkAdapter } from './INetworkAdapter.js';
import { WebSocketConnection } from './WebSocketConnection.js';
import Logger from '../Logger.js';

const logger = new Logger('FastAPIAdapter');

export class FastAPIAdapter implements INetworkAdapter {
  private wsConnection: WebSocketConnection | null = null;
  private messageCallback: ((data: any) => void) | null = null;
  private binaryMessageCallback: ((data: Uint8Array) => void) | null = null;
  private connectCallback: (() => void) | null = null;
  private disconnectCallback: (() => void) | null = null;
  private errorCallback: ((error: Error) => void) | null = null;
  private localPlayerId: string = '';
  private players: Map<string, any> = new Map();
  private hasLoggedConnectionError: boolean = false;

  constructor() {
    // Initialize playerId
    this.localPlayerId = `player_${Math.random().toString(36).substr(2, 9)}`;
  }

  getPlayerId(): string {
    return this.localPlayerId;
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wsConnection = new WebSocketConnection({
          url,
          onConnect: async () => {
            Logger.info('FastAPIAdapter connected');
            this.hasLoggedConnectionError = false;
            
            // Send playerId to server
            if (this.wsConnection) {
              await this.wsConnection.send(JSON.stringify({
                playerId: this.localPlayerId
              }));
            }
            
            this.connectCallback?.();
            resolve();
          },
          onDisconnect: () => {
            Logger.info('FastAPIAdapter disconnected');
            this.disconnectCallback?.();
          },
          onError: (error: Error) => {
            if (!this.hasLoggedConnectionError) {
              Logger.error('FastAPIAdapter error', error);
              this.hasLoggedConnectionError = true;
            }
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
    return this.wsConnection !== null;
  }

  disconnect(): void {
    if (this.wsConnection) {
      this.wsConnection.disconnect();
      this.wsConnection = null;
    }
  }

  send(data: any): void {
    if (this.wsConnection) {
      this.wsConnection.send(JSON.stringify(data));
    }
  }

  sendBinary(data: Uint8Array): void {
    // FastAPI server uses JSON, ignore binary
    Logger.warn('sendBinary called on FastAPI adapter (JSON-only)');
  }

  private handleMessage(data: any): void {
    if (this.messageCallback) {
      this.messageCallback(data);
    }
  }

  private handleBinaryMessage(data: Uint8Array): void {
    if (this.binaryMessageCallback) {
      this.binaryMessageCallback(data);
    }
  }

  // Player management for remote players
  getPlayers(): Map<string, any> {
    return this.players;
  }

  updateLocalPlayer(position: any, rotation: any, velocity: any): void {
    // Send position update to server
    this.send({
      type: 'position',
      position,
      rotation,
      velocity
    });
  }

  sendShot(targetId: string | null): void {
    this.send({
      type: 'shot',
      targetId
    });
  }
}
