// Server message handlers — registered once inside init(). Each on* callback
// maps a network event to game-state changes (remote player lifecycle,
// server-authoritative projectile spawn/destroy, damage/kill/respawn, snapshots).

import * as THREE from 'three';
import { REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE } from '../core/config.js';
import * as sfx from '../core/sfx.js';
import type { ChildLogger } from '../core/Logger.js';
import type { Player } from '../entities/Player.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { PlayerDebris } from '../effects/debris.js';
import type { EffectsManager } from '../effects/effects.js';
import type { NetworkManager } from '../networking/NetworkManager.js';
import type { GameStatePlayer, LocalPlayerState } from '../../../shared/protocol.js';
import { Projectile } from '../projectiles/Projectile.js';
import { Lobby } from './lobby.js';
import { resolveServerEndpoints } from '../networking/endpoints.js';
import { ROCKET_CONFIG, getProjectileConfig } from '../projectiles/index.js';
import type { WorldState } from './worldState.js';
import type { createEntities } from './entities.js';
import type { FragMessages } from '../ui/FragMessages.js';
import { Chat } from './chat.js';
import type { HUD } from '../ui/hud.js';
import type { HealthBarSystem } from '../ui/HealthBarSystem.js';
import type { ExplosionTracker } from '../utils/ExplosionTracker.js';
import type { Terrain } from '../world/terrain.js';

export interface NetDeps {
  lazyNetworkManager(): NetworkManager;
  lazyScene(): THREE.Scene;
  lazyTerrain(): Terrain;
  lazyPlayer(): Player;
  lazyEffects(): EffectsManager;
  lazyHud(): HUD;
  lazyHealthBarSystem(): HealthBarSystem;
  fragMessages: FragMessages;
  explosionTracker: ExplosionTracker;
  logger: ChildLogger;
  world: WorldState;
  setLastSentPos(pos: { x: number; y: number; z: number }): void;
  entities: () => ReturnType<typeof createEntities>;
}

