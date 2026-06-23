/**
 * Message handling for incoming WebSocket messages
 */

import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { PositionValidator } from './PositionValidator.js';
import { MovementController, MovementState, MovementInput } from './MovementController.js';
import { SimpleTerrain } from './SimpleTerrain.js';
import { RateLimiter } from './RateLimiter.js';
import { ChildLogger } from './Logger.js';
import { ServerConfig } from './config.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import type { InputMessage } from './MessageTypes.js';

/**
 * Validate playerId format to prevent injection attacks
 * PlayerId should be alphanumeric with reasonable length
 */
function isValidPlayerId(playerId: string): boolean {
  if (!playerId || typeof playerId !== 'string') return false;
  if (playerId.length < 1 || playerId.length > 50) return false;
  // Allow alphanumeric, underscore, hyphen
  return /^[a-zA-Z0-9_-]+$/.test(playerId);
}

/**
 * Validate numeric value to prevent NaN/Infinity attacks
 */
function isValidNumber(value: number): boolean {
  return typeof value === 'number' && isFinite(value) && !isNaN(value);
}

/**
 * Validate position/velocity vector
 */
function isValidVector(vec: { x: number; y: number; z: number }): boolean {
  return isValidNumber(vec.x) && isValidNumber(vec.y) && isValidNumber(vec.z);
}

// WebSocket ready states
const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const WS_READY_STATE_CLOSED = 3;

export class MessageHandler {
  private positionValidator: PositionValidator;
  private terrain: SimpleTerrain;
  private movementControllers: Map<string, MovementController> = new Map();
  private rateLimiter: RateLimiter;
  private logger: ChildLogger;
  private performanceMonitor?: PerformanceMonitor;

