/**
 * Message handling for incoming WebSocket messages
 */

import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { decodePosition, decodePositionDelta, decodeInput, decodeShot, encodeStateReconciliation, MessageType } from './BinaryProtocol.js';
import { PositionValidator } from './PositionValidator.js';

export class MessageHandler {
  private positionValidator: PositionValidator;

  constructor(
    private playerManager: PlayerManager,
    private projectileManager: ProjectileManager,
    private broadcastCallback: (message: any, excludePlayerId?: string) => void
  ) {
    this.positionValidator = new PositionValidator();
  }

  handleMessage(playerId: string, message: any): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    // Basic message validation
    if (!message || typeof message !== 'object' || !message.type) {
      console.warn(`[MessageHandler] Invalid message format from ${playerId}`);
      return;
    }

    switch (message.type) {
      case 'join':
        console.log(`[MessageHandler] Player ${playerId} joined`);
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

      default:
        console.warn(`[MessageHandler] Unknown message type from ${playerId}:`, message.type);
    }
  }

  handleBinaryMessage(playerId: string, data: Buffer): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    // Peek at first byte to determine message type
    const messageType = data[0];

    switch (messageType) {
      case MessageType.INPUT: {
        const inputData = decodeInput(data);
        this.handleInput(playerId, inputData.data);
        break;
      }
      case MessageType.POSITION: {
        const positionData = decodePosition(data);
        this.handlePosition(playerId, positionData.data);
        break;
      }
      case MessageType.POSITION_DELTA: {
        const positionData = decodePositionDelta(data);
        this.handlePositionDelta(playerId, positionData.data);
        break;
      }
      case MessageType.SHOT: {
        const shotData = decodeShot(data);
        this.handleShot(playerId, shotData.data);
        break;
      }
      default:
        console.warn(`[MessageHandler] Unknown binary message type from ${playerId}:`, messageType);
    }
  }

  private handleInput(playerId: string, data: any): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const { sequenceNumber, timestamp } = data;

    // Update last processed sequence
    this.playerManager.updateLastProcessedSequence(playerId, sequenceNumber);

    // Send state reconciliation back to client with authoritative state
    // This allows client to reconcile its prediction with server state
    const reconciliation = encodeStateReconciliation(
      playerId,
      sequenceNumber,
      player.position,
      player.rotation,
      player.velocity
    );

    // Send directly to the player (not broadcast)
    if (player.ws.readyState === 1) { // WebSocket.OPEN
      player.ws.send(reconciliation);
    }

    console.log(`[MessageHandler] Input from ${playerId}, sequence: ${sequenceNumber}, sent reconciliation`);
  }

  private handlePosition(playerId: string, data: any): void {
    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const now = Date.now();
    const dt = (now - player.lastUpdateTime) / 1000; // seconds

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
      player.velocity
    );

    // Validate position with latency-aware thresholds
    // Estimate ping from last update time
    const estimatedPing = Math.min(dt * 1000, 500); // Cap at 500ms
    const validation = this.positionValidator.validatePosition(
      playerId,
      data.position,
      now,
      estimatedPing
    );

    // Determine final position based on validation
    let finalPosition = data.position;
    if (validation.action === 'snap') {
      console.log(`[PositionValidator] Snapping ${playerId} to expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      finalPosition = validation.expectedPosition;
    } else if (validation.action === 'nudge') {
      console.log(`[PositionValidator] Nudging ${playerId} toward expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
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
    if (Math.random() < 0.05) { // 5% of updates log for debugging
      console.log(`[MessageHandler] Broadcasting position update for ${playerId}:`, player.position);
    }
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

    const now = Date.now();
    const dt = (now - player.lastUpdateTime) / 1000; // seconds

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
      player.velocity
    );

    // Validate position with latency-aware thresholds
    const estimatedPing = Math.min(dt * 1000, 500); // Cap at 500ms
    const validation = this.positionValidator.validatePosition(
      playerId,
      newPosition,
      now,
      estimatedPing
    );

    // Determine final position based on validation
    let finalPosition = newPosition;
    if (validation.action === 'snap') {
      console.log(`[PositionValidator] Snapping ${playerId} to expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
      finalPosition = validation.expectedPosition;
    } else if (validation.action === 'nudge') {
      console.log(`[PositionValidator] Nudging ${playerId} toward expected position. Discrepancy: ${validation.discrepancy.toFixed(2)}m`);
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
    if (Math.random() < 0.05) { // 5% of updates log for debugging
      console.log(`[MessageHandler] Broadcasting position delta update for ${playerId}:`, player.position);
    }
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
    console.log(`[MessageHandler] handleShot from ${playerId}:`, data);
    const player = this.playerManager.getPlayer(playerId);
    if (!player || player.isDead) {
      console.log(`[MessageHandler] Player ${playerId} not found or dead`);
      return;
    }

    const { targetId, timestamp, position, velocity, projectileId, directHit } = data;

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
      console.log(`[MessageHandler] Processing hit on ${targetId} at timestamp ${timestamp}`);
      // Process hit with lag compensation
      const targetPosition = this.playerManager.getPlayerPositionAt(targetId, timestamp);

      if (!targetPosition) {
        console.log(`[MessageHandler] No position found for ${targetId} at timestamp ${timestamp} - lag compensation failed, using current position`);
      }

      // Use current position if lag compensation fails
      const usePosition = targetPosition || this.playerManager.getPlayer(targetId)?.position;

      if (usePosition) {
        const targetPlayer = this.playerManager.getPlayer(targetId);
        if (!targetPlayer || targetPlayer.isDead) {
          console.log(`[MessageHandler] Target ${targetId} not found or dead`);
          return;
        }

        // Extract position (handle both direct position and player state)
        const targetPos = 'position' in usePosition ? usePosition.position : usePosition;

        // Calculate damage based on distance (closer = more damage)
        const dx = targetPos.x - position.x;
        const dy = targetPos.y - position.y;
        const dz = targetPos.z - position.z;
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        // Reverse falloff - more damage at range (reward long-range skill shots)
        // Bonus damage only applies after 1 second of projectile lifetime
        const projectileAge = (Date.now() - timestamp) / 1000; // in seconds
        const damage = projectileAge >= 1.0 
          ? Math.min(200, 100 + distance * 2) 
          : 100;
        targetPlayer.health -= damage;

        console.log(`[MessageHandler] Shot from ${playerId} HIT ${targetId} for ${damage} damage. Health: ${targetPlayer.health}, isDead: ${targetPlayer.isDead}`);
        
        // Destroy the projectile that caused the hit
        if (projectileId) {
          this.projectileManager.removeProjectile(projectileId);
          this.broadcastCallback({
            type: 'projectileDestroyed',
            projectileId
          });
          console.log(`[MessageHandler] Destroyed projectile ${projectileId} on hit`);
        }
        
        // Check if player died
        if (targetPlayer.health <= 0) {
          targetPlayer.health = 0;
          targetPlayer.isDead = true;
          targetPlayer.respawnTime = Date.now() + 2000;
          
          // Clear rewind buffer for dead player (save memory)
          this.playerManager.getRewindBuffer().delete(targetId);
          
          console.log(`[MessageHandler] Player ${targetId} killed by ${playerId}, respawning in 2s`);
          
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
    // Broadcast jump to other players
    this.broadcastCallback({
      type: 'jump',
      playerId,
      position
    }, playerId);
  }

  private handleJetpack(playerId: string, position: { x: number; y: number; z: number }): void {
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
    
    console.log(`[MessageHandler] Projectile ${projectileId} destroyed by client`);
  }

  private handlePing(message: any): void {
    // Echo back the ping with the same timestamp
    this.broadcastCallback({
      type: 'pong',
      playerId: message.playerId,
      timestamp: message.timestamp
    }, message.playerId);
  }
}
