import * as THREE from 'three';

import {
  BALL_SPAWN_INTERVAL, BALL_MAX,
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR,
  MAX_DELTA_TIME, REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE,
  NETWORK_BACKEND, PENDING_ROCKET_TIMEOUT
} from './core/config.js';

import { ChildLogger } from './core/Logger.js';
import { StateSnapshot } from './core/StateSnapshot.js';
import { createRenderer } from './core/renderer.js';

import { DemoManager } from './demo/index.js';
import { InputFlags, JetpackFlags, ProjectileEventType, TargetEventType } from './demo/types.js';

import { Ball, pickVariant } from './entities/balls.js';
import { Player } from './entities/Player.js';
import { PlayerDebris } from './entities/PlayerDebris.js';
import { RemotePlayer } from './entities/RemotePlayer.js';

import { BallDebris } from './effects/debris.js';
import { DamageNumberManager } from './effects/damageNumbers.js';
import { EffectsManager } from './effects/effects.js';
import { Explosion } from './effects/explosion.js';
import { Implosion } from './effects/implosion.js';

import { NetworkAdapterFactory } from './networking/NetworkAdapterFactory.js';
import { NetworkManager } from './networking/NetworkManager.js';

import { ROCKET_CONFIG, DISC_CONFIG, GRENADE_CONFIG, getProjectileConfig, computeAccuracy } from './projectiles/index.js';
import { Projectile } from './projectiles/Projectile.js';
import type { ProjectileConfig } from './projectiles/types.js';

import { CoolShotsPanel } from './ui/CoolShotsPanel.js';
import { FragMessages } from './ui/FragMessages.js';
import { HealthBarSystem } from './ui/HealthBarSystem.js';
import { HUD } from './ui/hud.js';

import { ExplosionTracker } from './utils/ExplosionTracker.js';
import { setupInputTracking } from './utils/InputTracking.js';
import { LoadProfiler } from './utils/profiling.js';

import { createScene } from './world/scene.js';
import { loadHeightmap, Terrain } from './world/terrain.js';

const logger = new ChildLogger('Main');

// ---- Demo system ----
let demoManager: DemoManager | null = null;

// ---- Load Time Profiling ----
const profiler = new LoadProfiler();


// ---- Camera ----
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);

// ---- Scene ----
const sceneSetup = createScene();
const { scene, sun } = sceneSetup;

// ---- Renderer ----
const rendererSetup = createRenderer(camera, scene);
const { renderer, composer } = rendererSetup;
renderer.setClearColor(FOG_COLOR);

// ---- Game state ----
let terrain: Terrain;
let player: Player;
let hud: HUD;
let healthBarSystem: HealthBarSystem;
let damageNumberManager: DamageNumberManager;
let networkManager: NetworkManager;
const remotePlayers: Map<string, RemotePlayer> = new Map();
const playersBeingCreated: Set<string> = new Set();
let lastRemotePosLog = '';
const balls: Ball[] = [];
let lastSentPos = { x: 0, y: 0, z: 0 };
const projectiles: Projectile[] = [];
const debrisList: BallDebris[] = [];
const playerDebrisList: PlayerDebris[] = [];
const explosions: Explosion[] = [];
const implosions: Implosion[] = [];
let effects: EffectsManager;

// ---- Playback projectile reconstruction ----
const playbackProjectiles: Projectile[] = [];
const playbackProjectileById = new Map<number, Projectile>();
const playbackBallById = new Map<number, Ball>();
let playbackFrozenWarnCounter = 0;
let seekReconstructing = false;
const playbackProjectileOrigin = new Map<number, THREE.Vector3>();

// Track recent explosions for death impulse calculation
let ballTimer = 0;
let ballSnapshotTimer = 0;

// ---- Input tracking ----
const inputTracking = setupInputTracking(logger);

// ---- Explosion tracking ----
const explosionTracker = new ExplosionTracker();

// ---- Score display ----
const fragMessages = new FragMessages();

// ---- Projectile fire handler ----
const pendingLocalProjectiles: Projectile[] = []; // queue: projectiles waiting for server projectileId
const localProjectileById = new Map<string, Projectile>(); // server projectileId -> local Projectile
const pendingProjectileTimestamps: Map<Projectile, number> = new Map(); // track when projectiles were created

