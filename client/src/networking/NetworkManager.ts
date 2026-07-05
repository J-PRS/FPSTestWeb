import { INetworkAdapter } from './INetworkAdapter.js';
import { ChildLogger } from '../Logger.js';

const logger = new ChildLogger('NetworkManager');

export interface RemotePlayerState {
  id: string;
  internalId: string;
  position: { x: number; y: number; z: number };
  rotation: { yaw: number; pitch: number };
  velocity: { x: number; y: number; z: number };
  isDead: boolean;
  health: number;
}

/**
 * Network manager using dependency injection
 * Supports swapping between different networking backends (ws, Colyseus, Naia)
 */
export class NetworkManager {
  private adapter: INetworkAdapter | null = null;
  private localPlayerId: string;
  private connected: boolean = false;
  /** REMOTE players only — local player is never stored here */
  private players: Map<string, RemotePlayerState> = new Map();
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number, health: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onKnockback: ((position: { x: number; y: number; z: number }, force: number, pull?: boolean) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number, velocity?: { x: number; y: number; z: number }) => void) | null = null;
  public onGameState: ((players: any[], localPlayerState: any) => void) | null = null;
  public onSnapshot: ((players: any[], timestamp: number) => void) | null = null;
  public onStateHash: ((hash: string, tick: number, playerCount: number, timestamp: number) => void) | null = null;
  private lastPositionSendTime: number = 0;
  private readonly POSITION_SEND_INTERVAL = 50; // 20Hz — extrapolation covers the gap
  private ping: number = 0;
  private hasLoggedConnectionError: boolean = false;

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
      } else if ('getPlayerId' in this.adapter) {
        this.localPlayerId = (this.adapter as any).getPlayerId();
      } else {
        this.localPlayerId = 'unknown';
      }

      logger.info(`Connected via adapter: ${this.localPlayerId}`);
      this.hasLoggedConnectionError = false;
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
      this.hasLoggedConnectionError = false;
    });

    this.adapter.onDisconnect(() => {
      logger.info('Adapter disconnected');
      this.connected = false;
    });

    this.adapter.onError((error) => {
      if (!this.hasLoggedConnectionError) {
        logger.error('Adapter error', error);
        this.hasLoggedConnectionError = true;
      }
    });
  }

  private handleMessage(data: any): void {
    // Avoid JSON.stringify on every message — tickUpdate arrives at 20Hz
    switch (data.type) {
      case 'gameState':
        // Store REMOTE players only (local player state comes via localPlayerState)
        if (data.players && Array.isArray(data.players)) {
          for (const player of data.players) {
            if (player.id === this.localPlayerId) continue;
            this.players.set(player.id, player);
          }
        }
        if (this.onGameState) {
          this.onGameState(data.players || [], data.localPlayerState);
        }
        break;

      case 'tickUpdate':
        // Batched player updates from server (delta compressed)
        if (data.updates && Array.isArray(data.updates)) {
          const now = Date.now();
          for (const u of data.updates) {
            // Defense-in-depth: server already excludes self from tickUpdate,
            // but skip local player here too in case of any server-side regression
            if (u.playerId === this.localPlayerId) continue;
            const existing = this.players.get(u.playerId);
            this.players.set(u.playerId, {
              ...existing,
              id: u.playerId,
              internalId: u.internalId || existing?.internalId || '',
              position: u.position,
              rotation: u.rotation || { yaw: 0, pitch: 0 },
              velocity: u.velocity || { x: 0, y: 0, z: 0 },
              isDead: u.isDead || false,
              health: u.health !== undefined ? u.health : (existing?.health ?? 100),
            });
            if (this.onPlayerUpdate) {
              this.onPlayerUpdate(u.playerId, u.position, u.rotation, now, u.velocity);
            }
          }
        }
        break;

      case 'playerJoined':
        // Add REMOTE player to storage (server excludes self, but guard anyway)
        if (data.playerId && data.playerId !== this.localPlayerId) {
          this.players.set(data.playerId, {
            id: data.playerId,
            internalId: data.internalId,
            position: data.position || { x: 0, y: 500, z: 0 },
            rotation: data.rotation || { yaw: 0, pitch: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            health: 100,
            isDead: false
          });
        }
        if (this.onPlayerJoined) {
          this.onPlayerJoined(data.playerId, data.position, data.rotation);
        }
        break;

      case 'playerLeft':
        // Remove player from storage
        if (data.playerId) {
          this.players.delete(data.playerId);
        }
        if (this.onPlayerLeft) {
          this.onPlayerLeft(data.playerId);
        }
        break;

      case 'playerRespawn':
        // Update REMOTE player in storage (local player respawn handled by callback)
        if (data.playerId && data.position && data.playerId !== this.localPlayerId) {
          const existing = this.players.get(data.playerId);
          this.players.set(data.playerId, {
            ...existing,
            id: data.playerId,
            internalId: existing?.internalId || '',
            position: data.position,
            rotation: data.rotation || { yaw: 0, pitch: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            health: 100,
            isDead: false
          });
        }
        if (this.onPlayerRespawn) {
          this.onPlayerRespawn(data.playerId, data.position, data.rotation);
        }
        break;

      case 'playerHit':
        // Update REMOTE player health in storage (local player health handled by callback)
        if (data.targetId && data.targetId !== this.localPlayerId) {
          const existing = this.players.get(data.targetId);
          this.players.set(data.targetId, {
            ...existing,
            id: data.targetId,
            internalId: existing?.internalId || '',
            position: existing?.position || { x: 0, y: 0, z: 0 },
            rotation: existing?.rotation || { yaw: 0, pitch: 0 },
            velocity: existing?.velocity || { x: 0, y: 0, z: 0 },
            isDead: existing?.isDead || false,
            health: data.health !== undefined ? data.health : (existing?.health ?? 100),
          });
        }
        if (this.onPlayerHit) {
          this.onPlayerHit(data.shooterId, data.targetId, data.damage, data.health);
        }
        break;

      case 'playerKill':
        // Update REMOTE player state (local player death handled by callback)
        if (data.targetId && data.targetId !== this.localPlayerId) {
          const existing = this.players.get(data.targetId);
          this.players.set(data.targetId, {
            ...existing,
            id: data.targetId,
            internalId: existing?.internalId || '',
            position: existing?.position || { x: 0, y: 0, z: 0 },
            rotation: existing?.rotation || { yaw: 0, pitch: 0 },
            velocity: existing?.velocity || { x: 0, y: 0, z: 0 },
            isDead: true,
            health: 0,
          });
        }
        if (this.onPlayerKill) {
          this.onPlayerKill(data.shooterId, data.targetId);
        }
        break;

      case 'knockback':
        if (this.onKnockback) {
          this.onKnockback(data.position, data.force, data.pull);
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

      case 'projectileDestroyed':
        if (this.onProjectileDestroyed) {
          this.onProjectileDestroyed(data.projectileId);
        }
        break;

      case 'snapshot':
        if (this.onSnapshot) {
          this.onSnapshot(data.players || [], data.timestamp || Date.now());
        }
        break;

      case 'stateHash':
        if (this.onStateHash) {
          this.onStateHash(data.hash, data.tick, data.playerCount, data.timestamp);
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
   * Compatible with both Tribes2 and FastAPI backends
   */
  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }): void {
    if (!this.adapter || !this.adapter.isConnected()) return;

    const now = Date.now();

    // Rate limiting
    if (now - this.lastPositionSendTime < this.POSITION_SEND_INTERVAL) {
      return;
    }

    this.lastPositionSendTime = now;

    // Send position update with real velocity
    this.adapter.send({
      type: 'position',
      position,
      rotation,
      velocity
    });
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
   * Get all REMOTE players (local player is never included)
   */
  getPlayers(): Map<string, any> {
    return this.players;
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

  sendAOEShot(position: { x: number; y: number; z: number }, excludeTargetId?: string | null): void {
    if (!this.adapter || !this.adapter.isConnected()) return;

    this.adapter.send({
      type: 'aoeShot',
      position,
      excludeTargetId: excludeTargetId ?? null,
    });
  }

  sendDiscAOEShot(position: { x: number; y: number; z: number }, excludeTargetId?: string | null): void {
    if (!this.adapter || !this.adapter.isConnected()) return;

    this.adapter.send({
      type: 'discAOEShot',
      position,
      excludeTargetId: excludeTargetId ?? null,
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
   * Request a full state snapshot from the server
   */
  sendSnapshotRequest(): void {
    if (!this.adapter || !this.adapter.isConnected()) return;
    
    this.adapter.send({ type: 'snapshotRequest' });
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
