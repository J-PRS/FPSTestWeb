import { INetworkAdapter, PlayerState, InputState } from './INetworkAdapter';
import { encodePosition, encodePositionDelta, encodeInput, encodeShot, decodeStateReconciliation } from './BinaryProtocol';

/**
 * Network manager with dependency injection
 * Handles all multiplayer networking logic with client-side prediction
 */
export class NetworkManager {
  private adapter: INetworkAdapter;
  private localPlayerId: string;
  private players: Map<string, PlayerState> = new Map();
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
  public onPlayerJoined: ((playerId: string) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => void) | null = null;
  public onGameState: ((players: PlayerState[], localPlayerState: any) => void) | null = null;
  public onStateReconciliation: ((state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => void) | null = null;
  private lastPositionSendTime: number = 0;
  private readonly POSITION_SEND_INTERVAL = 67; // 15Hz = 67ms
  private lastSentPosition: { x: number; y: number; z: number } | null = null;
  private lastSentRotation: { yaw: number; pitch: number } | null = null;
  private ping: number = 0;
  private lastPingTime: number = 0;
  private pingInterval: number | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: number | null = null;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_BASE_DELAY = 1000; // 1 second
  
  // Network quality monitoring (packet loss, jitter)
  private pingHistory: number[] = [];
  private readonly PING_HISTORY_SIZE = 20;
  private packetsSent: number = 0;
  private packetsReceived: number = 0;

  // Client-side prediction
  private inputSequence: number = 0;
  private inputHistory: Map<number, { input: any; timestamp: number }> = new Map();
  private readonly INPUT_HISTORY_SIZE = 64; // Store last 64 inputs for reconciliation

  constructor(adapter: INetworkAdapter) {
    this.adapter = adapter;
    this.localPlayerId = ''; // Will be set by worker/main thread
    this.setupEventHandlers();
  }

  setPlayerId(playerId: string): void {
    this.localPlayerId = playerId;
  }

  private setupEventHandlers(): void {
    this.adapter.onMessage((data) => this.handleMessage(data));
    this.adapter.onConnect(() => this.handleConnect());
    this.adapter.onDisconnect(() => this.handleDisconnect());
    this.adapter.onError((error) => this.handleError(error));
  }

  async connect(url: string): Promise<void> {
    await this.adapter.connect(url);
  }

  disconnect(): void {
    this.adapter.disconnect();
  }

  /**
   * Send player input to server (binary) with sequence number for prediction
   */
  sendInput(input: InputState): void {
    const sequence = this.inputSequence++;
    const timestamp = Date.now();
    
    // Store input for reconciliation
    this.inputHistory.set(sequence, { input, timestamp });
    
    // Keep history size bounded
    if (this.inputHistory.size > this.INPUT_HISTORY_SIZE) {
      const oldestKey = this.inputHistory.keys().next().value;
      if (oldestKey !== undefined) {
        this.inputHistory.delete(oldestKey);
      }
    }
    
    // Convert boolean input to numeric values for protocol
    const forwardNum = input.forward ? 1 : 0;
    const rightNum = input.right ? 1 : 0;
    
    // Send to server using binary protocol with input data
    const binary = encodeInput(
      this.localPlayerId, 
      sequence, 
      timestamp,
      { 
        forward: forwardNum, 
        right: rightNum, 
        jump: input.jump, 
        ski: false // ski not in InputState, will add later if needed
      }
    );
    this.adapter.sendBinary(binary);
  }

  /**
   * Send player position to server with rate limiting and delta compression
   */
  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
    const now = Date.now();
    
    // Rate limiting
    if (now - this.lastPositionSendTime < this.POSITION_SEND_INTERVAL) {
      return;
    }
    
    // Delta compression: skip if values haven't changed significantly
    const valuesChanged = !this.lastSentPosition || !this.lastSentRotation ||
      Math.abs(position.x - this.lastSentPosition.x) > 0.001 ||
      Math.abs(position.y - this.lastSentPosition.y) > 0.001 ||
      Math.abs(position.z - this.lastSentPosition.z) > 0.001 ||
      Math.abs(rotation.yaw - this.lastSentRotation.yaw) > 0.001 ||
      Math.abs(rotation.pitch - this.lastSentRotation.pitch) > 0.001;
    
    if (!valuesChanged) {
      return;
    }
    
    this.lastPositionSendTime = now;
    
    // Use delta compression if we have a previous position
    if (this.lastSentPosition && this.lastSentRotation) {
      const binary = encodePositionDelta(
        this.localPlayerId,
        position,
        rotation,
        this.lastSentPosition,
        this.lastSentRotation,
        now
      );
      this.adapter.sendBinary(binary);
    } else {
      // First position update, send full position
      const binary = encodePosition(this.localPlayerId, position, rotation, now);
      this.adapter.sendBinary(binary);
    }
    
    this.lastSentPosition = { ...position };
    this.lastSentRotation = { ...rotation };
  }