export function wireNetworkHandlers(deps: NetDeps): void {
  const { logger } = deps;
  const nm = () => deps.lazyNetworkManager();
  const networkManager = deps.lazyNetworkManager();

  // Chat is self-contained (own DOM + key routing) — netHandlers is just
  // where network↔game wiring already lives.
  const chat = new Chat({
    send: (text) => networkManager.sendChat(text),
    isConnected: () => networkManager.isConnected(),
    localName: () => networkManager.getLocalPlayerId(),
  });
  networkManager.onChat = (playerId, text) => chat.add(playerId, text);
  networkManager.onTeamScore = (scores, winAt) => {
    deps.lazyHud().setTeamScore?.(scores.alpha, scores.bravo);
    chat.add(null, `ALPHA ${scores.alpha} : ${scores.bravo} BRAVO  (first to ${winAt})`);
  };
  networkManager.onFfaScore = (scores, winAt) => {
    const me = nm().getLocalPlayerId();
    const mine = scores[me] ?? 0;
    let lead = 0; for (const v of Object.values(scores)) if (v > lead) lead = v;
    // Only announce when the lead changes hands or YOU score — a per-kill
    // feed line for every bot frag would drown the chat.
    if ((scores[me] ?? 0) > 0) chat.add(null, `you: ${mine} pts (leader ${lead}/${winAt})`);
  };
  networkManager.onFfaMatchEnd = (winner, scores) =>
    chat.add(null, `${winner} WINS the deathmatch — ${scores[winner]} pts — new match starting`);
  networkManager.onMatchEnd = (winner, scores) =>
    chat.add(null, `${winner.toUpperCase()} WINS ${scores.alpha}:${scores.bravo} — new match starting`);
  networkManager.onMatchStart = (mode) =>
    chat.add(null, `match start — ${mode || 'arena'}`);

  // Server-owned CTF flags — dumb renderers: pole+banner meshes that just
  // follow flagUpdate positions. All rules live in RoomFlags server-side.
  const flagMeshes = new Map<string, THREE.Group>();
  const ensureFlagMesh = (team: 'alpha' | 'bravo'): THREE.Group => {
    let g = flagMeshes.get(team);
    if (g) return g;
    g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 4, 6),
      new THREE.MeshBasicMaterial({ color: 0x888888 }));
    pole.position.y = 2;
    const banner = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.2, 4),
      new THREE.MeshBasicMaterial({ color: team === 'alpha' ? 0x55aaff : 0xff8855 }));
    banner.position.set(0.55, 3.4, 0);
    g.add(pole, banner);
    deps.lazyScene().add(g);
    flagMeshes.set(team, g);
    return g;
  };
  networkManager.onFlagUpdate = (flags) => {
    for (const f of flags) {
      const g = ensureFlagMesh(f.team);
      g.position.set(f.pos.x, f.pos.y, f.pos.z);
    }
  };

  // Lobby browser — corner button lists the server's live rooms; joining
  // reloads with ?room=NAME (membership is fixed at connect time).
  void resolveServerEndpoints().then(({ httpUrl }) => new Lobby({
    listRooms: async () => {
      const res = await fetch(`${httpUrl}/rooms`);
      if (!res.ok) throw new Error(`rooms ${res.status}`);
      return res.json() as Promise<import('./lobby.js').RoomRow[]>;
    },
  }));

  // Both first-seen-update and respawn-into-missing end up here
  function ensureRemotePlayer(playerId: string, position: { x: number; y: number; z: number }, via: string): RemotePlayer {
    const rp = new RemotePlayer(deps.lazyScene(), playerId, position, deps.lazyTerrain());
    deps.world.remotePlayers.set(playerId, rp);
    logger.debug(`CREATED remote player (${via})`, { instanceId: rp.instanceId, playerId, total: deps.world.remotePlayers.size });
    return rp;
  }

  // Register player hit handler (non-lethal hits)
  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number) => {
    // Check if local player was hit
    if (targetId === nm().getLocalPlayerId()) {
      deps.lazyPlayer().health = health;
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

  // Register knockback handler — server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean) => {
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

  // Register player kill handler (lethal kills)
  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    deps.world.killCounts.set(shooterId, (deps.world.killCounts.get(shooterId) ?? 0) + 1);
    // Check if local player was killed
    if (targetId === nm().getLocalPlayerId()) {
      logger.info(`Local player killed by ${shooterId}`);
      const player = deps.lazyPlayer();
      player.isDead = true;
      player.health = 0;
      deps.lazyHud().hide();
      deps.lazyHud().setDeathOverlay(true);
      deps.fragMessages.show(shooterId === 'environment'
        ? `YOU DIED\n${player.lastDamageSource || 'claimed by the wasteland'}`
        : `YOU DIED\nfragged by ${shooterId}`);
      return;
    }

    // Show frag message if local player got the kill
    if (shooterId === nm().getLocalPlayerId()) {
      deps.fragMessages.show(`FRAGGED PLAYER!`);
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

  // Register jump handler for remote players
  networkManager.onPlayerJump = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJumpDust(pos);
  };

  // Register jetpack handler for remote players
  networkManager.onPlayerJetpack = (_playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    deps.lazyEffects().spawnJetpack(pos);
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
    const remoteProjectile = new Projectile(deps.lazyScene(), origin, dir, new THREE.Vector3(0, 0, 0), cfg);
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
    sfx.shotAt(origin, cfg.weaponType);
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
      const player = deps.lazyPlayer();
      player.isDead = false;
      player.health = 100;
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

    // Re-add HUD indicator on respawn (it was removed on kill)
    // The updatePlayerIndicator in the main loop will recreate it automatically
  };

  // ---- Server-owned creatures (balls) ------------------------------------
  // Events only — the client replays the shared sim between segments.
  networkManager.onBallSpawn = (data) => deps.entities().netBallSpawn(data);
  networkManager.onBallSegment = (data) => deps.entities().netBallSegment(data);
  networkManager.onBallDie = (data) => deps.entities().netBallDie(data);
  networkManager.onBallRoster = (data) => {
    for (const b of data.balls) deps.entities().netBallSpawn(b);
  };

  // Register playerJoined handler (for new players joining after initial connection)
  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }) => {
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === nm().getLocalPlayerId()) return;
    const playerData = nm().getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = deps.lazyTerrain().getHeight(position.x, position.z);
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
      deps.lazyHud().removePlayerIndicator(playerId);
      deps.lazyHealthBarSystem().removeBar(playerId);
      logger.info(`Remote player removed (playerLeft): ${playerId}`);
    }
  };

  // Register gameState handler (for initial connection and reconnection)
  networkManager.onGameState = (players: GameStatePlayer[], localPlayerState: LocalPlayerState | undefined, roomInfo?: { room?: string; mode?: string; team?: 'alpha' | 'bravo'; scores?: { alpha: number; bravo: number }; ffaScores?: Record<string, number> }) => {
    logger.debug(`gameState received, players: ${players.length}`);
    if (roomInfo?.room && roomInfo.room !== 'default') {
      chat.add(null, `joined room '${roomInfo.room}'${roomInfo.mode ? ` (${roomInfo.mode})` : ''} — ${players.length} other player(s)`);
    }
    if (roomInfo?.team) {
      chat.add(null, `you are on ${roomInfo.team.toUpperCase()}${roomInfo.scores ? ` — ALPHA ${roomInfo.scores.alpha} : BRAVO ${roomInfo.scores.bravo}` : ''}`);
    }
    if (roomInfo?.ffaScores && Object.keys(roomInfo.ffaScores).length) {
      const top = Object.entries(roomInfo.ffaScores).sort((a, b) => b[1] - a[1]).slice(0, 3);
      chat.add(null, `dm board — ${top.map(([id, s]) => `${id} ${s}`).join(' / ')}`);
    }

    if (!localPlayerState) return;
    logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);

    const player = deps.lazyPlayer();
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
    deps.lazyHud().setDeathOverlay(player.isDead);
    if (player.isDead) {
      deps.lazyHud().hide();
    } else {
      deps.lazyHud().show();
    }

    logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
  };
}
