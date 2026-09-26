// Server message handlers — registered once inside init(). Each on* callback
// maps a network event to game-state changes (remote player lifecycle,
// server-authoritative projectile spawn/destroy, damage/kill/respawn, snapshots).

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../core/config.js';
import type { ChildLogger } from '../core/Logger.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { PlayerDebris } from '../effects/debris.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../shared/protocol.js';
import { Projectile } from '../projectiles/Projectile.js';
import { ROCKET_CONFIG, getProjectileConfig } from '../projectiles/index.js';
import type { WorldState } from './worldState.js';
import type { FragMessages } from '../ui/FragMessages.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { Terrain } from '../world/terrain.js';

export interface NetDeps {
  networkManager(): NetworkManager;
  scene(): THREE.Scene;
  terrain(): Terrain;
  player(): Player;
  effects(): EffectsManager;
  hud(): HUD;
  healthBarSystem(): HealthBarSystem;
  fragMessages: FragMessages;
  explosionTracker: ExplosionTracker;
  logger: ChildLogger;
  world: WorldState;
  setLastSentPos(pos: { x: number; y: number; z: number }): void;
}

export function wireNetworkHandlers(deps: NetDeps): void {
  const { logger } = deps;
  const nm = () => deps.networkManager();
  const networkManager = deps.networkManager();

  // Both first-seen-update and respawn-into-missing end up here
  function ensureRemotePlayer(playerId: string, position: { x: number; y: number; z: number }, via: string): RemotePlayer {
    const rp = new RemotePlayer(deps.scene(), playerId, position, deps.terrain());
    deps.world.remotePlayers.set(playerId, rp);
    logger.debug(`CREATED remote player (${via})`, { instanceId: rp.instanceId, playerId, total: deps.world.remotePlayers.size });
    return rp;
  }

  // Register player hit handler (non-lethal hits)
  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number) => {
    // Check if local player was hit
    if (targetId === nm().getLocalPlayerId()) {
      deps.player().health = health;
      logger.info(`Local player hit for ${damage} damage by ${shooterId} (health: ${health})`);
      return;
    }

    // Non-lethal hits don't trigger death animation
    logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId} (health: ${health})`);
    deps.healthBarSystem().spawn(targetId, damage, health);
  };

  // Register knockback handler — server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean) => {
    const from = new THREE.Vector3(position.x, position.y, position.z);
    const player = deps.player();
    if (pull) {
      player.applyPull(from, force);
    } else {
      player.applyKnockback(from, force);
    }
  };

  // Server correction — three-tier reconciliation (CFWK model):
  //  <0.5m error  → ignore: the prediction error is sub-visible, snapping
  //                 would be a worse warp than the desync it fixes
  //  <5m          → blend halfway toward server state (soft nudge)
  //  ≥5m          → hard snap: genuine desync, take the server state
  networkManager.onCorrection = (_seq: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    const player = deps.player();
    const dx = player.pos.x - position.x, dy = player.pos.y - position.y, dz = player.pos.z - position.z;
    const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (err < 0.5) {
      logger.info(`Correction ignored: ${err.toFixed(2)}m below snap threshold`);
      return;
    }
    if (err < 5.0) {
      player.pos.x = position.x + dx * 0.5;
      player.pos.y = position.y + dy * 0.5;
      player.pos.z = position.z + dz * 0.5;
      player.vel.set(velocity.x, velocity.y, velocity.z);
      player.syncMovement();
      logger.info(`Correction nudged: ${err.toFixed(2)}m (blended 50%)`);
      return;
    }
    player.pos.set(position.x, position.y, position.z);
    player.vel.set(velocity.x, velocity.y, velocity.z);
    player.yaw = rotation.yaw;
    player.pitch = rotation.pitch;
    player.syncMovement();
  };

  // Register player kill handler (lethal kills)
  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    deps.world.killCounts.set(shooterId, (deps.world.killCounts.get(shooterId) ?? 0) + 1);
    // Check if local player was killed
    if (targetId === nm().getLocalPlayerId()) {
      logger.info(`Local player killed by ${shooterId}`);
      const player = deps.player();
      player.isDead = true;
      player.health = 0;
      deps.hud().hide();
      deps.hud().setDeathOverlay(true);
      deps.fragMessages.show(shooterId === 'environment' ? 'YOU DIED\ndevoured by a crawler' : `YOU DIED\nfragged by ${shooterId}`);
      return;
    }

    // Show frag message if local player got the kill
    if (shooterId === nm().getLocalPlayerId()) {
      deps.fragMessages.show(`FRAGGED PLAYER!`);
    }

    // Mark player as dead in NetworkManager immediately so main loop knows
    const playerData = nm().getPlayers().get(targetId);
    if (playerData) {
      playerData.isDead = true;
      playerData.health = 0;
    }

    const remotePlayer = deps.world.remotePlayers.get(targetId);
    if (remotePlayer) {
      // Find matching explosion from this shooter
      let explosionPos: THREE.Vector3 | undefined;
      let explosionForce: number | undefined;
      for (const exp of deps.explosionTracker.getRecentExplosions()) {
        if (exp.shooterId === shooterId) {
          explosionPos = exp.position;
          explosionForce = exp.force;
          break;
        }
      }

      // Play death animation (ragdoll physics with explosion impulse)
      remotePlayer.playDeath(explosionPos, explosionForce);

      // Spawn player debris at player center (position is feet, so add half height)
      const debris = new PlayerDebris(deps.scene(), deps.terrain(), remotePlayer.position.x, remotePlayer.position.y + 1.0, remotePlayer.position.z);
      deps.world.playerDebrisList.push(debris);

      // Hide the model immediately
      remotePlayer.hide();

      // Remove HUD indicator on kill
      deps.hud().removePlayerIndicator(targetId);
      deps.healthBarSystem().removeBar(targetId);

      logger.info(`Player ${targetId} killed by ${shooterId}`);
    }
  };

  // Register jump handler for remote players
  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.effects().spawnJumpDust(pos);
  };

  // Register jetpack handler for remote players
  networkManager.onPlayerJetpack = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.effects().spawnJetpack(pos);
  };

  // Register player update handler for remote players
  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, _timestamp: number, velocity?: { x: number; y: number; z: number }) => {
    // Safety: never process local player as a remote player
    if (playerId === nm().getLocalPlayerId()) return;
    let remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, nm().getPing(), velocity);
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
      return;
    }

    // Don't create RemotePlayer for dead players — wait for respawn event
    const playerData = nm().getPlayers().get(playerId);
    if (playerData?.isDead) return;
    logger.debug(`onPlayerUpdate called for unknown player: ${playerId}, creating...`);
    ensureRemotePlayer(playerId, position, 'onPlayerUpdate');
  };

  // Server-authoritative projectile handlers
  const remoteProjectiles = new Map<string, Projectile>();

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, weaponType?: number) => {
    // For own projectiles: link the pending local projectile to this server ID
    if (ownerId === nm().getLocalPlayerId()) {
      const localProjectile = deps.world.projectileRegistry.pending.shift();
      if (localProjectile) {
        localProjectile.serverProjectileId = projectileId;
        deps.world.projectileRegistry.byId.set(projectileId, localProjectile);
        deps.world.projectileRegistry.pendingSince.delete(localProjectile); // Clean up timestamp
      }
      return;
    }

    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.clone().normalize();
    const cfg = (weaponType !== undefined ? getProjectileConfig(weaponType) : undefined) ?? ROCKET_CONFIG;
    const remoteProjectile = new Projectile(deps.scene(), origin, dir, new THREE.Vector3(0, 0, 0), cfg);
    remoteProjectile.vel.copy(vel); // override with exact server velocity
    remoteProjectile.isRemote = true;
    remoteProjectile.spawnedThisFrame = false; // remote projectiles don't need first-frame skip
    // Fast-forward by half-RTT: the server relays the spawn ~half a round-trip
    // late, so without this the projectile lags behind the shooter's real one
    const lead = Math.min(0.15, nm().getPing() / 2000);
    if (lead > 0) {
      remoteProjectile.advanceBy(lead);
    }
    deps.world.projectiles.push(remoteProjectile);
    remoteProjectiles.set(projectileId, remoteProjectile);
    // Gun recoil kick on the shooter's remote model
    deps.world.remotePlayers.get(ownerId)?.fire();
  };

  networkManager.onProjectileDestroyed = (projectileId: string) => {
    // Kill remote projectile (explode so trail particles fade out naturally).
    // Delete the map entry now — the visual fade lives on world.projectiles,
    // not this map; keeping dead entries leaks one record per shot ever fired.
    const remoteProjectile = remoteProjectiles.get(projectileId);
    if (remoteProjectile) {
      remoteProjectile.explode();
      remoteProjectiles.delete(projectileId);
    }
    // Kill local projectile if server says it's gone - explode to let trails fade
    const localProjectile = deps.world.projectileRegistry.byId.get(projectileId);
    if (localProjectile) {
      localProjectile.explode();
      deps.world.projectileRegistry.byId.delete(projectileId);
      // Also remove from pending queue if it's still there (shouldn't happen but defensive)
      const pendingIndex = deps.world.projectileRegistry.pending.indexOf(localProjectile);
      if (pendingIndex !== -1) {
        deps.world.projectileRegistry.pending.splice(pendingIndex, 1);
        deps.world.projectileRegistry.pendingSince.delete(localProjectile);
      }
    }
  };

  // Register player respawn handler
  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    // Check if local player respawned
    if (playerId === nm().getLocalPlayerId()) {
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      const player = deps.player();
      player.isDead = false;
      player.health = 100;
      player.vel.set(0, 0, 0);
      player.pos.set(position.x, position.y, position.z);
      deps.setLastSentPos({ x: position.x, y: position.y, z: position.z });
      player.yaw = rotation.yaw;
      player.pitch = rotation.pitch;
      player.syncMovement(); // reseat controller or its snapshot overwrites the respawn
      deps.hud().show();
      deps.hud().setDeathOverlay(false);
      return;
    }

    // Reset existing remote player on respawn
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      const playerData = nm().getPlayers().get(playerId);
      const internalId = playerData?.internalId || 'unknown';
      remotePlayer.respawn(position);
      logger.info(`Player ${playerId} (internalId: ${internalId}) respawned at ${JSON.stringify(position)}`);
    } else {
      // Create new remote player if they don't exist (shouldn't happen but safety check)
      ensureRemotePlayer(playerId, position, 'onPlayerRespawn');
    }

    // Re-add HUD indicator on respawn (it was removed on kill)
    // The updatePlayerIndicator in the main loop will recreate it automatically
  };

  // Register playerJoined handler (for new players joining after initial connection)
  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }) => {
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === nm().getLocalPlayerId()) return;
    const playerData = nm().getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = deps.terrain().getHeight(position.x, position.z);
    const aboveTerrain = position.y >= terrainHeight;
    logger.info(`Player joined: ${playerId} (internalId: ${internalId}) at ${JSON.stringify(position)} | Terrain height: ${terrainHeight.toFixed(1)} | ${aboveTerrain ? '✓ Above/at terrain' : '✗ BELOW TERRAIN'}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  // Register playerLeft handler — immediate cleanup when server broadcasts playerLeft
  networkManager.onPlayerLeft = (playerId: string) => {
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.dispose();
      deps.world.remotePlayers.delete(playerId);
      deps.hud().removePlayerIndicator(playerId);
      deps.healthBarSystem().removeBar(playerId);
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
  };

  // Register gameState handler (for initial connection and reconnection)
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined) => {
    logger.debug(`gameState received, players: ${players.length}`);

    if (!localPlayerState) return;
    logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);

    const player = deps.player();
    // Restore position and rotation
    player.pos.set(localPlayerState.position.x, localPlayerState.position.y, localPlayerState.position.z);
    deps.setLastSentPos({ x: localPlayerState.position.x, y: localPlayerState.position.y, z: localPlayerState.position.z });
    player.yaw = localPlayerState.rotation.yaw;
    player.pitch = localPlayerState.rotation.pitch;

    // Restore velocity only if it's a gentle drift — the stored value is
    // whatever the last packet before disconnect reported, and replaying a
    // stale knockback/momentum vector on reload produced phantom launches.
    const v = localPlayerState.velocity;
    if (v && Math.hypot(v.x, v.y, v.z) < 10) {
      player.vel.set(v.x, v.y, v.z);
    } else {
      player.vel.set(0, 0, 0);
    }

    // Restore health and death state
    player.health = localPlayerState.health;
    player.isDead = localPlayerState.isDead;
    player.syncMovement(); // reseat controller — restored pos/vel otherwise revert

    // If player was dead, show respawn UI
    deps.hud().setDeathOverlay(player.isDead);
    if (player.isDead) {
      deps.hud().hide();
    } else {
      deps.hud().show();
    }

    logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
  };
}