function spawnProjectile(config: ProjectileConfig, e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  if (inputTracking.isTabHidden()) return;
  if (demoManager?.isPlaying) return;

  // INSTANT SHOOTING: Spawn projectile locally immediately for LAN-like feel
  const p = new Projectile(scene, e.origin, e.dir, e.playerVel, config);
  projectiles.push(p);

  if (config.needsServerTracking) {
    pendingLocalProjectiles.push(p);
    pendingProjectileTimestamps.set(p, Date.now());
  }

  // Record projectile fired event for demo
  if (demoManager?.isRecording) {
    const velocity = e.dir.clone().normalize().multiplyScalar(config.speed).addScaledVector(e.playerVel, 0.5);
    p.demoProjectileId = demoManager.recordProjectileFired(
      { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      { x: velocity.x, y: velocity.y, z: velocity.z },
      config.weaponType
    );
  }

  // Send shot to server with projectile position/velocity for tracking
  // Server will validate and confirm/override if needed
  if (config.name === 'rocket') {
    const velocity = e.dir.clone().normalize().multiplyScalar(config.speed);
    networkManager.sendShot(
      null, // no target yet
      { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      { x: velocity.x, y: velocity.y, z: velocity.z }
    );
  }
}

function onFire(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  spawnProjectile(ROCKET_CONFIG, e);
}

function onDisc(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  spawnProjectile(DISC_CONFIG, e);
}

function onGrenade(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  spawnProjectile(GRENADE_CONFIG, e);
}

// ---- Projectile explosion processing (push or pull based on config) ----
function processProjectileExplosion(
  pos: THREE.Vector3,
  radius: number,
  force: number,
  forceMode: 'push' | 'pull',
  aoeDamage: number,
  falloffMultiplier: number,
  collisionMultiplier: number,
  forceMultiplier: number,
  shooterId?: string,
  directHit: boolean = false,
  directHitTargetId?: string | null,
  age: number = 0,
  sendAOE?: (pos: any, targetId: string | null) => void,
  _explosionType: 'rocket' | 'grenade' = 'rocket'
): void {
  if (forceMode === 'push') {
    explosions.push(new Explosion(scene, pos, directHit, age));
  } else {
    implosions.push(new Implosion(scene, pos, age));
  }

  // Record explosion for death impulse calculation
  explosionTracker.addExplosion(pos, force, shooterId || networkManager.getLocalPlayerId());

  const applyToLocal = forceMode === 'push'
    ? (p: THREE.Vector3, f: number) => player.applyKnockback(p, f)
    : (p: THREE.Vector3, f: number) => player.applyPull(p, f);

  // Apply to local player
  const dpx = player.pos.distanceTo(pos);
  if (dpx < radius * falloffMultiplier) {
    const falloff = 1 - dpx / (radius * falloffMultiplier);
    applyToLocal(pos, force * falloff);
  }

  // Apply to balls
  const applyToBall = forceMode === 'push'
    ? (b: Ball, f: number) => b.applyKnockback(pos, f)
    : (b: Ball, f: number) => b.applyPull(pos, f);
  for (const ball of balls) {
    if (ball.dead) continue;
    const db = ball.pos.distanceTo(pos);
    const threshold = forceMode === 'push'
      ? radius + ball.radius
      : radius * collisionMultiplier + ball.radius;
    if (db < threshold) {
      applyToBall(ball, force * forceMultiplier);
    }
  }

  // AOE damage to remote players
  if (networkManager && networkManager.isConnected() && sendAOE) {
    sendAOE(
      { x: pos.x, y: pos.y, z: pos.z },
      directHitTargetId ?? null
    );
  }

  const applyToRemote = forceMode === 'push'
    ? (rp: RemotePlayer, f: number) => rp.applyKnockback(pos, f)
    : (rp: RemotePlayer, f: number) => rp.applyPull(pos, f);
  for (const [playerId, rp] of remotePlayers) {
    if (playerId === directHitTargetId) continue;
    if ((rp as any).isDead) continue;
    const d = rp.position.distanceTo(pos);
    if (d < radius * falloffMultiplier) {
      const falloff = 1 - d / (radius * falloffMultiplier);
      applyToRemote(rp, force * falloff);
      hud.showHitMarker();
      healthBarSystem.predictDamage(playerId, Math.round(aoeDamage * falloff));
    }
  }
}

// ---- Update projectiles ----
function updateProjectiles(dt: number): void {
  // Clean up stale pending projectiles (no server response within timeout)
  const now = Date.now();
  for (let i = pendingLocalProjectiles.length - 1; i >= 0; i--) {
    const p = pendingLocalProjectiles[i];
    const timestamp = pendingProjectileTimestamps.get(p) || 0;
    if (now - timestamp > PENDING_ROCKET_TIMEOUT) {
      pendingLocalProjectiles.splice(i, 1);
      pendingProjectileTimestamps.delete(p);
    }
  }

  // Get remote player positions for collision (skip dead players)
  const remotePlayerPositions = new Map<string, THREE.Vector3>();
  remotePlayers.forEach((rp, playerId) => {
    if ((rp as any).isDead) return;
    remotePlayerPositions.set(playerId, rp.position);
  });

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.update(dt, terrain, balls, remotePlayerPositions);

    if (p.exploded && !p.explosionProcessed) {
      p.explosionProcessed = true;

      // Notify server to destroy tracked projectile
      if (p.serverProjectileId) {
        networkManager.sendProjectileDestroy(p.serverProjectileId);
      }

      processProjectileExplosion(
        p.pos,
        p.explosionRadius,
        p.force,
        p.forceMode,
        p.config.aoeDamage,
        p.config.falloffMultiplier,
        p.config.collisionMultiplier,
        p.config.forceMultiplier,
        undefined,
        p.directHit,
        p.hitPlayerId,
        p.age,
        p.config.name === 'rocket'
          ? (pos, targetId) => networkManager.sendAOEShot(pos, targetId)
          : p.config.name === 'grenade'
            ? (pos, targetId) => networkManager.sendGrenadeAOEShot(pos, targetId)
            : (pos, targetId) => networkManager.sendDiscAOEShot(pos, targetId),
        p.config.name === 'grenade' ? 'grenade' : 'rocket'
      );

      // Record projectile hit for demo (any hit: terrain, ball, or player)
      if (demoManager?.isRecording && p.demoProjectileId) {
        const targetId = p.hitBall ? p.hitBall.id : (p.hitPlayerId ? 0xFFFF : 0);
        demoManager.recordProjectileHit(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, targetId);
      }

      // Log target hits
      if (p.hitBall || p.hitPlayerId) {
        logger.info(`[CoolShot] ${p.config.displayName} hit ${p.hitBall ? 'ball' : 'player'} airtime=${p.hitAge.toFixed(3)}s dist=${p.hitDistance.toFixed(1)} direct=${p.directHit}`);
      }

      // Auto-clip for target hits
      if (demoManager?.isRecording && (p.hitBall || p.hitPlayerId) && p.hitAge > 0.2) {
        demoManager.autoClipOnHit(p.hitAge, 0.2);
      }

      if (p.hitBall) {
        const ball = p.hitBall;
        const destroyed = ball.takeDamage();
        damageNumberManager.spawn(ball.pos, 1, p.config.damageColor, camera);
        if (!destroyed) {
          healthBarSystem.spawnBall(ball, 1, ball.health);
        }
        const acc = computeAccuracy(p.hitAccuracy, p.directHit);
        const dist = p.hitDistance;
        const air = p.hitAge;
        const score = Math.round(acc * dist * air);
        logger.info(`[Hit] Ball direct=${p.directHit} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        if (destroyed) {
          debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
          player.kills++;
        }
        fragMessages.show(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();

        if (demoManager?.isRecording) {
          if (destroyed) {
            demoManager.recordTargetDestroyed(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, ball.variant, ball.health);
          } else {
            demoManager.recordTargetHit(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant, ball.health);
          }
        }
      }

      if (p.hitPlayerId) {
        const targetPlayer = remotePlayers.get(p.hitPlayerId);
        const hitPos = targetPlayer ? targetPlayer.position : player.pos;
        damageNumberManager.spawn(hitPos, 50, p.config.damageColor, camera);
        healthBarSystem.predictDamage(p.hitPlayerId, 50);
        const acc = computeAccuracy(p.hitAccuracy, p.directHit);
        const dist = p.hitDistance;
        const air = p.hitAge;
        const score = Math.round(acc * dist * air);
        logger.info(`[Hit] Player direct=${p.directHit} accRaw=${p.hitAccuracy.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        fragMessages.show(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();
      }

      if (p.hitPlayerId && networkManager) {
        networkManager.sendShot(p.hitPlayerId, { x: p.pos.x, y: p.pos.y, z: p.pos.z }, { x: p.vel.x, y: p.vel.y, z: p.vel.z }, Date.now(), p.serverProjectileId);
        logger.info(`[Shot] Sent to server: player=${p.hitPlayerId} proj=${p.serverProjectileId} direct=${p.directHit} air=${p.hitAge.toFixed(2)}s`);
      }
    }

    if (p.dead) {
      if (demoManager?.isRecording && p.demoProjectileId) {
        demoManager.recordProjectileDestroyed(p.demoProjectileId, { x: p.pos.x, y: p.pos.y, z: p.pos.z });
      }
      p.dispose();
      projectiles.splice(i, 1);
    }
  }
}

// ---- Ball spawning ----
function spawnBall(): void {
  if (demoManager?.isPlaying) return; // skip normal spawning during demo playback
  if (balls.filter(b => !b.dead).length >= BALL_MAX) return;
  const ball = new Ball(scene, terrain, pickVariant());
  balls.push(ball);
  if (demoManager?.isRecording) {
    demoManager.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
    // Keyframe callbacks for demo accuracy
    ball.onBounce = (pos, vel) => {
      demoManager!.recordTargetBounce(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
    ball.onPeak = (pos, vel) => {
      demoManager!.recordTargetPeak(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
  }
}

// Snapshot existing alive balls into the demo recording — needed when recording
// starts after balls are already in the scene (they have no Spawned event yet).
function snapshotExistingBallsForRecording(): void {
  if (!demoManager?.isRecording) return;
  for (const ball of balls) {
    if (ball.dead) continue;
    demoManager.recordTargetSpawned(ball.id, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, ball.variant);
    ball.onBounce = (pos, vel) => {
      demoManager!.recordTargetBounce(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
    ball.onPeak = (pos, vel) => {
      demoManager!.recordTargetPeak(ball.id, { x: pos.x, y: pos.y, z: pos.z }, { x: vel.x, y: vel.y, z: vel.z }, ball.variant);
    };
  }
}

function updateBalls(dt: number): void {
  if (demoManager?.isPlaying) {
    // During playback: only update playback balls, skip live game balls and spawning
    const playbackBallSet = new Set(playbackBallById.values());
    let frozenCount = 0;
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (playbackBallSet.has(b)) {
        b.update(dt, terrain, player.pos);
        // Detect frozen balls (near-zero velocity, not dead, not on ground resting)
        if (!b.dead && b.vel.lengthSq() < 0.01) {
          frozenCount++;
        }
      }
      if ((b as any).disposed) {
        balls.splice(i, 1);
      }
    }
    if (frozenCount > 0) {
      playbackFrozenWarnCounter++;
      if (playbackFrozenWarnCounter <= 5 || playbackFrozenWarnCounter % 60 === 0) {
        console.warn(`[DemoPlayback] ${frozenCount} ball(s) frozen midair (vel~0). Total playback balls: ${playbackBallSet.size}`);
      }
    } else {
      playbackFrozenWarnCounter = 0;
    }
    return;
  }

  ballTimer += dt;
  if (ballTimer >= BALL_SPAWN_INTERVAL) {
    ballTimer = 0;
    spawnBall();
  }

  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.update(dt, terrain, player.pos);
    // Only remove ball when trails have fully faded out
    if ((b as any).disposed) {
      balls.splice(i, 1);
    }
  }

  // Periodic ball position snapshot for demo recording (every 0.5s)
  // This ensures clip snapshots for pre-existing balls are never stale
  if (demoManager?.isRecording) {
    ballSnapshotTimer += dt;
    if (ballSnapshotTimer >= 0.5) {
      ballSnapshotTimer = 0;
      for (const b of balls) {
        if (!b.dead) {
          demoManager.recordTargetPeak(b.id, { x: b.pos.x, y: b.pos.y, z: b.pos.z }, { x: b.vel.x, y: b.vel.y, z: b.vel.z }, b.variant);
        }
      }
    }
  }
}

// ---- Game loop ----
let lastTime = 0;

function loop(time: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min((time - lastTime) / 1000, MAX_DELTA_TIME);
  lastTime = time;

  // Update player physics even when tab is hidden (to keep position changing)
  // Reverted to main-thread physics until terrain can be properly implemented in worker
  player.update(dt);
  terrain.update(player.pos.x, player.pos.z);

  // Send position to server if connected (even when tab is hidden)
  // Don't send position updates while dead or during demo playback
  if (networkManager && networkManager.isConnected() && !player.isDead && !demoManager?.isPlaying) {
    lastSentPos = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    networkManager.sendPosition(
      { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      { yaw: player.yaw, pitch: player.pitch },
      { x: player.vel.x, y: player.vel.y, z: player.vel.z }
    );
    
    // Update remote players (only create from gameState, updates come via onPlayerUpdate)
    const players = networkManager.getPlayers();
    const previousRemoteCount = remotePlayers.size;

    // Update player list UI
    const localPlayerId = networkManager.getLocalPlayerId();
    const playerIds = Array.from(players.keys());
    // Put local player first
    const sortedPlayerIds = [localPlayerId, ...playerIds.filter(id => id !== localPlayerId)];
    hud.updatePlayerList(sortedPlayerIds, localPlayerId);

    // Log remote player positions only when they change
    const remotePositions: string[] = [];
    players.forEach((playerState, playerId) => {
      if (playerId !== networkManager.getLocalPlayerId()) {
        const internalId = playerState.internalId || 'unknown';
        remotePositions.push(`${playerId}[${internalId}]: (${playerState.position.x.toFixed(1)}, ${playerState.position.y.toFixed(1)}, ${playerState.position.z.toFixed(1)})`);
      }
    });
    if (remotePositions.length > 0) {
      const posSummary = remotePositions.join(' | ');
      if (posSummary !== lastRemotePosLog) {
        logger.info(`Remote players: ${posSummary}`);
        lastRemotePosLog = posSummary;
      }
    }

    players.forEach((playerState, playerId) => {
      // Skip local player - don't create RemotePlayer for self
      if (playerId === networkManager.getLocalPlayerId()) {
        return;
      }

      let remotePlayer = remotePlayers.get(playerId);
      if (!remotePlayer && !playersBeingCreated.has(playerId) && !playerState.isDead) {
        playersBeingCreated.add(playerId);
        remotePlayer = new RemotePlayer(scene, playerId, playerState.position, terrain);
        remotePlayers.set(playerId, remotePlayer);
        playersBeingCreated.delete(playerId);
        console.log(`[RemotePlayer] CREATED instanceId=${remotePlayer.instanceId} for playerId=${playerId} (total map size: ${remotePlayers.size})`);
      }
      if (!remotePlayer) return; // Skip if being created by onPlayerUpdate or failed
      // RemotePlayer.update is called via onPlayerUpdate callback to store target position
      // Call tick() every frame for smooth interpolation (includes dead reckoning trigger)
      remotePlayer.tick(dt);
      if (remotePlayer.model && remotePlayer.loaded) {
        remotePlayer.model.update(dt);
      }

      // Update HUD indicator for this player (skip if dead)
      // Use RemotePlayer's extrapolated position for LAN-feel responsiveness
      if (!playerState.isDead) {
        hud.updatePlayerIndicator(playerId, remotePlayer.position, camera, false);
      } else {
        // Explicitly remove indicator if player is dead
        hud.removePlayerIndicator(playerId);
      }
    });

    if (remotePlayers.size !== previousRemoteCount) {
      logger.debug(`Remote players in scene: ${remotePlayers.size} | Scene children: ${scene.children.length}`);
    }
    
    // Remove disconnected players
    for (const [playerId, remotePlayer] of remotePlayers) {
      if (!players.has(playerId)) {
        console.log(`[RemotePlayer] REMOVED (player left) instanceId=${remotePlayer.instanceId} for playerId=${playerId}`);
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
        hud.removePlayerIndicator(playerId);
        healthBarSystem.removeBar(playerId);
      }
      // Remove dead players that have shrunk to 0
      if ((remotePlayer as any).scale === 0) {
        console.log(`[RemotePlayer] REMOVED (scale=0) instanceId=${remotePlayer.instanceId} for playerId=${playerId}`);
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
        hud.removePlayerIndicator(playerId);
        healthBarSystem.removeBar(playerId);
      }
    }
  }
  
  // Sync fog uniforms to terrain shader (all clipmap levels)
  if (scene.fog instanceof THREE.Fog) {
    terrain.updateFog(scene.fog.color, scene.fog.near, scene.fog.far);
  }
  // Update demo system (zero-overhead when idle)
  if (demoManager) demoManager.update(dt);
  const wasFrozen = player.inputFrozen;
  const shouldFreeze = demoManager?.isPlaying ?? false;
  if (shouldFreeze && !wasFrozen) player.freezeInput();
  else if (!shouldFreeze && wasFrozen) player.unfreezeInput();

  const demoPaused = demoManager?.isPaused ?? false;
  if (!demoPaused) updateBalls(dt);
  if (!demoManager?.isPlaying) {
    updateProjectiles(dt);
  }

  // Update playback projectiles (deterministic reconstruction from events)
  if (!demoPaused) {
    for (let i = playbackProjectiles.length - 1; i >= 0; i--) {
      const r = playbackProjectiles[i];
      r.update(dt, terrain);
      if (r.dead) {
        r.dispose();
        playbackProjectiles.splice(i, 1);
        // Remove from map if present
        for (const [id, proj] of playbackProjectileById) {
          if (proj === r) {
            playbackProjectileById.delete(id);
            break;
          }
        }
      }
    }
  }

  if (!demoPaused) {
    effects.update(dt);
    for (let i = debrisList.length - 1; i >= 0; i--) {
      debrisList[i].update(dt);
      if (debrisList[i].dead) { debrisList[i].dispose(); debrisList.splice(i, 1); }
    }
    for (let i = playerDebrisList.length - 1; i >= 0; i--) {
      playerDebrisList[i].update(dt);
      if (playerDebrisList[i].dead) { playerDebrisList[i].dispose(); playerDebrisList.splice(i, 1); }
    }
    for (let i = explosions.length - 1; i >= 0; i--) {
      explosions[i].update(dt);
      if (explosions[i].dead) { explosions[i].dispose(); explosions.splice(i, 1); }
    }
    for (let i = implosions.length - 1; i >= 0; i--) {
      implosions[i].update(dt);
      if (implosions[i].dead) { implosions[i].dispose(); implosions.splice(i, 1); }
    }
  }
  hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());
  healthBarSystem.update(dt, networkManager.getPlayers(), remotePlayers as any, balls);
  damageNumberManager.update(dt);

  // Jetpack particles
  if (!player.onGround && inputTracking.isJetActive()) {
    effects.spawnJetpack(player.pos.clone());
  }

  // Update atmospheric effects
  sceneSetup.update(dt);
  sceneSetup.atmosphericSky.followCamera(camera.position);

  if (rendererSetup.isPostProcessingEnabled()) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }

  // Render damage numbers after post-processing (bypass bloom/contrast for visibility)
  damageNumberManager.update(dt);
}

// ---- Boot ----
async function init(): Promise<void> {
  profiler.markTime('initStart');
  await loadHeightmap('/assets/heightmaps/Vortex_Smooth2_2048.png');
  profiler.markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  profiler.markTime('terrainCreated');

  effects = new EffectsManager(scene);
  effects.setTerrain(terrain);
  profiler.markTime('effectsCreated');

  player = new Player(terrain, camera, scene);
  player.onFire = onFire;
  player.onDisc = onDisc;
  player.onGrenade = onGrenade;
  player.onJump = (pos) => effects.spawnJumpDust(pos);
  player.onJetpack = (pos) => effects.spawnJetpack(pos);
  player.onSki = (pos, vel) => effects.spawnSkiDust(pos, vel);
  profiler.markTime('playerCreated');

  // Initialize networking with selected backend
  const adapter = NetworkAdapterFactory.createAdapter(NETWORK_BACKEND);
  networkManager = new NetworkManager(adapter);
  profiler.markTime('networkInit');

  // Set control object for client-side prediction
  networkManager.setControlObject(player);
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation) => networkManager.sendInputMove(input, rotation);

  // Initialize demo system with player/input data providers
  demoManager = new DemoManager();
  demoManager.setServerUrl('http://localhost:8000');
  demoManager.setDataProviders(
    {
      get posX() { return player.pos.x; },
      get posY() { return player.pos.y; },
      get posZ() { return player.pos.z; },
      get velX() { return player.vel.x; },
      get velY() { return player.vel.y; },
      get velZ() { return player.vel.z; },
      get yaw() { return player.yaw; },
      get pitch() { return player.pitch; },
    },
    {
      get inputFlags() {
        const input = player.getInputState();
        let flags = 0;
        if (input.forward > 0) flags |= InputFlags.Forward;
        if (input.forward < 0) flags |= InputFlags.Backward;
        if (input.right < 0) flags |= InputFlags.Left;
        if (input.right > 0) flags |= InputFlags.Right;
        if (input.jumpHeld) flags |= InputFlags.Jump;
        if (input.skiHeld) flags |= InputFlags.Ski;
        if (input.firePressed) flags |= InputFlags.Fire;
        if (input.discHeld) flags |= InputFlags.Disc;
        return flags;
      },
      get mouseDeltaX() { return 0; },
      get mouseDeltaY() { return 0; },
      get jetpackFlags() {
        return player.getInputState().jetHeld ? JetpackFlags.Active : JetpackFlags.None;
      },
      get jetpackFuel() { return player.energy; },
    }
  );

  // Wire cool shots panel
  new CoolShotsPanel({
    demoManager,
    overlay,
    requestLock,
  });

  // ---- Playback projectile reconstruction ----
  // Handle projectile events from demo playback: spawn projectiles on Fired, explode on Destroyed
  demoManager.onPlaybackEvent = (events: { projectiles: any[], targets: any[] }) => {
    if (seekReconstructing) {
      // Seek reconstruction: re-create all in-flight objects at their state as of the seek time.
      // Skip objects that died before the seek time. Fast-forward in-flight objects to seek time.
      // Suppress all effects (explosions, debris, damage numbers).
      const seekTime = demoManager!.currentTime;

      // Pre-scan: find projectile IDs with terminal events (Hit/Destroyed) — these are dead at seek time
      const deadProjectileIds = new Set<number>();
      for (const ev of events.projectiles) {
        if (ev.eventType === ProjectileEventType.Hit || ev.eventType === ProjectileEventType.Destroyed) {
          deadProjectileIds.add(ev.projectileId);
        }
      }

      // Pre-scan: find ball IDs with Destroyed events — these are dead at seek time
      const deadBallIds = new Set<number>();
      for (const ev of events.targets) {
        if (ev.eventType === TargetEventType.Destroyed) {
          deadBallIds.add(ev.targetId);
        }
      }

      const FF_DT = 1 / 60;

      // Process target events first so balls exist before projectile hits reference them
      for (const ev of events.targets) {
        if (deadBallIds.has(ev.targetId)) {
          // For Destroyed events on dead balls, spawn debris fast-forwarded to seek time
          if (ev.eventType === TargetEventType.Destroyed) {
            const debris = new BallDebris(scene, terrain, ev.posX, ev.posY, ev.posZ, new THREE.Color(0xffffff), 1);
            debrisList.push(debris);
            // Fast-forward debris to seek time
            const ffTime = seekTime - ev.timestamp;
            if (ffTime > 0) {
              let rem = ffTime;
              while (rem > 0 && !debris.dead) {
                const step = Math.min(FF_DT, rem);
                debris.update(step);
                rem -= step;
              }
            }
          }
          continue;
        }

        if (ev.eventType === TargetEventType.Spawned) {
          const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2);
          ball.pos.set(ev.posX, ev.posY, ev.posZ);
          ball.vel.set(ev.velX, ev.velY, ev.velZ);
          playbackBallById.set(ev.targetId, ball);
          balls.push(ball);
          // Sync mesh position immediately (Ball constructor doesn't copy pos to mesh.position)
          ball.update(0, terrain, player.pos);
          // Fast-forward from spawn time to seek time
          const ffTime = seekTime - ev.timestamp;
          let remaining = ffTime;
          while (remaining > 0 && !ball.dead) {
            const step = Math.min(FF_DT, remaining);
            ball.update(step, terrain, player.pos);
            remaining -= step;
          }
        } else if (ev.eventType === TargetEventType.Bounce || ev.eventType === TargetEventType.StateChanged || ev.eventType === TargetEventType.Hit) {
          const ball = playbackBallById.get(ev.targetId);
          if (ball && !ball.dead) {
            ball.pos.set(ev.posX, ev.posY, ev.posZ);
            ball.vel.set(ev.velX, ev.velY, ev.velZ);
            // Sync recorded health for hit keyframes
            if (ev.eventType === TargetEventType.Hit) {
              ball.health = ev.health;
              if (ball.health <= 0) ball.dead = true;
            }
            // Sync mesh position after keyframe update
            ball.update(0, terrain, player.pos);
            // Fast-forward from this keyframe to seek time
            const ffTime = seekTime - ev.timestamp;
            let remaining = ffTime;
            while (remaining > 0 && !ball.dead) {
              const step = Math.min(FF_DT, remaining);
              ball.update(step, terrain, player.pos);
              remaining -= step;
            }
          }
        }
      }

      // Process projectile events in order, skipping dead ones and fast-forwarding in-flight ones
      for (const ev of events.projectiles) {
        if (deadProjectileIds.has(ev.projectileId)) {
          // For Hit events on dead projectiles, spawn explosion fast-forwarded to seek time
          if (ev.eventType === ProjectileEventType.Hit) {
            const hitPos = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
            const exp = new Explosion(scene, hitPos, false, 0);
            explosions.push(exp);
            // Fast-forward explosion visual to seek time
            const ffTime = seekTime - ev.timestamp;
            if (ffTime > 0) {
              const FF_EXP = 1 / 60;
              let rem = ffTime;
              while (rem > 0 && !exp.dead) {
                const step = Math.min(FF_EXP, rem);
                exp.update(step);
                rem -= step;
              }
            }
          }
          continue;
        }

        if (ev.eventType === ProjectileEventType.Fired) {
          const origin = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
          const velocity = new THREE.Vector3(ev.velX, ev.velY, ev.velZ);
          const r = new Projectile(scene, origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), getProjectileConfig(ev.weaponType) ?? ROCKET_CONFIG);
          r.isRemote = true;
          r.spawnedThisFrame = false;
          r.vel.copy(velocity);
          playbackProjectiles.push(r);
          playbackProjectileById.set(ev.projectileId, r);
          // Fast-forward from fired time to seek time
          const ffTime = seekTime - ev.timestamp;
          let remaining = ffTime;
          while (remaining > 0 && !r.dead && !r.exploded) {
            const step = Math.min(FF_DT, remaining);
            r.update(step, terrain);
            remaining -= step;
          }
        } else if (ev.eventType === ProjectileEventType.Bounce) {
          const r = playbackProjectileById.get(ev.projectileId);
          if (r && !r.exploded) {
            r.pos.set(ev.posX, ev.posY, ev.posZ);
            r.vel.set(ev.velX, ev.velY, ev.velZ);
            // Fast-forward from bounce time to seek time
            const ffTime = seekTime - ev.timestamp;
            let remaining = ffTime;
            while (remaining > 0 && !r.dead && !r.exploded) {
              const step = Math.min(FF_DT, remaining);
              r.update(step, terrain);
              remaining -= step;
            }
          }
        }
      }

      seekReconstructing = false;
      return;
    }

    // Normal playback event processing (forward playback, not seeking)
    // Handle target events first so balls are spawned/updated before projectile hits reference them
    for (const ev of events.targets) {
      if (ev.eventType === TargetEventType.Spawned) {
        const ball = new Ball(scene, terrain, ev.targetType as 0 | 1 | 2);
        ball.pos.set(ev.posX, ev.posY, ev.posZ);
        ball.vel.set(ev.velX, ev.velY, ev.velZ);
        // Apply recorded health when available (e.g. synthetic Spawned from a Hit/Bounce snapshot)
        if (ev.health > 0) {
          ball.health = ev.health;
        }
        playbackBallById.set(ev.targetId, ball);
        balls.push(ball);
        // Sync mesh position immediately (Ball constructor doesn't copy pos to mesh.position)
        ball.update(0, terrain, player.pos);
      } else if (ev.eventType === TargetEventType.Bounce) {
        // Snap ball to recorded bounce keyframe to prevent physics drift
        const ball = playbackBallById.get(ev.targetId);
        if (ball && !ball.dead) {
          ball.pos.set(ev.posX, ev.posY, ev.posZ);
          ball.vel.set(ev.velX, ev.velY, ev.velZ);
          ball.update(0, terrain, player.pos);
        }
      } else if (ev.eventType === TargetEventType.StateChanged) {
        // Peak keyframe — snap position and velocity to correct trajectory
        const ball = playbackBallById.get(ev.targetId);
        if (ball && !ball.dead) {
          ball.pos.set(ev.posX, ev.posY, ev.posZ);
          ball.vel.set(ev.velX, ev.velY, ev.velZ);
          ball.update(0, terrain, player.pos);
        }
      } else if (ev.eventType === TargetEventType.Hit) {
        const ball = playbackBallById.get(ev.targetId);
        if (ball && !ball.dead) {
          // Snap ball to recorded hit position to ensure explosion aligns
          ball.pos.set(ev.posX, ev.posY, ev.posZ);
          ball.vel.set(ev.velX, ev.velY, ev.velZ);
          // Flash the ball and then sync to the recorded post-hit health
          ball.takeDamage();
          ball.health = ev.health;
          ball.dead = ball.health <= 0;
          ball.update(0, terrain, player.pos);
          damageNumberManager.spawn(ball.pos, 1, '#ffffff', camera);
        }
      } else if (ev.eventType === TargetEventType.Destroyed) {
        const ball = playbackBallById.get(ev.targetId);
        if (ball && !ball.dead) {
          ball.dead = true;
          debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
        }
      }
    }

    // Process projectile events from demo playback
    for (const ev of events.projectiles) {
      if (ev.eventType === ProjectileEventType.Fired) {
        // Reconstruct projectile from recorded position + velocity, using weaponType
        const origin = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
        const velocity = new THREE.Vector3(ev.velX, ev.velY, ev.velZ);
        const r = new Projectile(scene, origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), getProjectileConfig(ev.weaponType) ?? ROCKET_CONFIG);
        r.isRemote = true;
        r.spawnedThisFrame = false;
        r.vel.copy(velocity);
        playbackProjectiles.push(r);
        playbackProjectileById.set(ev.projectileId, r);
        playbackProjectileOrigin.set(ev.projectileId, origin.clone());
      } else if (ev.eventType === ProjectileEventType.Bounce) {
        // Update projectile velocity to match recorded bounce
        const r = playbackProjectileById.get(ev.projectileId);
        if (r && !r.exploded) {
          r.pos.set(ev.posX, ev.posY, ev.posZ);
          r.vel.set(ev.velX, ev.velY, ev.velZ);
        }
      } else if (ev.eventType === ProjectileEventType.Hit) {
        // Force explode the projectile at the recorded position
        const r = playbackProjectileById.get(ev.projectileId);
        if (r && !r.exploded) {
          r.pos.set(ev.posX, ev.posY, ev.posZ);
          r.explode();

          // Compute accuracy using the recorded target position when available
          const ball = ev.targetId && ev.targetId !== 0xFFFF ? playbackBallById.get(ev.targetId) : undefined;
          let directHit = false;
          let accRaw = 0;
          if (ball) {
            const distToBall = r.pos.distanceTo(ball.pos);
            directHit = distToBall <= ball.radius + r.config.bodyRadius;
            accRaw = Math.max(0, distToBall - ball.radius);
          } else if (ev.targetId === 0xFFFF) {
            // Player hit: no specific target in playback, use fallback max accuracy
            directHit = false;
            accRaw = 0;
          }
          const acc = computeAccuracy(accRaw, directHit);

          // Spawn correct effect (explosion for push, implosion for pull)
          if (r.config.forceMode === 'push') {
            explosions.push(new Explosion(scene, r.pos, directHit, r.age));
          } else {
            implosions.push(new Implosion(scene, r.pos, r.age));
          }

          // Compute frag message from playback data (skip terrain hits)
          const origin = playbackProjectileOrigin.get(ev.projectileId);
          if (origin && ev.targetId !== 0) {
            const dist = r.pos.distanceTo(origin);
            const air = r.age;
            const score = Math.round(acc * dist * air);
            fragMessages.show(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
            hud.showHitMarker();
          }

          // Debug: compare projectile hit position with ball position
          if (ball) {
            const distBall = r.pos.distanceTo(ball.pos);
            console.log(`[DemoPlayback] Projectile Hit: projPos=(${ev.posX.toFixed(1)},${ev.posY.toFixed(1)},${ev.posZ.toFixed(1)}) ballPos=(${ball.pos.x.toFixed(1)},${ball.pos.y.toFixed(1)},${ball.pos.z.toFixed(1)}) dist=${distBall.toFixed(1)}m`);
          } else if (ev.targetId && ev.targetId !== 0xFFFF && ev.targetId !== 0) {
            console.log(`[DemoPlayback] Projectile Hit: projPos=(${ev.posX.toFixed(1)},${ev.posY.toFixed(1)},${ev.posZ.toFixed(1)}) ball ${ev.targetId} not found`);
          }
        }
      } else if (ev.eventType === ProjectileEventType.Destroyed) {
        // Remove projectile without explosion (e.g. timeout)
        const r = playbackProjectileById.get(ev.projectileId);
        if (r && !r.exploded) {
          r.pos.set(ev.posX, ev.posY, ev.posZ);
          r.explode();
        }
      }
    }
  };
  demoManager.onPlaybackState = (state) => {
    if (demoManager?.isPlaying) {
      player.pos.set(state.posX, state.posY, state.posZ);
      player.vel.set(state.velX, state.velY, state.velZ);
      player.yaw = state.yaw;
      player.pitch = state.pitch;
    }
  };

  // Demo playback ends — just pause, keep objects visible (frozen)
  demoManager.onPlaybackEnd = () => {
    // No cleanup — objects stay visible as if user pressed pause.
    // Cleanup happens when user explicitly stops playback via ESC.
  };

  // User explicitly stops playback (ESC, UI stop button) — full cleanup
  demoManager.onPlaybackStop = () => {
    for (const r of playbackProjectiles) {
      r.dispose();
    }
    playbackProjectiles.length = 0;
    playbackProjectileById.clear();
    playbackProjectileOrigin.clear();
    for (const ball of playbackBallById.values()) {
      ball.dispose();
      const idx = balls.indexOf(ball);
      if (idx >= 0) balls.splice(idx, 1);
    }
    playbackBallById.clear();
    for (const d of debrisList) { d.dispose(); }
    debrisList.length = 0;
    for (const e of explosions) { e.dispose(); }
    explosions.length = 0;
    for (const i of implosions) { i.dispose(); }
    implosions.length = 0;
    for (const d of playerDebrisList) { d.dispose(); }
    playerDebrisList.length = 0;
    // Show overlay menu so user can replay or pick another clip
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();
    }
    overlay.style.display = 'flex';
    demoManager?.fetchCoolShotsFromServer();
    // Resume recording for new cool shots
    demoManager?.startRecording();
    snapshotExistingBallsForRecording();
  };

  // Clear live game objects when playback starts so they don't hang frozen in the scene
  demoManager.onPlaybackStart = () => {
    // Dispose all non-playback balls (live game balls)
    const playbackBallSet = new Set(playbackBallById.values());
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (!playbackBallSet.has(b)) {
        b.dispose();
        balls.splice(i, 1);
      }
    }
    // Clear live projectiles
    for (const r of projectiles) {
      r.dispose();
    }
    projectiles.length = 0;
    // Clear live projectiles
    for (const d of projectiles) {
      d.dispose();
    }
    projectiles.length = 0;
    // Clear explosions, implosions, debris
    for (const e of explosions) e.dispose();
    explosions.length = 0;
    for (const e of implosions) e.dispose();
    implosions.length = 0;
    for (const d of debrisList) d.dispose();
    debrisList.length = 0;
    for (const d of playerDebrisList) d.dispose();
    playerDebrisList.length = 0;
  };

  // Clear playback projectiles on seek so they don't get orphaned
  demoManager.onPlaybackSeek = () => {
    seekReconstructing = true;
    for (const r of playbackProjectiles) {
      r.dispose();
    }
    playbackProjectiles.length = 0;
    playbackProjectileById.clear();
    playbackProjectileOrigin.clear();
    for (const ball of playbackBallById.values()) {
      ball.dispose();
      const idx = balls.indexOf(ball);
      if (idx >= 0) balls.splice(idx, 1);
    }
    playbackBallById.clear();
    // Clear debris, explosions, implosions so they can be reconstructed from events
    for (const d of debrisList) { d.dispose(); }
    debrisList.length = 0;
    for (const e of explosions) { e.dispose(); }
    explosions.length = 0;
    for (const i of implosions) { i.dispose(); }
    implosions.length = 0;
    for (const d of playerDebrisList) { d.dispose(); }
    playerDebrisList.length = 0;
  };

  hud = new HUD();
  healthBarSystem = new HealthBarSystem(camera);
  damageNumberManager = new DamageNumberManager(scene);
  profiler.markTime('hudCreated');

  // Load player model
  await player.loadModel();
  profiler.markTime('playerModelLoaded');
  
  // Register player hit handler (non-lethal hits)
  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number, health: number) => {
    // Check if local player was hit
    if (targetId === networkManager.getLocalPlayerId()) {
      player.health = health;
      logger.info(`Local player hit for ${damage} damage by ${shooterId} (health: ${health})`);
      return;
    }

    // Non-lethal hits don't trigger death animation
      logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId} (health: ${health})`);
      healthBarSystem.spawn(targetId, damage, health);
  };

  // Register knockback handler — server tells us to apply knockback/pull to our local player
  networkManager.onKnockback = (position: { x: number; y: number; z: number }, force: number, pull?: boolean) => {
    const from = new THREE.Vector3(position.x, position.y, position.z);
    if (pull) {
      player.applyPull(from, force);
    } else {
      player.applyKnockback(from, force);
    }
  };

  // Register player kill handler (lethal kills)
  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    // Check if local player was killed
    if (targetId === networkManager.getLocalPlayerId()) {
      console.log(`💀 YOU WERE KILLED by ${shooterId}`);
      logger.info(`Local player killed by ${shooterId}`);
      player.isDead = true;
      player.health = 0;
      hud.hide();
      return;
    }

    // Show frag message if local player got the kill
    if (shooterId === networkManager.getLocalPlayerId()) {
      fragMessages.show(`FRAGGED PLAYER!`);
    }

    // Mark player as dead in NetworkManager immediately so main loop knows
    const playerData = networkManager.getPlayers().get(targetId);
    if (playerData) {
      playerData.isDead = true;
      playerData.health = 0;
    }

    const remotePlayer = remotePlayers.get(targetId);
    if (remotePlayer) {
      // Find matching explosion from this shooter
      let explosionPos: THREE.Vector3 | undefined;
      let explosionForce: number | undefined;
      for (const exp of explosionTracker.getRecentExplosions()) {
        if (exp.shooterId === shooterId) {
          explosionPos = exp.position;
          explosionForce = exp.force;
          break;
        }
      }

      // Play death animation (ragdoll physics with explosion impulse)
      remotePlayer.playDeath(explosionPos, explosionForce);

      // Spawn player debris at player center (position is feet, so add half height)
      const debris = new PlayerDebris(scene, terrain, remotePlayer.position.x, remotePlayer.position.y + 1.0, remotePlayer.position.z);
      playerDebrisList.push(debris);

      // Hide the model immediately
      remotePlayer.hide();

      // Remove HUD indicator on kill
      hud.removePlayerIndicator(targetId);
      healthBarSystem.removeBar(targetId);

      logger.info(`Player ${targetId} killed by ${shooterId}`);
    }
  };

  // Register jump handler for remote players
  networkManager.onPlayerJump = (playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    effects.spawnJumpDust(pos);
  };

  // Register jetpack handler for remote players
  networkManager.onPlayerJetpack = (playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    effects.spawnJetpack(pos);
  };

  // Register player update handler for remote players
  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, _timestamp: number, velocity?: { x: number; y: number; z: number }) => {
    // Safety: never process local player as a remote player
    if (playerId === networkManager.getLocalPlayerId()) return;
    let remotePlayer = remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, networkManager.getPing(), velocity);
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
    } else {
      // Check if we're already creating this player (prevent race condition duplicates)
      if (playersBeingCreated.has(playerId)) {
        logger.debug(`onPlayerUpdate called for player ${playerId} already being created, skipping`);
        return;
      }
      // Don't create RemotePlayer for dead players — wait for respawn event
      const playerData = networkManager.getPlayers().get(playerId);
      if (playerData?.isDead) return;
      playersBeingCreated.add(playerId);
      logger.debug(`onPlayerUpdate called for unknown player: ${playerId}, creating...`);
      remotePlayer = new RemotePlayer(scene, playerId, position, terrain);
      remotePlayers.set(playerId, remotePlayer);
      console.log(`[RemotePlayer] CREATED (onPlayerUpdate) instanceId=${remotePlayer.instanceId} for playerId=${playerId} (total map size: ${remotePlayers.size})`);
      playersBeingCreated.delete(playerId);
    }
  };

  // Server-authoritative projectile handlers
  const remoteProjectiles = new Map<string, Projectile>();

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => {
    // For own projectiles: link the pending local projectile to this server ID
    if (ownerId === networkManager.getLocalPlayerId()) {
      const localProjectile = pendingLocalProjectiles.shift();
      if (localProjectile) {
        localProjectile.serverProjectileId = projectileId;
        localProjectileById.set(projectileId, localProjectile);
        pendingProjectileTimestamps.delete(localProjectile); // Clean up timestamp
      }
      return;
    }

    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.clone().normalize();
    const remoteProjectile = new Projectile(scene, origin, dir, new THREE.Vector3(0, 0, 0), ROCKET_CONFIG);
    remoteProjectile.vel.copy(vel); // override with exact server velocity
    remoteProjectile.isRemote = true;
    remoteProjectile.spawnedThisFrame = false; // remote projectiles don't need first-frame skip
    projectiles.push(remoteProjectile);
    remoteProjectiles.set(projectileId, remoteProjectile);
  };

  networkManager.onProjectileDestroyed = (projectileId: string) => {
    // Kill remote projectile (explode so trail particles fade out naturally)
    const remoteProjectile = remoteProjectiles.get(projectileId);
    if (remoteProjectile) {
      remoteProjectile.explode();
      // Don't delete from remoteProjectiles - let it fade out naturally
    }
    // Kill local projectile if server says it's gone - explode to let trails fade
    const localProjectile = localProjectileById.get(projectileId);
    if (localProjectile) {
      localProjectile.explode();
      localProjectileById.delete(projectileId);
      // Also remove from pending queue if it's still there (shouldn't happen but defensive)
      const pendingIndex = pendingLocalProjectiles.indexOf(localProjectile);
      if (pendingIndex !== -1) {
        pendingLocalProjectiles.splice(pendingIndex, 1);
        pendingProjectileTimestamps.delete(localProjectile);
      }
    }
  };
  
  // Register player respawn handler
  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    // Check if local player respawned
    if (playerId === networkManager.getLocalPlayerId()) {
      console.log(`✨ YOU RESPAWNED at ${JSON.stringify(position)}`);
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      player.isDead = false;
      player.health = 100;
      player.vel.set(0, 0, 0);
      player.pos.set(position.x, position.y, position.z);
      lastSentPos = { x: position.x, y: position.y, z: position.z };
      player.yaw = rotation.yaw;
      player.pitch = rotation.pitch;
      hud.show();
      return;
    }

    // Reset existing remote player on respawn
    const remotePlayer = remotePlayers.get(playerId);
    if (remotePlayer) {
      const playerData = networkManager.getPlayers().get(playerId);
      const internalId = playerData?.internalId || 'unknown';
      remotePlayer.respawn(position);
      logger.info(`Player ${playerId} (internalId: ${internalId}) respawned at ${JSON.stringify(position)}`);
    } else {
      // Create new remote player if they don't exist (shouldn't happen but safety check)
      const newRemotePlayer = new RemotePlayer(scene, playerId, position, terrain);
      remotePlayers.set(playerId, newRemotePlayer);
      console.log(`[RemotePlayer] CREATED (onPlayerRespawn) instanceId=${newRemotePlayer.instanceId} for playerId=${playerId}`);
    }

    // Re-add HUD indicator on respawn (it was removed on kill)
    // The updatePlayerIndicator in the main loop will recreate it automatically
  };
  
  // Register playerJoined handler (for new players joining after initial connection)
  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, _rotation: { yaw: number; pitch: number }) => {
    // Safety: server excludes self from playerJoined broadcast, but guard anyway
    if (playerId === networkManager.getLocalPlayerId()) return;
    const playerData = networkManager.getPlayers().get(playerId);
    const internalId = playerData?.internalId || 'unknown';
    const terrainHeight = terrain.getHeight(position.x, position.z);
    const aboveTerrain = position.y >= terrainHeight;
    logger.info(`Player joined: ${playerId} (internalId: ${internalId}) at ${JSON.stringify(position)} | Terrain height: ${terrainHeight.toFixed(1)} | ${aboveTerrain ? '✓ Above/at terrain' : '✗ BELOW TERRAIN'}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  // Register gameState handler (for initial connection and reconnection)
  networkManager.onGameState = (players: any[], localPlayerState: any) => {
    logger.debug(`gameState received, players: ${players.length}`);

    if (localPlayerState) {
      logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);

      // Restore position and rotation
      player.pos.set(localPlayerState.position.x, localPlayerState.position.y, localPlayerState.position.z);
      lastSentPos = { x: localPlayerState.position.x, y: localPlayerState.position.y, z: localPlayerState.position.z };
      player.yaw = localPlayerState.rotation.yaw;
      player.pitch = localPlayerState.rotation.pitch;

      // Restore velocity if available
      if (localPlayerState.velocity) {
        player.vel.set(localPlayerState.velocity.x, localPlayerState.velocity.y, localPlayerState.velocity.z);
      }

      // Restore health and death state
      player.health = localPlayerState.health;
      player.isDead = localPlayerState.isDead;

      // If player was dead, show respawn UI
      if (player.isDead) {
        hud.hide();
      } else {
        hud.show();
      }

      logger.debug(`Player state restored from gameState - pos(${localPlayerState.position.x.toFixed(1)},${localPlayerState.position.y.toFixed(1)},${localPlayerState.position.z.toFixed(1)}) vel(${localPlayerState.velocity?.x.toFixed(1) || 0},${localPlayerState.velocity?.y.toFixed(1) || 0},${localPlayerState.velocity?.z.toFixed(1) || 0}) health:${localPlayerState.health} dead:${localPlayerState.isDead}`);
    }
  };

  // Connect to server (non-blocking for offline mode)
  const serverUrl = 'ws://localhost:8000/ws';
  profiler.markTime('networkConnectStart');
  networkManager.connect(serverUrl).then(() => {
    profiler.markTime('networkConnected');
    logger.info(`Connected to server at ${serverUrl} using ${NETWORK_BACKEND} backend`);
  }).catch((error) => {
    logger.error('Failed to connect to server', error);
  });

  // Initial balls
  for (let i = 0; i < 8; i++) spawnBall();

  // Auto-start demo recording so cool shots are captured seamlessly
  demoManager?.startRecording();
  snapshotExistingBallsForRecording();
  profiler.markTime('initComplete');

  profiler.printSummary();

  requestAnimationFrame(loop);
}

