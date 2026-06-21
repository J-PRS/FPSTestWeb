/**
 * Fixed tick loop for game state updates
 */

import { PlayerManager } from './PlayerManager.js';
import { ProjectileManager } from './ProjectileManager.js';

export class GameLoop {
  private intervalId: NodeJS.Timeout | null = null;
  private tickRate: number;
  private tickInterval: number;

  constructor(
    private playerManager: PlayerManager,
    private projectileManager: ProjectileManager,
    private broadcastCallback: (message: any, excludePlayerId?: string) => void,
    tickRate: number = 15
  ) {
    this.tickRate = tickRate;
    this.tickInterval = 1000 / tickRate;
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
    const dt = this.tickInterval / 1000; // seconds
    const GRAVITY = -20.0;
    const EXTRAPOLATION_TIMEOUT = 200; // ms - start extrapolating after this delay
    const PROJECTILE_LIFETIME = 5000; // 5 seconds
    const DISCONNECT_BROADCAST_DELAY = 10 * 1000; // 10 seconds
    const DISCONNECT_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    // Spawn points (random selection on respawn)
    const spawnPoints = [
      { x: 0, y: 50, z: 0 },
      { x: 50, y: 50, z: 0 },
      { x: -50, y: 50, z: 0 },
      { x: 0, y: 50, z: 50 },
      { x: 0, y: 50, z: -50 }
    ];

    // Check for respawns and extrapolate positions
    for (const [playerId, player] of this.playerManager.getPlayers()) {
      if (player.isDead && player.respawnTime && now >= player.respawnTime) {
        console.log(`[GameLoop] Respawning player ${playerId}, isDead: ${player.isDead}, respawnTime: ${player.respawnTime}, now: ${now}`);
        // Respawn player
        player.isDead = false;
        player.health = 100;
        player.respawnTime = null;

        // Random spawn point
        const spawnPoint = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
        player.position = { ...spawnPoint };
        player.rotation = { yaw: 0, pitch: 0 };
        player.velocity = { x: 0, y: 0, z: 0 };

        // Re-initialize rewind buffer
        this.playerManager.getRewindBuffer().set(playerId, []);

        console.log(`[GameLoop] Player ${playerId} respawned at`, player.position);

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
          console.log(`[GameLoop] Cleaning up disconnected player ${playerId}`);
          this.playerManager.removePlayer(playerId);
        }
      }
    }
  }
}
