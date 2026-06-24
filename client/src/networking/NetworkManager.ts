import { INetworkAdapter } from './INetworkAdapter.js';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('NetworkManager');

/**
 * Network manager using dependency injection
 * Supports swapping between different networking backends (ws, Colyseus, Naia)
 */
export class NetworkManager {
  private adapter: INetworkAdapter | null = null;
  private localPlayerId: string;
  private connected: boolean = false;
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onStateRestore: ((state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, health: number, isDead: boolean }) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileUpdate: ((projectileId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onShot: ((playerId: string, targetId: string | null) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => void) | null = null;
  public onGameState: ((players: any[], localPlayerState: any) => void) | null = null;
  public onStateReconciliation: ((state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => void) | null = null;
  private lastPositionSendTime: number = 0;
  private readonly POSITION_SEND_INTERVAL = 67; // 15Hz = 67ms
  private lastSentPosition: { x: number; y: number; z: number } | null = null;
  private lastSentRotation: { yaw: number; pitch: number } | null = null;
  private ping: number = 0;

  constructor(adapter: INetworkAdapter) {
    this.adapter = adapter;
    this.localPlayerId = '';
    this.setupAdapterCallbacks();
  }

  setPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  /**
   * Set the control object for client-side prediction
   * This object should have applyMove and state properties
   */
  setControlObject(controlObject: any): void {
    if (this.adapter && 'setControlObject' in this.adapter) {
      (this.adapter as any).setControlObject(controlObject);
    }
  }

  async connect(url: string): Promise<void> {
    if (!this.adapter) {
      throw new Error('Network adapter not set');
    }

    try {
      await this.adapter.connect(url);
      this.connected = true;
      
      // Try to get session ID from adapter if available
      if ('getSessionId' in this.adapter) {
        this.localPlayerId = (this.adapter as any).getSessionId();
      } else {
        this.localPlayerId = 'unknown';
      }

      logger.info(`Connected via adapter: ${this.localPlayerId}`);
    } catch (error) {
      logger.error('Connection error', error);
      throw error;
    }
  }

  disconnect(): void {
    if (this.adapter) {
      this.adapter.disconnect();
    }
    this.connected = false;
  }

  private setupAdapterCallbacks(): void {
    if (!this.adapter) return;

    this.adapter.onMessage((data) => {
      this.handleMessage(data);
    });

    this.adapter.onBinaryMessage((data) => {
      this.handleBinaryMessage(data);
    });

    this.adapter.onConnect(() => {
      logger.info('Adapter connected');
    });

    this.adapter.onDisconnect(() => {
      logger.info('Adapter disconnected');
      this.connected = false;
    });

    this.adapter.onError((error) => {
      logger.error('Adapter error', error);
    });
  }

  private handleMessage(data: any): void {
    // Handle messages from the adapter
    logger.debug(`Received message: ${JSON.stringify(data)}`);

    switch (data.type) {
      case 'gameState':
        if (this.onGameState) {
          this.onGameState(data.players || [], data.localPlayerState);
        }
        break;

      case 'position':
        if (this.onPlayerUpdate) {
          this.onPlayerUpdate(data.playerId, data.position, data.rotation, Date.now());
        }
        break;

      case 'playerJoined':
        if (this.onPlayerJoined) {
          this.onPlayerJoined(data.playerId, data.position, data.rotation);
        }
        break;

      case 'playerLeft':
        if (this.onPlayerLeft) {
          this.onPlayerLeft(data.playerId);
        }
        break;

      case 'playerRespawn':
        if (this.onPlayerRespawn) {
          this.onPlayerRespawn(data.playerId, data.position, data.rotation);
        }
        break;

      case 'playerHit':
        if (this.onPlayerHit) {
          this.onPlayerHit(data.shooterId, data.targetId, data.damage);
        }
        break;

      case 'playerKill':
        if (this.onPlayerKill) {
          this.onPlayerKill(data.shooterId, data.targetId);
        }
        break;

      case 'shot':
        if (this.onShot) {
          this.onShot(data.playerId, data.targetId);
        }
        break;

      case 'jump':
        if (this.onPlayerJump) {
          this.onPlayerJump(data.playerId, data.position);
        }
        break;

      case 'jetpack':
        if (this.onPlayerJetpack) {
          this.onPlayerJetpack(data.playerId, data.position);
        }
        break;

      case 'projectileCreated':
        if (this.onProjectileCreated) {
          this.onProjectileCreated(data.projectileId, data.ownerId, data.position, data.velocity);
        }
        break;

      case 'projectileUpdate':
        if (this.onProjectileUpdate) {
          this.onProjectileUpdate(data.projectileId, data.position);
        }
        break;

      case 'projectileDestroyed':
        if (this.onProjectileDestroyed) {
          this.onProjectileDestroyed(data.projectileId);
        }
        break;

      default:
        logger.warn(`Unknown message type: ${data.type}`);
    }
  }

  private handleBinaryMessage(data: Uint8Array): void {
    // Handle binary messages from the adapter
    // This will be implemented based on the protocol used by the specific backend
    logger.debug(`Received binary message: ${data.length} bytes`);
  }

  /**
   * Send player position to server with rate limiting
   * For Tribes2 backend, this sends input moves for client-side prediction
   */
  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    const now = Date.now();
    
    // Rate limiting
    if (now - this.lastPositionSendTime < this.POSITION_SEND_INTERVAL) {
      return;
    }
    
    this.lastPositionSendTime = now;
    
    // For Tribes2 backend, send input moves instead of position
    // The adapter will handle the conversion
    this.adapter.send({
      type: 'move',
      x: position.x,
      y: position.y,
      z: position.z,
      yaw: rotation.yaw,
      pitch: rotation.pitch
    });
    
    this.lastSentPosition = { ...position };
    this.lastSentRotation = { ...rotation };
  }

  /**
   * Send input move for client-side prediction
   */
  sendInputMove(input: { forward: number; right: number; jump: number; ski: number }, rotation: { yaw: number; pitch: number }): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({
      type: 'inputMove',
      input,
      rotation
    });
  }

  /**
   * Send shot event to server
   */
  sendShot(targetId: string | null, position?: { x: number; y: number; z: number }, velocity?: { x: number; y: number; z: number }, timestamp?: number, projectileId?: string | null): void {
    if (!this.adapter || !this.adapter.isConnected()) return;

    this.adapter.send({
      type: 'shot',
      targetId,
      position,
      velocity,
      timestamp,
      projectileId
    });
  }

  /**
   * Send jump event to server
   */
  sendJump(position: { x: number; y: number; z: number }): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({
      type: 'jump',
      position
    });
  }

  /**
   * Send jetpack event to server
   */
  sendJetpack(position: { x: number; y: number; z: number }): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({
      type: 'jetpack',
      position
    });
  }

  /**
   * Send projectile destroy event to server
   */
  sendProjectileDestroy(projectileId: string): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({
      type: 'projectileDestroy',
      projectileId
    });
  }

  /**
   * Send input
   */
  sendInput(input: any): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({
      type: 'input',
      input
    });
  }

  /**
   * Get all players (not applicable with Colyseus state sync)
   */
  getPlayers(): Map<string, any> {
    // Colyseus manages state automatically
    return new Map();
  }

  /**
   * Get local player ID
   */
  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.adapter !== null && this.adapter.isConnected();
  }

  getPing(): number {
    return this.ping;
  }

  getPacketLoss(): number {
    return 0; // Not implemented yet
  }

  getJitter(): number {
    return 0; // Not implemented yet
  }
}
