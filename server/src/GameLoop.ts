/**
 * Fixed tick loop for game state updates
 */

import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';
import { ServerConfig } from './config.js';
import { ChildLogger } from './Logger.js';
import { SimpleTerrain } from './SimpleTerrain.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';

const logger = new ChildLogger('GameLoop');

export class GameLoop {
  private intervalId: NodeJS.Timeout | null = null;
  private tickRate: number;
  private tickInterval: number;
  private terrain: SimpleTerrain;
  private performanceMonitor?: PerformanceMonitor;

  constructor(
    private playerManager: PlayerManager,
    private projectileManager: ProjectileManager,
    private broadcastCallback: (message: any, excludePlayerId?: string) => void,
    tickRate: number = 15,
    performanceMonitor?: PerformanceMonitor
  ) {
    this.tickRate = tickRate;
    this.tickInterval = ServerConfig.MILLISECONDS_PER_SECOND / tickRate;
    this.terrain = new SimpleTerrain();
    this.performanceMonitor = performanceMonitor;
  }

  start(): void {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this.tick();
    }, this.tickInterval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    const startTime = now;
    const dt = this.tickInterval / ServerConfig.MILLISECONDS_PER_SECOND; // seconds
    const GRAVITY = ServerConfig.GRAVITY;
    const EXTRAPOLATION_TIMEOUT = ServerConfig.EXTRAPOLATION_TIMEOUT_MS;
    const PROJECTILE_LIFETIME = ServerConfig.PROJECTILE_LIFETIME;
    const DISCONNECT_BROADCAST_DELAY = ServerConfig.DISCONNECT_BROADCAST_DELAY_MS;
    const DISCONNECT_TIMEOUT = ServerConfig.DISCONNECT_TIMEOUT_MS;

    // Spawn points (fixed height above max terrain - server terrain doesn't match client)
    const spawnPoints = [
      { x: 0, y: 150, z: 0 },
      { x: 50, y: 150, z: 0 },
      { x: -50, y: 150, z: 0 },
      { x: 0, y: 150, z: 50 },
      { x: 0, y: 150, z: -50 }
    ];

    // Check for respawns and extrapolate positions
    for (const [playerId, player] of this.playerManager.getPlayers()) {
      if (player.isDead && player.respawnTime && now >= player.respawnTime) {
        logger.debug(`Respawning player ${playerId}, isDead: ${player.isDead}, respawnTime: ${player.respawnTime}, now: ${now}`);
        // Respawn player
        player.isDead = false;
        player.health = 100;
        player.respawnTime = null;

        // Choose spawn point furthest from alive players
        let bestSpawnPoint = spawnPoints[0];
        let maxMinDistance = -1;

        for (const spawnPoint of spawnPoints) {
          let minDistanceToAnyPlayer = Infinity;

          for (const [otherPlayerId, otherPlayer] of this.playerManager.getPlayers()) {
            if (otherPlayerId !== playerId && !otherPlayer.isDead) {
              const dx = spawnPoint.x - otherPlayer.position.x;
              const dz = spawnPoint.z - otherPlayer.position.z;
              const distance = Math.sqrt(dx * dx + dz * dz);
              minDistanceToAnyPlayer = Math.min(minDistanceToAnyPlayer, distance);
            }
          }

          if (minDistanceToAnyPlayer > maxMinDistance) {
            maxMinDistance = minDistanceToAnyPlayer;
            bestSpawnPoint = spawnPoint;
          }
        }

        // Use fixed spawn height (server terrain doesn't match client)
        player.position = { x: bestSpawnPoint.x, y: bestSpawnPoint.y, z: bestSpawnPoint.z };
        player.rotation = { yaw: 0, pitch: 0 };
        player.velocity = { x: 0, y: 0, z: 0 };

        // Re-initialize rewind buffer
        this.playerManager.getRewindBuffer().set(playerId, []);

        logger.debug(`Player ${playerId} respawned at`, player.position);

        // Broadcast respawn to all players
        this.broadcastCallback({
          type: 'playerRespawn',
          playerId,
          position: player.position,
          rotation: player.rotation
        });
      }
    }

    // Simulate projectiles
    const destroyedProjectiles = this.projectileManager.updateAll(dt, GRAVITY, PROJECTILE_LIFETIME);
    
    // Broadcast projectile updates
    for (const [projectileId, projectile] of this.projectileManager.getProjectiles()) {
      this.broadcastCallback({
        type: 'projectileUpdate',
        projectileId,
        position: projectile.position
      });
    }
    
    // Broadcast projectile destruction
    for (const projectileId of destroyedProjectiles) {
      this.broadcastCallback({
        type: 'projectileDestroyed',
        projectileId
      });
    }
    
    // Broadcast playerLeft for disconnected players after 10 seconds (gives time for reconnection)
    for (const [playerId, player] of this.playerManager.getPlayers()) {
      if (player.disconnected && player.disconnectTime) {
        if ((now - player.disconnectTime) > DISCONNECT_BROADCAST_DELAY && !player.playerLeftBroadcasted) {
          // Broadcast playerLeft after delay
          this.broadcastCallback({
            type: 'playerLeft',
            playerId
          });
          player.playerLeftBroadcasted = true;
        }
        
        // Cleanup players disconnected for too long
        if ((now - player.disconnectTime) > DISCONNECT_TIMEOUT) {
          logger.debug(`Cleaning up disconnected player ${playerId}`);
          this.playerManager.removePlayer(playerId);
        }
      }
    }

    // Record tick duration for performance monitoring
    if (this.performanceMonitor) {
      const tickDuration = Date.now() - startTime;
      this.performanceMonitor.recordTickDuration(tickDuration);
    }
  }
}
