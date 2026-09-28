// Player lifecycle wire handlers — hit/kill/respawn/join/leave/update and
// the correction pipeline. Remote visual bookkeeping (debris, indicators,
// health bars) happens here, not in the message switchboard.

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../../core/config.js';
import * as sfx from '../../core/sfx.js';
import { PlayerDebris } from '../../effects/debris.js';
import type { NetCtx } from './ctx.js';

export function wirePlayers(ctx: NetCtx): void {
  wirePlayerCombat(ctx);
  wirePlayerLifecycle(ctx);
}

/** Tribes streak titles by kills-since-death — subtitle under the frag
 *  headline at 3/5/7/10. */
const STREAK_NAMES: [number, string][] = [
  [10, 'GODLIKE'], [7, 'UNSTOPPABLE'], [5, 'RAMPAGE'], [3, 'KILLING SPREE'],
];

/** Hit feedback, knockback, reconciliation, kills — the damage wire. */
function wirePlayerCombat(ctx: NetCtx): void {
  const { deps, networkManager, nm } = ctx;
  const logger = deps.logger;
  let localStreak = 0;

  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number) => {
    if (deps.world.playbackMode) return;
    // Check if local player was hit
    if (targetId === nm().getLocalPlayerId()) {
      const player = deps.lazyPlayer();
      // Shielded hits route to the energy tank (server kept health
      // unchanged) — the soak reads as a cyan flash + hum, not a grunt.
      if (player.isShielded) {
        player.absorbShieldDamage(damage);
        deps.lazyHud().showShieldDamage(deps.world.remotePlayers.get(shooterId)?.pos ?? null, damage);
        sfx.shieldHit();
        player.health = health;
        return;
      }
      player.health = health;
      // Point the damage arc at the shooter's last known position
      deps.lazyHud().showDamage(deps.world.remotePlayers.get(shooterId)?.pos ?? null, damage);
      sfx.playerHurt();
      logger.info(`Local player hit for ${damage} damage by ${shooterId} (health: ${health})`);
      return;
    }

    // Non-lethal hits don't trigger death animation
    logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId} (health: ${health})`);
    deps.lazyHealthBarSystem().spawn(targetId, damage, health);
    deps.world.remotePlayers.get(targetId)?.flinch();
  };

  // Server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean) => {
    if (deps.world.playbackMode) return; // replay owns the camera's body
    const from = new THREE.Vector3(position.x, position.y, position.z);
    const player = deps.lazyPlayer();
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
    // During demo playback corrections fire constantly (recorded positions
    // desync from what the server last accepted) and would warp the replay.
    if (deps.world.playbackMode) return;
    const player = deps.lazyPlayer();
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
    // NEVER touch yaw/pitch — the server echoes our last *accepted*
    // rotation, which can be seconds stale. Aim is client-authoritative;
    // snapping it warps the camera 40-60° for no gameplay reason.
    void rotation;
    player.syncMovement();
  };

  // Declared remote teleport (another player's warp): snap the visual —
  // interpolating across a 50m gap reads as a rocket-flight glitch
  networkManager.onRemoteTeleport = (playerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => {
    const rp = deps.world.remotePlayers.get(playerId);
    if (!rp) return;
    rp.teleportTo(new THREE.Vector3(position.x, position.y, position.z));
    void velocity; // next tick record carries it — no need to touch internals
  };

  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    if (deps.world.playbackMode) return;
    deps.world.killCounts.set(shooterId, (deps.world.killCounts.get(shooterId) ?? 0) + 1);
    // Check if local player was killed
    if (targetId === nm().getLocalPlayerId()) {
      logger.info(`Local player killed by ${shooterId}`);
      const player = deps.lazyPlayer();
      player.isDead = true;
      player.health = 0;
      deps.lazyHud().hide();
      deps.lazyHud().setDeathOverlay(true);
      localStreak = 0;
      deps.fragMessages.show(shooterId === 'environment'
        ? `YOU DIED\n${player.lastDamageSource || 'claimed by the wasteland'}`
        : `YOU DIED\nfragged by ${shooterId}`);
      return;
    }

    // Show frag message if local player got the kill — streak counts
    // run-kills since your last death (reset in the death branch above).
    if (shooterId === nm().getLocalPlayerId()) {
      const streak = ++localStreak;
      const streakName = STREAK_NAMES.find(([n]) => streak >= n)?.[1];
      deps.fragMessages.show(streakName ? `FRAGGED PLAYER!\n${streakName}` : `FRAGGED PLAYER!`);
      sfx.killConfirm();
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
      const debris = new PlayerDebris(deps.lazyScene(), deps.lazyTerrain(), remotePlayer.position.x, remotePlayer.position.y + 1.0, remotePlayer.position.z);
      deps.world.playerDebrisList.push(debris);

      // Hide the model immediately
      remotePlayer.hide();

      // Remove HUD indicator on kill
      deps.lazyHud().removePlayerIndicator(targetId);
      deps.lazyHealthBarSystem().removeBar(targetId);

      logger.info(`Player ${targetId} killed by ${shooterId}`);
    }
  };
}

/** Updates, respawns, join/leave, movement events — the presence wire. */
function wirePlayerLifecycle(ctx: NetCtx): void {
  const { deps, networkManager, nm, ensureRemotePlayer } = ctx;
  const logger = deps.logger;

  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJumpDust(pos);
  };

  networkManager.onPlayerJetpack = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJetpack(pos);
  };

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

  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    if (deps.world.playbackMode) return;
    // Check if local player respawned
    if (playerId === nm().getLocalPlayerId()) {
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      const player = deps.lazyPlayer();
      player.isDead = false;
      player.health = player.maxHealth;
      player.lastDamageSource = ''; // stale attribution shouldn't survive a life
      player.vel.set(0, 0, 0);
      player.pos.set(position.x, position.y, position.z);
      deps.setLastSentPos({ x: position.x, y: position.y, z: position.z });
      player.yaw = rotation.yaw;
      player.pitch = rotation.pitch;
      player.syncMovement(); // reseat controller or its snapshot overwrites the respawn
      player.markTeleport(); // spawn point can sit >50m from the corpse
      deps.lazyHud().show();
      deps.lazyHud().setDeathOverlay(false);
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
  };

  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }) => {
    if (deps.world.playbackMode) return;
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === nm().getLocalPlayerId()) return;
    const playerData = nm().getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = deps.lazyTerrain().getHeight(position.x, position.z);
    const aboveTerrain = position.y >= terrainHeight;
    logger.info(`Player joined: ${playerId} (internalId: ${internalId}) at ${JSON.stringify(position)} | Terrain height: ${terrainHeight.toFixed(1)} | ${aboveTerrain ? '✓ Above/at terrain' : '✗ BELOW TERRAIN'}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  networkManager.onPlayerLeft = (playerId: string) => {
    const remotePlayer = deps.world.remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.dispose();
      deps.world.remotePlayers.delete(playerId);
      deps.lazyHud().removePlayerIndicator(playerId);
      deps.lazyHealthBarSystem().removeBar(playerId);
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
  };
}