  constructor(
    private playerManager: PlayerManager,
    private projectileManager: ProjectileManager,
    private broadcastCallback: (message: any, excludePlayerId?: string) => void,
    positionValidator: PositionValidator,
    performanceMonitor?: PerformanceMonitor
  ) {
    try {
      this.logger = new ChildLogger('MessageHandler');
      this.positionValidator = positionValidator;
      this.terrain = new SimpleTerrain();
      this.rateLimiter = new RateLimiter();
      this.performanceMonitor = performanceMonitor;
    } catch (error) {
      console.error(`MessageHandler initialization error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  handleMessage(playerId: string, message: any): void {
    try {
      const player = this.playerManager.getPlayer(playerId);
      if (!player) return;

      // Rate limit total messages per player
      if (!this.rateLimiter.canSendMessage(playerId)) {
        if (this.rateLimiter.shouldLogWarning(playerId)) {
          this.logger.warn(`Player ${playerId} exceeded total message rate limit`);
        }
        return;
      }

      // Basic message validation
      if (!message || typeof message !== 'object' || !message.type) {
        this.logger.warn(`Invalid message format from ${playerId}`);
        return;
      }

      switch (message.type) {
      case 'join':
        this.logger.info(`Player ${playerId} joined`);
        break;

      case 'input':
        this.handleInput(playerId, message.data);
        break;

      case 'position':
        this.handlePosition(playerId, message.data);
        break;

      case 'shot':
        this.handleShot(playerId, message.data);
        break;

      case 'jump':
        this.handleJump(playerId, message.position);
        break;

      case 'jetpack':
        this.handleJetpack(playerId, message.position);
        break;

      case 'projectileDestroy':
        this.handleProjectileDestroy(message.projectileId);
        break;

      case 'ping':
        this.handlePing(message);
        break;

      case 'snapshot':
        this.handleSnapshotRequest(playerId);
        break;

      case 'snapshotResponse':
        this.handleSnapshotResponse(playerId, message);
        break;

      case 'roughState':
        this.handleRoughState(playerId, message);
        break;

      case 'createRoom':
        this.handleCreateRoom(playerId, message);
        break;

      case 'joinRoom':
        this.handleJoinRoom(playerId, message);
        break;

      case 'listRooms':
        this.handleListRooms(playerId);
        break;

      default:
        this.logger.warn(`Unknown message type from ${playerId}: ${message.type}`);
    }
    } catch (error) {
      this.logger.error(`Error handling message from ${playerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  private handleInput(playerId: string, data: InputMessage): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const { sequenceNumber, timestamp, input } = data;

    // Get or create movement controller for this player
    let movementController = this.movementControllers.get(playerId);
    if (!movementController) {
      const initialState: MovementState = {
        pos: { ...player.position },
        vel: { ...player.velocity },
        yaw: player.rotation.yaw,
        pitch: player.rotation.pitch,
        onGround: true // Assume grounded initially
      };
      movementController = new MovementController(this.terrain, initialState);
      this.movementControllers.set(playerId, movementController);
    }

    // Process input through server-authoritative movement controller
    if (input) {
      // Convert input from protocol format (-127 to 127) to MovementInput format (-1 to 1)
      const movementInput: MovementInput = {
        forward: input.forward / 127,
        right: input.right / 127,
        jump: input.jump === 1,
        ski: input.ski === 1
      };
      movementController.setInput(movementInput);

      // Update server state with player's current rotation (from position updates)
      const currentState = movementController.getState();
      currentState.yaw = player.rotation.yaw;
      currentState.pitch = player.rotation.pitch;
      movementController.setState(currentState);

      // Simulate one tick (67ms at 15Hz)
      const dt = 1 / 15;
      movementController.update(dt);

      // Update player state with authoritative position
      const newState = movementController.getState();
      player.position = { ...newState.pos };
      player.velocity = { ...newState.vel };
      player.rotation.yaw = newState.yaw;
      player.rotation.pitch = newState.pitch;
      player.lastUpdateTime = Date.now();

      // Store in rewind buffer for lag compensation
      this.playerManager.storePlayerPosition(playerId, player.position, player.rotation, player.velocity);
    }

    // Update last processed sequence
    this.playerManager.updateLastProcessedSequence(playerId, sequenceNumber);

    // Send state reconciliation back to client with authoritative state
    // Using JSON for now - can be replaced with Tribes2 GhostManager later
    const reconciliation = JSON.stringify({
      type: 'stateReconciliation',
      playerId,
      lastProcessedSequence: sequenceNumber,
      position: player.position,
      rotation: player.rotation,
      velocity: player.velocity
    });

    // Send directly to the player (not broadcast)
    if (player.ws.readyState === WS_READY_STATE_OPEN) {
      player.ws.send(reconciliation);
    }

    this.logger.debug(`Input from ${playerId}, sequence: ${sequenceNumber}, processed authoritatively`);
  }

  private handlePosition(playerId: string, data: any): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    // Validate position data to prevent NaN/Infinity attacks
    if (!isValidVector(data.position)) {
      this.logger.warn(`Invalid position data from ${playerId}: ${JSON.stringify(data.position)}`);
      return;
    }

    const now = Date.now();
    const dt = (now - player.lastUpdateTime) / ServerConfig.MILLISECONDS_PER_SECOND; // seconds

    // Calculate velocity from position change
    if (dt > 0 && dt < 1.0) { // Ignore very large gaps (reconnection)
      player.velocity.x = (data.position.x - player.position.x) / dt;
      player.velocity.y = (data.position.y - player.position.y) / dt;
      player.velocity.z = (data.position.z - player.position.z) / dt;
    }

    // Add snapshot to position validator history BEFORE validation
    this.positionValidator.addSnapshot(
      playerId,
      now,
      player.position,
      player.velocity,
      { x: 0, y: ServerConfig.GRAVITY, z: 0 } // Default to gravity acceleration
    );

    // Validate position with latency-aware thresholds
    // Estimate ping from last update time
    const estimatedPing = Math.min(dt * 1000, ServerConfig.ESTIMATED_PING_CAP_MS);
    const validation = this.positionValidator.validatePosition(
      playerId,
      data.position,
      now,
      estimatedPing
    );

    // Determine final position based on validation
    let finalPosition = data.position;
    if (validation.action === 'snap') {
      this.logger.debug(`Snapping ${playerId} to expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      finalPosition = validation.expectedPosition;
    } else if (validation.action === 'nudge') {
      this.logger.debug(`Nudging ${playerId} toward expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      // Gentle nudge - blend 50% toward expected position
      finalPosition = {
        x: (data.position.x + validation.expectedPosition.x) / 2,
        y: (data.position.y + validation.expectedPosition.y) / 2,
        z: (data.position.z + validation.expectedPosition.z) / 2
      };
    }
    // accept: use client position as-is

    // Update player position with validated position
    player.position = finalPosition;
    player.rotation = data.rotation;
    player.lastUpdateTime = now;

    // Store in rewind buffer for lag compensation
    this.playerManager.storePlayerPosition(playerId, player.position, player.rotation);

    // Broadcast to other players
    this.logger.debug(`Broadcasting position update for ${playerId}`);
    this.broadcastCallback({
      type: 'playerUpdate',
      playerId,
      position: player.position,
      rotation: player.rotation,
      sequenceNumber: player.lastProcessedSequence,
      timestamp: Date.now()
    }, playerId);
  }

  private handlePositionDelta(playerId: string, data: any): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    // Validate position delta data to prevent NaN/Infinity attacks
    if (!isValidVector(data.positionDelta)) {
      this.logger.warn(`Invalid positionDelta data from ${playerId}: ${JSON.stringify(data.positionDelta)}`);
      return;
    }

    const now = Date.now();
    const dt = (now - player.lastUpdateTime) / ServerConfig.MILLISECONDS_PER_SECOND; // seconds

    // Apply position delta
    const newPosition = {
      x: player.position.x + data.positionDelta.x,
      y: player.position.y + data.positionDelta.y,
      z: player.position.z + data.positionDelta.z
    };

    // Apply rotation delta
    const newRotation = {
      yaw: player.rotation.yaw + data.rotationDelta.yaw,
      pitch: player.rotation.pitch + data.rotationDelta.pitch
    };

    // Calculate velocity from position change
    if (dt > 0 && dt < 1.0) { // Ignore very large gaps (reconnection)
      player.velocity.x = (newPosition.x - player.position.x) / dt;
      player.velocity.y = (newPosition.y - player.position.y) / dt;
      player.velocity.z = (newPosition.z - player.position.z) / dt;
    }

    // Add snapshot to position validator history BEFORE validation
    this.positionValidator.addSnapshot(
      playerId,
      now,
      player.position,
      player.velocity,
      { x: 0, y: ServerConfig.GRAVITY, z: 0 } // Default to gravity acceleration
    );

    // Validate position with latency-aware thresholds
    const estimatedPing = Math.min(dt * 1000, ServerConfig.ESTIMATED_PING_CAP_MS);
    const validation = this.positionValidator.validatePosition(
      playerId,
      newPosition,
      now,
      estimatedPing
    );

    // Determine final position based on validation
    let finalPosition = newPosition;
    if (validation.action === 'snap') {
      this.logger.debug(`Snapping ${playerId} to expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      finalPosition = validation.expectedPosition;
    } else if (validation.action === 'nudge') {
      this.logger.debug(`Nudging ${playerId} toward expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      finalPosition = {
        x: (newPosition.x + validation.expectedPosition.x) / 2,
        y: (newPosition.y + validation.expectedPosition.y) / 2,
        z: (newPosition.z + validation.expectedPosition.z) / 2
      };
    }

    // Update player position with validated position
    player.position = finalPosition;
    player.rotation = newRotation;
    player.lastUpdateTime = now;

    // Store in rewind buffer for lag compensation
    this.playerManager.storePlayerPosition(playerId, player.position, player.rotation);

    // Broadcast to other players
    this.logger.debug(`Broadcasting position delta update for ${playerId}`);
    this.broadcastCallback({
      type: 'playerUpdate',
      playerId,
      position: player.position,
      rotation: player.rotation,
      sequenceNumber: player.lastProcessedSequence,
      timestamp: Date.now()
    }, playerId);
  }

  private handleShot(playerId: string, data: any): void {
    // Rate limit shots
    if (!this.rateLimiter.canShoot(playerId)) {
      if (this.rateLimiter.shouldLogWarning(playerId)) {
        const rateInfo = this.rateLimiter.getRateInfo(playerId, 'shot');
        this.logger.warn(`Shot rate limited for ${playerId}: ${rateInfo.actualRate.toFixed(1)}/s (limit: ${rateInfo.limit}/s, exceeded by: ${rateInfo.exceededBy.toFixed(1)}/s)`);
      }
      return;
    }

    this.logger.debug(`handleShot from ${playerId}`);
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {
      this.logger.debug(`Player ${playerId} not found or dead`);
      return;
    }

    const { targetId, timestamp, position, velocity, projectileId, directHit } = data;

    // Validate position/velocity data to prevent NaN/Infinity attacks
    if (position && !isValidVector(position)) {
      this.logger.warn(`Invalid shot position data from ${playerId}: ${JSON.stringify(position)}`);
      return;
    }
    if (velocity && !isValidVector(velocity)) {
      this.logger.warn(`Invalid shot velocity data from ${playerId}: ${JSON.stringify(velocity)}`);
      return;
    }

    // Create server-side projectile for tracking
    if (position && velocity) {
      const serverProjectileId = this.projectileManager.createProjectile(playerId, position, velocity);
      
      // Broadcast projectile creation to all clients
      this.broadcastCallback({
        type: 'projectileCreated',
        projectileId: serverProjectileId,
        ownerId: playerId,
        position,
        velocity
      });
    }

    if (targetId) {
      this.logger.debug(`Processing hit on ${targetId} at timestamp ${timestamp}`);
      // Process hit with lag compensation
      const targetPosition = this.playerManager.getPlayerPositionAt(targetId, timestamp);

      if (!targetPosition) {
        this.logger.warn(`No position found for ${targetId} at timestamp ${timestamp} - lag compensation failed, using current position`);
      }

      // Use current position if lag compensation fails
      const usePosition = targetPosition || this.playerManager.getPlayer(targetId)?.position;

      if (usePosition) {
        const targetPlayer = this.playerManager.getPlayer(targetId);
        if (!targetPlayer || targetPlayer.isDead) {
          this.logger.debug(`Target ${targetId} not found or dead`);
          return;
        }

        // Extract position (handle both direct position and player state)
        const targetPos = 'position' in usePosition ? usePosition.position : usePosition;

        // Validate targetPos before using
        if (!targetPos || typeof targetPos.x !== 'number') {
          this.logger.warn(`Invalid target position for ${targetId}, skipping hit processing`);
          return;
        }

        // Use shooter's current position if shot data doesn't include position
        const shooterPos = position || player.position;

        // Validate shooter position before using
        if (!shooterPos || typeof shooterPos.x !== 'number') {
          this.logger.warn(`Invalid shooter position for ${playerId}, skipping hit processing`);
          return;
        }

        // Server-side collision validation: check if projectile is actually close to target
        if (projectileId) {
          const projectile = this.projectileManager.getProjectile(projectileId);
          if (projectile) {
            const dx = projectile.position.x - targetPos.x;
            const dy = projectile.position.y - targetPos.y;
            const dz = projectile.position.z - targetPos.z;
            const projectileDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
            
            // Reject hits where projectile is too far from target (growing projectile max radius ~5m)
            const MAX_HIT_DISTANCE = 10.0; // Allow some margin for network latency
            if (projectileDistance > MAX_HIT_DISTANCE) {
              this.logger.warn(`Rejected hit from ${playerId} on ${targetId}: projectile too far (${projectileDistance.toFixed(1)}m > ${MAX_HIT_DISTANCE}m)`);
              return;
            }
          }
        }

        // Calculate damage based on distance (closer = more damage)
        const dx = targetPos.x - shooterPos.x;
        const dy = targetPos.y - shooterPos.y;
        const dz = targetPos.z - shooterPos.z;
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        // Reverse falloff - more damage at range (reward long-range skill shots)
        // Bonus damage only applies after 1 second of projectile lifetime
        const projectileAge = (Date.now() - timestamp) / ServerConfig.MILLISECONDS_PER_SECOND; // in seconds
        const damage = projectileAge >= 1.0 
          ? Math.min(200, 100 + distance * 2) 
          : 100;
        targetPlayer.health -= damage;

        this.logger.info(`Shot from ${playerId} HIT ${targetId} for ${damage} damage. Health: ${targetPlayer.health}, isDead: ${targetPlayer.isDead}`);
        
        // Destroy the projectile that caused the hit
        if (projectileId) {
          this.projectileManager.removeProjectile(projectileId);
          this.broadcastCallback({
            type: 'projectileDestroyed',
            projectileId
          });
          this.logger.debug(`Destroyed projectile ${projectileId} on hit`);
        }
        
        // Check if player died
        if (targetPlayer.health <= 0) {
          targetPlayer.health = 0;
          targetPlayer.isDead = true;
          targetPlayer.respawnTime = Date.now() + ServerConfig.RESPAWN_DELAY_MS;
          
          // Clear rewind buffer for dead player (save memory)
          this.playerManager.getRewindBuffer().delete(targetId);
          
          this.logger.info(`Player ${targetId} killed by ${playerId}, respawning in 2s`);
          
          // Trigger rough state comparison on player death
          this.requestRoughStates();
          
          // Broadcast kill to all players
          this.broadcastCallback({
            type: 'kill',
            shooterId: playerId,
            targetId,
            timestamp
          });
        } else {
          // Broadcast hit (non-lethal)
          this.broadcastCallback({
            type: 'hit',
            shooterId: playerId,
            targetId,
            damage,
            timestamp
          });
        }
      }
    } else {
      // Shot without target (miss)
      this.broadcastCallback({
        type: 'shot',
        playerId,
        targetId: null,
        timestamp
      });
    }
  }

  private handleJump(playerId: string, position: { x: number; y: number; z: number }): void {
    // Rate limit jumps
    if (!this.rateLimiter.canJump(playerId)) {
      if (this.rateLimiter.shouldLogWarning(playerId)) {
        const rateInfo = this.rateLimiter.getRateInfo(playerId, 'jump');
        this.logger.warn(`Jump rate limited for ${playerId}: ${rateInfo.actualRate.toFixed(1)}/s (limit: ${rateInfo.limit}/s, exceeded by: ${rateInfo.exceededBy.toFixed(1)}/s)`);
      }
      return;
    }

    // Broadcast jump to other players
    this.broadcastCallback({
      type: 'jump',
      playerId,
      position
    }, playerId);
  }

  private handleSnapshotRequest(playerId: string): void {
    this.logger.info(`Snapshot requested by ${playerId}`);
    const players = this.playerManager.getPlayers();
    const projectiles = this.projectileManager.getProjectiles();
    const snapshot = {
      type: 'snapshot',
      source: 'server',
      timestamp: Date.now(),
      players: Array.from(players.entries()).map(([id, p]) => ({
        id,
        position: { ...p.position },
        velocity: { ...p.velocity },
        health: p.health,
        isDead: p.isDead,
        rotation: p.rotation ? { ...p.rotation } : undefined
      })),
      projectiles: Array.from(projectiles.values()).map(p => ({
        id: p.id,
        ownerId: p.ownerId,
        position: { ...p.position },
        velocity: { ...p.velocity }
      }))
    };
    
    // Send snapshot back to requesting client
    this.broadcastCallback(snapshot, playerId);
  }

  private handleSnapshotResponse(playerId: string, message: any): void {
    this.logger.info(`Snapshot response from ${playerId}`);
    // Store snapshot for comparison
    // For now, just log that we received it
    this.logger.info(`Snapshot from ${playerId}: ${message.players?.length || 0} players, ${message.projectiles?.length || 0} projectiles`);
  }

  /**
   * Request snapshots from all connected clients for state comparison
   */
  requestAllSnapshots(): void {
    this.logger.info('Requesting snapshots from all clients');
    this.broadcastCallback({
      type: 'snapshotRequest',
      timestamp: Date.now()
    });
  }

  /**
   * Request rough state from all clients (simple position/health check)
   */
  requestRoughStates(): void {
    this.logger.info('Requesting rough states from all clients');
    this.broadcastCallback({
      type: 'roughStateRequest',
      timestamp: Date.now()
    });
  }

  private handleRoughState(playerId: string, message: any): void {
    this.logger.info(`Rough state from ${playerId}: ${message.players?.length || 0} players`);
    
    // Compare with server state
    const serverPlayers = this.playerManager.getPlayers();
    const clientPlayers = new Map<string, any>(message.players || []);
    
    let matchCount = 0;
    let mismatchCount = 0;
    
    for (const [id, serverPlayer] of serverPlayers) {
      const clientPlayer = clientPlayers.get(id);
      if (!clientPlayer) {
        this.logger.warn(`Player ${id} missing on client ${playerId}`);
        mismatchCount++;
        continue;
      }
      
      // Rough comparison: position within 10 units, health within 10
      const posDiff = Math.abs(serverPlayer.position.x - clientPlayer.position.x) +
                     Math.abs(serverPlayer.position.y - clientPlayer.position.y) +
                     Math.abs(serverPlayer.position.z - clientPlayer.position.z);
      const healthDiff = Math.abs(serverPlayer.health - clientPlayer.health);
      
      if (posDiff < 10 && healthDiff < 10 && serverPlayer.isDead === clientPlayer.isDead) {
        matchCount++;
      } else {
        this.logger.warn(`Player ${id} mismatch: posDiff=${posDiff.toFixed(1)}, healthDiff=${healthDiff}, serverDead=${serverPlayer.isDead}, clientDead=${clientPlayer.isDead}`);
        mismatchCount++;
      }
    }
    
    this.logger.info(`Client ${playerId} comparison: ${matchCount} matches, ${mismatchCount} mismatches`);
  }

  /**
   * Clean up movement controller when player disconnects
   */
  cleanupPlayer(playerId: string): void {
    this.movementControllers.delete(playerId);
    this.positionValidator.clearHistory(playerId);
    this.rateLimiter.cleanupPlayer(playerId);
  }

  private handleJetpack(playerId: string, position: { x: number; y: number; z: number }): void {
    // Rate limit jetpack updates
    if (!this.rateLimiter.canJetpack(playerId)) {
      if (this.rateLimiter.shouldLogWarning(playerId)) {
        const rateInfo = this.rateLimiter.getRateInfo(playerId, 'jetpack');
        this.logger.warn(`Jetpack rate limited for ${playerId}: ${rateInfo.actualRate.toFixed(1)}/s (limit: ${rateInfo.limit}/s, exceeded by: ${rateInfo.exceededBy.toFixed(1)}/s)`);
      }
      return;
    }

    // Broadcast jetpack to other players
    this.broadcastCallback({
      type: 'jetpack',
      playerId,
      position
    }, playerId);
  }

  private handleProjectileDestroy(projectileId: string): void {
    // Remove projectile from server tracking
    this.projectileManager.removeProjectile(projectileId);
    
    // Broadcast destruction to all clients
    this.broadcastCallback({
      type: 'projectileDestroyed',
      projectileId
    });
    
    this.logger.debug(`Projectile ${projectileId} destroyed by client`);
  }

  private handlePing(message: any): void {
    // Echo back the ping with the same timestamp
    this.broadcastCallback({
      type: 'pong',
      timestamp: message.timestamp
    });
  }

  private handleCreateRoom(playerId: string, message: any): void {
    const { roomId, name, maxPlayers, gameMode } = message;
    
    if (!roomId || typeof roomId !== 'string') {
      this.logger.warn(`Invalid roomId from ${playerId}`);
      return;
    }

    // Import RoomManager dynamically to avoid circular dependency
    // In production, this would be passed in constructor
    this.logger.info(`Room creation requested by ${playerId}: ${roomId}`);
    
    // For now, just acknowledge - actual room creation happens in Server
    this.broadcastCallback({
      type: 'roomCreated',
      roomId,
      success: true
    }, playerId);
  }

  private handleJoinRoom(playerId: string, message: any): void {
    const { roomId } = message;
    
    if (!roomId || typeof roomId !== 'string') {
      this.logger.warn(`Invalid roomId from ${playerId}`);
      return;
    }

    this.logger.info(`Room join requested by ${playerId}: ${roomId}`);
    
    // Acknowledge - actual join happens in Server
    this.broadcastCallback({
      type: 'roomJoined',
      roomId,
      success: true
    }, playerId);
  }

  private handleListRooms(playerId: string): void {
    this.logger.info(`Room list requested by ${playerId}`);
    
    // For now, send empty list - actual list happens in Server
    this.broadcastCallback({
      type: 'roomList',
      rooms: []
    }, playerId);
  }
}