  /**
   * Send shot event to server (binary)
   */
  sendShot(targetId: string | null, position?: { x: number; y: number; z: number }, velocity?: { x: number; y: number; z: number }, timestamp?: number, projectileId?: string | null): void {
    const binary = encodeShot(this.localPlayerId, targetId, timestamp || Date.now(), position, velocity, projectileId);
    this.adapter.sendBinary(binary);
  }

  /**
   * Send jump event to server
   */
  sendJump(position: { x: number; y: number; z: number }): void {
    const message = {
      type: 'jump',
      playerId: this.localPlayerId,
      position
    };
    this.adapter.send(message);
  }

  /**
   * Send jetpack event to server
   */
  sendJetpack(position: { x: number; y: number; z: number }): void {
    const message = {
      type: 'jetpack',
      playerId: this.localPlayerId,
      position
    };
    this.adapter.send(message);
  }

  /**
   * Send projectile destroy event to server
   */
  sendProjectileDestroy(projectileId: string): void {
    const message = {
      type: 'projectileDestroy',
      playerId: this.localPlayerId,
      projectileId,
      timestamp: Date.now()
    };
    this.adapter.send(message);
  }

  /**
   * Get all players (including local)
   */
  getPlayers(): Map<string, PlayerState> {
    return this.players;
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
    return this.adapter.isConnected();
  }

  private handleConnect(): void {
    this.connected = true;
    this.reconnectAttempts = 0; // Reset reconnect attempts on successful connect
    
    // Send join message with persistent player ID
    const joinMessage = {
      type: 'join',
      playerId: this.localPlayerId
    };
    this.adapter.send(joinMessage);
    
    // Start ping measurement
    this.startPingMeasurement();
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.players.clear();
    this.stopPingMeasurement();
    
    // Attempt auto-reconnect
    this.attemptReconnect();
  }

  private handleError(error: Error): void {
    console.error('[NetworkManager] Network error:', error);
  }

  private startPingMeasurement(): void {
    // Clear existing interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Send ping every second
    this.pingInterval = self.setInterval(() => {
      if (this.connected) {
        this.lastPingTime = Date.now();
        const pingMessage = {
          type: 'ping',
          playerId: this.localPlayerId,
          timestamp: this.lastPingTime
        };
        this.adapter.send(pingMessage);
        this.packetsSent++;
      }
    }, 1000);
  }