// ---- Overlay / pointer-lock helpers ----
const overlay = document.getElementById('overlay')!;
let gameStarted = false;
let unlockByEscape = false;

function requestLock(): void {
  const p = renderer.domElement.requestPointerLock();
  if (p && typeof (p as Promise<void>).catch === 'function') {
    (p as Promise<void>).catch(() => {
      logger.info('Pointer lock on cooldown — browser requires a brief delay after exiting lock. Click again to re-enter.');
    });
  }
}

document.addEventListener('pointerlockchange', () => {
  logger.debug(`Pointer lock changed: locked=${document.pointerLockElement === renderer.domElement}`);
  if (document.pointerLockElement === renderer.domElement) {
    overlay.style.display = 'none';
    unlockByEscape = false;
  } else if (gameStarted && unlockByEscape) {
    overlay.style.display = 'flex';
    demoManager?.onCoolShotsChanged?.(demoManager.getCoolShots());
    demoManager?.fetchCoolShotsFromServer();
  }
});

document.addEventListener('keydown', (e) => {
  if (demoManager?.isPlaying && e.code !== 'Escape' && e.code !== 'F6' &&
      e.code !== 'ArrowUp' && e.code !== 'ArrowDown' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') {
    return;
  }
  if (demoManager?.isPlaying) {
    if (e.code === 'ArrowUp') {
      e.preventDefault();
      demoManager.togglePlayPause();
      return;
    }
    if (e.code === 'ArrowDown') {
      e.preventDefault();
      demoManager.restart();
      return;
    }
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      demoManager.seekBy(-2);
      return;
    }
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      demoManager.seekBy(2);
      return;
    }
  }
  if (e.code === 'Escape' && gameStarted) {
    if (demoManager?.isPlaying) {
      demoManager.stopPlayback();
      return;
    }
    if (document.pointerLockElement === renderer.domElement) {
      unlockByEscape = true;
      document.exitPointerLock();
      overlay.style.display = 'flex';
      demoManager?.onCoolShotsChanged?.(demoManager.getCoolShots());
      demoManager?.fetchCoolShotsFromServer();
    } else if (overlay.style.display === 'flex' && document.pointerLockElement !== renderer.domElement) {
      overlay.style.display = 'none';
      logger.debug('Requesting pointer lock...');
      requestLock();
    } else if (document.pointerLockElement !== renderer.domElement) {
      overlay.style.display = 'flex';
    }
  }
  if (e.code === 'F4') {
    const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
    pixelToggleBtn.click();
  }
  if (e.code === 'F6') {
    if (demoManager) demoManager.toggleUI();
  }
  if (e.code === 'Space' && demoManager?.isLoadedForPlayback) {
    e.preventDefault();
    demoManager.togglePlayPause();
    return;
  }
});

