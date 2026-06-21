/**
 * Message handling for incoming WebSocket messages
 */

import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { decodePosition, decodeInput, decodeShot, MessageType } from './BinaryProtocol.js';

export class MessageHandler {
  constructor(
    private playerManager: PlayerManager,
    private projectileManager: ProjectileManager,
    private broadcastCallback: (message: any, excludePlayerId?: string) => void
  ) {}

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
    // TODO: Process input and update position
    // This will be implemented with proper physics
    console.log(`[MessageHandler] Input from ${playerId}:`, data);
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

    // Update player position
    player.position = data.position;
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