  private stopPingMeasurement(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.log('[NetworkManager] Max reconnect attempts reached, giving up');
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = this.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(`[NetworkManager] Attempting reconnect ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    this.reconnectTimeout = self.setTimeout(async () => {
      try {
        const url = (this.adapter as any).getUrl?.() || 'ws://localhost:8080';
        await this.adapter.connect(url);
        console.log('[NetworkManager] Reconnect successful');
      } catch (error) {
        console.error('[NetworkManager] Reconnect failed:', error);
        this.attemptReconnect(); // Try again
      }
    }, delay);
  }

  getPing(): number {
    return this.ping;
  }

  getPacketLoss(): number {
    if (this.packetsSent === 0) return 0;
    const loss = ((this.packetsSent - this.packetsReceived) / this.packetsSent) * 100;
    return Math.max(0, Math.min(100, loss));
  }

  getJitter(): number {
    if (this.pingHistory.length < 2) return 0;
    
    // Calculate standard deviation of ping
    const mean = this.pingHistory.reduce((a, b) => a + b, 0) / this.pingHistory.length;
    const variance = this.pingHistory.reduce((sum, ping) => sum + Math.pow(ping - mean, 2), 0) / this.pingHistory.length;
    return Math.sqrt(variance);
  }

  private handlePong(data: any): void {
    if (data.timestamp === this.lastPingTime) {
      this.ping = Date.now() - this.lastPingTime;
      
      // Track ping history for jitter calculation
      this.pingHistory.push(this.ping);
      if (this.pingHistory.length > this.PING_HISTORY_SIZE) {
        this.pingHistory.shift();
      }
      
      this.packetsReceived++;
    }
  }

  private handleMessage(data: any): void {
    switch (data.type) {
      case 'playerJoined':
        this.handlePlayerJoined(data);
        break;
      case 'playerLeft':
        this.handlePlayerLeft(data);
        break;
      case 'playerUpdate':
        this.handlePlayerUpdate(data);
        break;
      case 'pong':
        this.handlePong(data);
        break;
      case 'gameState':
        this.handleGameState(data);
        break;
      case 'shot':
        this.handleShot(data);
        break;
      case 'hit':
        this.handleHit(data);
        break;
      case 'kill':
        this.handleKill(data);
        break;
      case 'projectileCreated':
        this.handleProjectileCreated(data);
        break;
      case 'projectileUpdate':
        this.handleProjectileUpdate(data);
        break;
      case 'projectileDestroyed':
        this.handleProjectileDestroyed(data);
        break;
      case 'playerRespawn':
        this.handlePlayerRespawn(data);
        break;
      case 'jump':
        this.handleJump(data);
        break;
      case 'jetpack':
        this.handleJetpack(data);
        break;
      case 'stateReconciliation':
        this.handleStateReconciliation(data);
        break;
      default:
        console.warn('[NetworkManager] Unknown message type:', data.type);
    }
  }

  private handlePlayerJoined(data: any): void {
    const { playerId } = data;
    if (playerId !== this.localPlayerId) {
      console.log('[NetworkManager] Player joined:', playerId);
      this.players.set(playerId, {
        playerId,
        position: { x: 0, y: 0, z: 0 },
        rotation: { yaw: 0, pitch: 0 },
        timestamp: Date.now()
      });
      if (this.onPlayerJoined) this.onPlayerJoined(playerId);
    }
  }

  private handlePlayerLeft(data: any): void {
    const { playerId } = data;
    console.log('[NetworkManager] Player left:', playerId);
    this.players.delete(playerId);
    if (this.onPlayerLeft) this.onPlayerLeft(playerId);
  }

  private handlePlayerUpdate(data: any): void {
    const { playerId, position, rotation, timestamp } = data;
    if (playerId !== this.localPlayerId) {
      this.players.set(playerId, {
        playerId,
        position,
        rotation,
        timestamp
      });
      if (this.onPlayerUpdate) this.onPlayerUpdate(playerId, position, rotation, timestamp);
    }
  }

  private handleGameState(data: any): void {
    const { players, localPlayerState } = data;
    
    console.log('[NetworkManager] gameState received, players:', players?.length, players?.map((p: any) => p.playerId));
    
    const previousCount = this.players.size;
    
    // Handle other players
    players.forEach((playerState: PlayerState) => {
      if (playerState.playerId !== this.localPlayerId) {
        if (!this.players.has(playerState.playerId)) {
          console.log('[NetworkManager] New remote player from gameState:', playerState.playerId);
        }
        this.players.set(playerState.playerId, playerState);
      }
    });
    
    const currentCount = this.players.size;
    if (currentCount !== previousCount) {
      console.log('[NetworkManager] Remote player count changed:', previousCount, '->', currentCount);
    }
    
    if (this.onGameState) this.onGameState(players, localPlayerState);
    
    // Handle local player state restoration (on reconnection)
    if (localPlayerState) {
      console.log('[NetworkManager] Restoring local player state:', localPlayerState);
      if (this.onStateRestore) {
        this.onStateRestore(localPlayerState);
      }
    }
  }

  private handleShot(data: any): void {
    const { playerId, targetId } = data;
    console.log('[NetworkManager] Shot fired by:', playerId, 'at:', targetId);
    // TODO: Handle shot visualization
  }

  private handleHit(data: any): void {
    const { shooterId, targetId, damage } = data;
    console.log('[NetworkManager] Player hit:', targetId, 'by:', shooterId, 'damage:', damage);
    
    // Trigger hit callback if registered
    if (this.onPlayerHit) {
      this.onPlayerHit(shooterId, targetId, damage);
    }
  }

  private handleKill(data: any): void {
    const { shooterId, targetId } = data;
    console.log('[NetworkManager] Player killed:', targetId, 'by:', shooterId);

    // Trigger kill callback if registered
    if (this.onPlayerKill) {
      this.onPlayerKill(shooterId, targetId);
    }
  }

  private handlePlayerRespawn(data: any): void {
    const { playerId, position, rotation } = data;
    console.log('[NetworkManager] Player respawned:', playerId);
    
    // Update player state
    this.players.set(playerId, {
      playerId,
      position,
      rotation,
      timestamp: Date.now()
    });
    
    // Trigger respawn callback if registered
    if (this.onPlayerRespawn) {
      this.onPlayerRespawn(playerId, position, rotation);
    }
  }

  private handleJump(data: any): void {
    const { playerId, position } = data;
    console.log('[NetworkManager] Player jumped:', playerId);
    
    // Trigger jump callback if registered
    if (this.onPlayerJump) {
      this.onPlayerJump(playerId, position);
    }
  }

  private handleJetpack(data: any): void {
    const { playerId, position } = data;
    console.log('[NetworkManager] Player jetpacking:', playerId);
    
    // Trigger jetpack callback if registered
    if (this.onPlayerJetpack) {
      this.onPlayerJetpack(playerId, position);
    }
  }

  private handleProjectileCreated(data: any): void {
    const { projectileId, ownerId, position, velocity } = data;
    console.log('[NetworkManager] Projectile created:', projectileId, 'by', ownerId);
    
    // Trigger projectile created callback if registered
    if (this.onProjectileCreated) {
      this.onProjectileCreated(projectileId, ownerId, position, velocity);
    }
  }

  private handleProjectileUpdate(data: any): void {
    const { projectileId, position } = data;
    
    // Trigger projectile update callback if registered
    if (this.onProjectileUpdate) {
      this.onProjectileUpdate(projectileId, position);
    }
  }

  private handleProjectileDestroyed(data: any): void {
    const { projectileId } = data;
    console.log('[NetworkManager] Projectile destroyed:', projectileId);
    
    // Trigger projectile destroyed callback if registered
    if (this.onProjectileDestroyed) {
      this.onProjectileDestroyed(projectileId);
    }
  }

  private handleStateReconciliation(data: any): void {
    const { playerId, data: reconciliationData } = data;
    
    // Only process for local player
    if (playerId !== this.localPlayerId) {
      return;
    }
    
    const { lastProcessedSequence, position, rotation, velocity } = reconciliationData;
    
    console.log('[NetworkManager] State reconciliation received, lastProcessedSequence:', lastProcessedSequence);
    
    // Remove inputs that have been processed by server
    for (const [seq, _] of this.inputHistory) {
      if (seq <= lastProcessedSequence) {
        this.inputHistory.delete(seq);
      }
    }
    
    // Trigger reconciliation callback to update client state
    if (this.onStateReconciliation) {
      this.onStateReconciliation({
        position,
        rotation,
        velocity,
        lastProcessedSequence
      });
    }
  }
}