document.getElementById('start-btn')!.addEventListener('click', () => {
  if (demoManager?.isPlaying) { demoManager.stopPlayback(); return; }
  requestLock();
});
renderer.domElement.addEventListener('click', () => {
  if (demoManager?.isPlaying) return;
  if (document.pointerLockElement !== renderer.domElement) requestLock();
});

// Hoisted for use in both init() and window-scope debug functions
let pendingServerSnapshot: ((players: any[], timestamp: number) => void) | null = null;

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
init().then(() => {
  gameStarted = true;

  // Fetch cool shots from server so they're shown in the initial overlay
  demoManager?.fetchCoolShotsFromServer();

  // Register snapshot handler after network manager is created
  if (networkManager) {
    networkManager.onSnapshot = (players: any[], timestamp: number) => {
      if (pendingServerSnapshot) {
        pendingServerSnapshot(players, timestamp);
        pendingServerSnapshot = null;
      }
    };

    // Auto state hash comparison
    let hashCheckCount = 0;
    let hashMismatchCount = 0;
    let lastSnapshotRequest = 0;
    const SNAPSHOT_COOLDOWN_MS = 5000; // Don't request snapshots more often than every 5s
    const POSITION_TOLERANCE = 50.0; // Warn if position delta exceeds this (higher for async snapshot comparison)

    networkManager.onStateHash = (serverHash: string, tick: number, playerCount: number, _timestamp: number) => {
      hashCheckCount++;

      // Build the same hash the server computes
      const allPlayers: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }> = new Map();

      // Local player - use last position sent to server, not current physics position
      // The server only knows what we've sent, so using player.pos would always be ahead
      allPlayers.set(networkManager.getLocalPlayerId(), {
        x: lastSentPos.x,
        y: lastSentPos.y,
        z: lastSentPos.z,
        health: player.health,
        isDead: player.isDead,
      });

      // Remote players - use NetworkManager stored positions (raw server data) for hash
      // Include ALL known players from NetworkManager, not just those with RemotePlayer instances
      // (players may be known but not yet rendered if model is still loading)
      for (const [id, playerData] of networkManager.getPlayers()) {
        if (id === networkManager.getLocalPlayerId()) continue; // Skip local player
        const rp = remotePlayers.get(id);
        const storedPos = playerData?.position;
        allPlayers.set(id, {
          x: storedPos?.x ?? rp?.position.x ?? 0,
          y: storedPos?.y ?? rp?.position.y ?? 0,
          z: storedPos?.z ?? rp?.position.z ?? 0,
          health: playerData?.health ?? 100,
          isDead: playerData?.isDead ?? (rp as any)?.isDead ?? false,
        });
      }

      // Compute hash using same djb2 algorithm as server
      const sortedIds = Array.from(allPlayers.keys()).sort();
      const playerData = sortedIds.map(id => {
        const p = allPlayers.get(id)!;
        return `${id}:${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}:${p.health}:${p.isDead ? 1 : 0}`;
      }).join('|');

      let localHash = 5381;
      for (let i = 0; i < playerData.length; i++) {
        localHash = ((localHash << 5) + localHash) + playerData.charCodeAt(i);
      }
      const localHashStr = (localHash >>> 0).toString(16);

      const match = localHashStr === serverHash;

      if (match) {
        logger.debug(`[StateHash] OK tick=${tick} hash=${serverHash} players=${playerCount}`);
      } else {
        hashMismatchCount++;
        logger.debug(`[StateHash] MISMATCH tick=${tick} server=${serverHash} client=${localHashStr} input=${playerData}`);
        const now = Date.now();

        // Only do detailed snapshot comparison if enough time has passed
        if (now - lastSnapshotRequest < SNAPSHOT_COOLDOWN_MS) {
          logger.debug(`[StateHash] MISMATCH tick=${tick} (cooldown, skipping detailed check)`);
          return;
        }
        lastSnapshotRequest = now;

        // Request full snapshot from server for detailed comparison
        const clientPlayers = new Map(allPlayers);
        networkManager.sendSnapshotRequest();

        pendingServerSnapshot = (serverPlayers: any[], _ts: number) => {
          const serverMap = new Map<string, any>();
          for (const p of serverPlayers) {
            serverMap.set(p.id, p);
          }

          const significantDiffs: string[] = [];
          const allIds = new Set([...serverMap.keys(), ...clientPlayers.keys()]);

          for (const id of allIds) {
            const cp = clientPlayers.get(id);
            const sp = serverMap.get(id);

            if (!cp && sp) {
              significantDiffs.push(`Player ${id} on server but not client`);
              continue;
            }
            if (cp && !sp) {
              significantDiffs.push(`Player ${id} on client but not server`);
              continue;
            }
            if (!cp || !sp) continue;

            const dx = Math.abs(cp.x - sp.position.x);
            const dy = Math.abs(cp.y - sp.position.y);
            const dz = Math.abs(cp.z - sp.position.z);
            const maxDelta = Math.max(dx, dy, dz);

            if (maxDelta > POSITION_TOLERANCE) {
              significantDiffs.push(
                `Player ${id} position delta=(${dx.toFixed(1)},${dy.toFixed(1)},${dz.toFixed(1)})`
              );
            }

            if (Math.abs(cp.health - sp.health) > 0) {
              significantDiffs.push(`Player ${id} health: client=${cp.health} server=${sp.health}`);
            }
            if (cp.isDead !== sp.isDead) {
              significantDiffs.push(`Player ${id} isDead: client=${cp.isDead} server=${sp.isDead}`);
            }
          }

          if (significantDiffs.length > 0) {
            logger.warn(`[StateHash] DESYNC DETECTED tick=${tick} hash=${serverHash} vs ${localHashStr} | ${significantDiffs.join('; ')}`, {
              checks: hashCheckCount,
              mismatches: hashMismatchCount,
              matchRate: `${((1 - hashMismatchCount / hashCheckCount) * 100).toFixed(1)}%`,
            });
          } else {
            logger.info(`[StateHash] Hash mismatch tick=${tick} but positions within tolerance (network lag)`);
          }
        };
      }
    };
  }
});

// Expose snapshot functions globally for debugging
if (typeof window !== 'undefined') {

  (window as any).takeClientSnapshot = () => {
    const playerMap = new Map();
    playerMap.set('local', {
      position: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      velocity: { x: player.vel.x, y: player.vel.y, z: player.vel.z },
      health: player.health,
      isDead: player.isDead,
      rotation: { yaw: player.yaw, pitch: player.pitch }
    });
    
    for (const [id, rp] of remotePlayers) {
      playerMap.set(id, {
        position: { x: rp.position.x, y: rp.position.y, z: rp.position.z },
        velocity: { x: 0, y: 0, z: 0 },
        health: 100,
        isDead: (rp as any).isDead || false,
        rotation: { yaw: rp.rotation.yaw, pitch: rp.rotation.pitch }
      });
    }
    
    const snapshot = StateSnapshot.create(playerMap, [...projectiles], 'client');
    StateSnapshot.save(snapshot);
    logger.info('Client snapshot taken');
    return snapshot;
  };
  
  (window as any).requestServerSnapshot = () => {
    if (networkManager && networkManager.isConnected()) {
      networkManager.sendSnapshotRequest();
      logger.info('Requested server snapshot');
    } else {
      logger.warn('Not connected - cannot request server snapshot');
    }
  };
  
  (window as any).exportClientSnapshots = () => {
    StateSnapshot.exportSnapshots();
  };

  (window as any).compareState = () => {
    if (!networkManager || !networkManager.isConnected()) {
      logger.warn('Not connected');
      return;
    }

    const clientSnapshot = (window as any).takeClientSnapshot();
    logger.info('Client snapshot hash:', clientSnapshot.hash);

    pendingServerSnapshot = (serverPlayers: any[], _timestamp: number) => {
      const serverPlayerMap = new Map<string, any>();
      for (const p of serverPlayers) {
        serverPlayerMap.set(p.id, {
          id: p.id,
          position: p.position,
          velocity: p.velocity,
          health: p.health,
          isDead: p.isDead,
          rotation: p.rotation,
        });
      }

      const serverSnapshot = StateSnapshot.create(serverPlayerMap, [], 'server');
      StateSnapshot.save(serverSnapshot);

      const result = StateSnapshot.compare(clientSnapshot, serverSnapshot);

      logger.info('=== STATE COMPARISON ===');
      logger.info(`Hash match: ${result.hashMatch}`);
      logger.info(`Client hash: ${clientSnapshot.hash}`);
      logger.info(`Server hash: ${serverSnapshot.hash}`);

      if (result.playerDifferences.length > 0) {
        logger.warn(`Player differences (${result.playerDifferences.length}):`);
        for (const diff of result.playerDifferences) {
          logger.warn(`  ${diff}`);
        }
      } else {
        logger.info('No player differences found');
      }

      if (result.projectileDifferences.length > 0) {
        logger.warn(`Projectile differences (${result.projectileDifferences.length}):`);
        for (const diff of result.projectileDifferences) {
          logger.warn(`  ${diff}`);
        }
      } else {
        logger.info('No projectile differences found');
      }

      // Log per-player detail table
      logger.info('=== PLAYER DETAIL ===');
      const allIds = new Set([...serverPlayerMap.keys(), ...clientSnapshot.players.keys()]);
      for (const id of allIds) {
        const cp = clientSnapshot.players.get(id);
        const sp = serverPlayerMap.get(id);
        if (!cp || !sp) {
          logger.info(`  ${id}: ${cp ? 'client only' : 'server only'}`);
          continue;
        }
        const dx = (cp.position.x - sp.position.x).toFixed(2);
        const dy = (cp.position.y - sp.position.y).toFixed(2);
        const dz = (cp.position.z - sp.position.z).toFixed(2);
        const healthMatch = cp.health === sp.health ? 'OK' : `client=${cp.health} server=${sp.health}`;
        const deadMatch = cp.isDead === sp.isDead ? 'OK' : `client=${cp.isDead} server=${sp.isDead}`;
        const posMatch = (dx === '0.00' && dy === '0.00' && dz === '0.00') ? 'OK' : `delta=(${dx},${dy},${dz})`;
        logger.info(`  ${id}: pos=${posMatch} health=${healthMatch} dead=${deadMatch}`);
      }

      return result;
    };

    networkManager.sendSnapshotRequest();
    logger.info('CompareState: requested server snapshot, waiting for response...');
  };
  
  logger.info('Client snapshot functions available: takeClientSnapshot(), requestServerSnapshot(), compareState(), exportClientSnapshots()');
}
