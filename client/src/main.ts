import * as THREE from 'three';
import { AtmosphericSky } from './atmosphericSky.js';
import { VolumetricClouds } from './volumetricClouds.js';
import { loadHeightmap, Terrain } from './terrain.js';
import { Player } from './Player.js';
import { Ball, pickVariant } from './balls.js';
import { Rocket } from './rocket.js';
import { Disc } from './disc.js';
import { EffectsManager } from './effects.js';
import { HUD } from './hud.js';
import { BallDebris } from './debris.js';
import { Explosion } from './explosion.js';
import { Implosion } from './implosion.js';
import { RemotePlayer } from './RemotePlayer.js';
import { PlayerDebris } from './PlayerDebris.js';
import { NetworkManager } from './networking/NetworkManager.js';
import { NetworkAdapterFactory } from './networking/NetworkAdapterFactory.js';
import { ChildLogger } from './Logger.js';
import { StateSnapshot } from './StateSnapshot.js';
import {
  ROCKET_SPEED, HIT_MAX, BALL_SPAWN_INTERVAL, BALL_MAX,
  PIXEL_SCALE, RENDERER_PIXEL_RATIO,
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR, FOG_DENSITY,
  SKY_TURBIDITY, SKY_RAYLEIGH, SKY_MIE_COEFFICIENT, SKY_MIE_DIRECTIONAL_G, SKY_SUN_INTENSITY,
  CLOUD_COUNT, CLOUD_DENSITY, CLOUD_WIND_SPEED, CLOUD_MIN_HEIGHT, CLOUD_MAX_HEIGHT, CLOUD_SPREAD_RADIUS,
  AMBIENT_COLOR, AMBIENT_INTENSITY, SUN_COLOR, SUN_INTENSITY,
  SHADOW_MAP_SIZE, SHADOW_CAMERA_NEAR, SHADOW_CAMERA_FAR, SHADOW_CAMERA_SIZE,
  HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY,
  PENDING_ROCKET_TIMEOUT, FRAG_MESSAGE_DURATION, FRAG_MESSAGE_FADE,
  MAX_INPUT_HISTORY, TONE_MAPPING_EXPOSURE,
  FRAG_MESSAGE_TOP_OFFSET, FRAG_MESSAGE_TEXT_SHADOW_X, FRAG_MESSAGE_TEXT_SHADOW_Y, FRAG_MESSAGE_TEXT_SHADOW_BLUR, FRAG_MESSAGE_LINE_HEIGHT,
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, EXPLOSION_FALLOFF_MULTIPLIER_DISC, EXPLOSION_COLLISION_MULTIPLIER, KNOCKBACK_MULTIPLIER, PULL_MULTIPLIER,
  ACCURACY_MAX, ACCURACY_NORMALIZATION,
  MAX_DELTA_TIME, REMOTE_PLAYER_FIXED_DT, GAME_LOOP_FIXED_DT, DEBUG_LOG_SAMPLE_RATE,
  MAX_HEALTH, PLAYER_ID_LENGTH, BUTTON_TIMEOUT, NETWORK_BACKEND
} from './config.js';

const logger = new ChildLogger('Main');

// Input history for client-side prediction replay
interface InputHistoryEntry {
  sequenceNumber: number;
  input: {
    forward: number;
    right: number;
    jump: number;
    ski: number;
  };
  timestamp: number;
}
const inputHistory: InputHistoryEntry[] = [];

// ---- Renderer ----
let pixelated = true;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(RENDERER_PIXEL_RATIO);
renderer.setSize(
  Math.floor(window.innerWidth / PIXEL_SCALE),
  Math.floor(window.innerHeight / PIXEL_SCALE)
);
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.domElement.style.imageRendering = 'pixelated'; // Nearest-neighbor scaling
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
document.body.appendChild(renderer.domElement);

function updateRendererSize(): void {
  if (pixelated) {
    renderer.setSize(
      Math.floor(window.innerWidth / PIXEL_SCALE),
      Math.floor(window.innerHeight / PIXEL_SCALE)
    );
    renderer.domElement.style.imageRendering = 'pixelated';
  } else {
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = 'auto';
  }
}

window.addEventListener('resize', () => {
  updateRendererSize();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---- Camera ----
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);

// ---- Scene ----
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY); // exponential like Tribes 2 - warm haze
renderer.setClearColor(FOG_COLOR);

// ---- Atmospheric Sky & Volumetric Clouds ----
const atmosphericSky = new AtmosphericSky(scene, {
  turbidity: SKY_TURBIDITY,
  rayleigh: SKY_RAYLEIGH,
  mieCoefficient: SKY_MIE_COEFFICIENT,
  mieDirectionalG: SKY_MIE_DIRECTIONAL_G,
  sunIntensity: SKY_SUN_INTENSITY,
});

const volumetricClouds = new VolumetricClouds(scene, {
  count: CLOUD_COUNT, // Fewer cloud clusters, each with multiple spheres
  cloudColor: new THREE.Color(0xffffff),
  cloudDensity: CLOUD_DENSITY, // Lower density for softer, more transparent clouds
  windSpeed: CLOUD_WIND_SPEED, // Slower, more realistic wind
  windDirection: new THREE.Vector3(1, 0, 0.1), // Keep as-is for now - this is a direction vector, not a scalar
  minHeight: CLOUD_MIN_HEIGHT,
  maxHeight: CLOUD_MAX_HEIGHT,
  spreadRadius: CLOUD_SPREAD_RADIUS,
});

// ---- Lighting (Tribes 2 aesthetic: bright overhead sun, warm fill) ----
const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);  // warm brown fill
scene.add(ambient);

const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);  // bright warm sun
sun.castShadow = true;
sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
sun.shadow.camera.near = SHADOW_CAMERA_NEAR;
sun.shadow.camera.far = SHADOW_CAMERA_FAR;
sun.shadow.camera.left = -SHADOW_CAMERA_SIZE;
sun.shadow.camera.right = SHADOW_CAMERA_SIZE;
sun.shadow.camera.top = SHADOW_CAMERA_SIZE;
sun.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
scene.add(sun);

// Sync sun position with atmospheric sky
sun.position.copy(atmosphericSky.getSunPosition());
volumetricClouds.setSunDirection(atmosphericSky.getSunDirection());

const hemi = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY);  // blue sky top, warm earth bounce
scene.add(hemi);

// ---- Game state ----
let terrain: Terrain;
let player: Player;
let hud: HUD;
let networkManager: NetworkManager;
const remotePlayers: Map<string, RemotePlayer> = new Map();
const balls: Ball[] = [];
const rockets: Rocket[] = [];
const discs: Disc[] = [];
const debrisList: BallDebris[] = [];
const playerDebrisList: PlayerDebris[] = [];
const explosions: Explosion[] = [];
const implosions: Implosion[] = [];
let effects: EffectsManager;

// Track recent explosions for death impulse calculation
interface ExplosionInfo {
  position: THREE.Vector3;
  force: number;
  timestamp: number;
  shooterId: string;
}
const recentExplosions: ExplosionInfo[] = [];

let ballTimer = 0;

// ---- Score display ----
const scoreDiv = document.createElement('div');
scoreDiv.style.cssText = `
  position:absolute; top:calc(50% - 60px); left:50%; transform:translate(-50%,-100%);
  font-family:sans-serif; font-size:1rem; color:#fff;
  text-shadow:1px 1px 3px #000;
  pointer-events:none; text-align:center; white-space:pre; line-height:1.5;
  opacity:0; transition:opacity ${FRAG_MESSAGE_FADE}ms ease;
`;
document.body.appendChild(scoreDiv);

function showFragMessage(msg: string): void {
  scoreDiv.textContent = msg;
  scoreDiv.style.transition = 'none';
  scoreDiv.style.opacity = '1';
  clearTimeout((scoreDiv as any)._t);
  (scoreDiv as any)._t = setTimeout(() => {
    scoreDiv.style.transition = `opacity ${FRAG_MESSAGE_FADE}ms ease`;
    scoreDiv.style.opacity = '0';
  }, FRAG_MESSAGE_DURATION);
}

// ---- Rocket fire handler ----
const pendingLocalRockets: Rocket[] = []; // queue: rockets waiting for server projectileId
const localRocketById = new Map<string, Rocket>(); // server projectileId -> local Rocket
const pendingRocketTimestamps: Map<Rocket, number> = new Map(); // track when rockets were created

function onFire(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  // Disable input when tab is hidden to prevent firing while alt-tabbed
  if (isTabHidden) return;

  // INSTANT SHOOTING: Spawn rocket locally immediately for LAN-like feel
  const r = new Rocket(scene, e.origin, e.dir, e.playerVel);
  rockets.push(r);
  pendingLocalRockets.push(r);
  pendingRocketTimestamps.set(r, Date.now());

  // Send shot to server with projectile position/velocity for tracking
  // Server will validate and confirm/override if needed
  const velocity = e.dir.clone().multiplyScalar(ROCKET_SPEED);
  networkManager.sendShot(
    null, // no target yet
    { x: e.origin.x, y: e.origin.y, z: e.origin.z },
    { x: velocity.x, y: velocity.y, z: velocity.z }
  );
}

function onDisc(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  const d = new Disc(scene, e.origin, e.dir, e.playerVel);
  discs.push(d);
}

// ---- Explosion processing ----
function processExplosion(pos: THREE.Vector3, radius: number, force: number, shooterId?: string): void {
  const exp = new Explosion(scene, pos);
  explosions.push(exp);

  // Record explosion for death impulse calculation
  recentExplosions.push({
    position: pos.clone(),
    force,
    timestamp: Date.now(),
    shooterId: shooterId || networkManager.getLocalPlayerId()
  });

  // Keep only last 2 seconds of explosions
  const cutoff = Date.now() - FRAG_MESSAGE_DURATION;
  while (recentExplosions.length > 0 && recentExplosions[0].timestamp < cutoff) {
    recentExplosions.shift();
  }

  // Knock back player
  const dpx = player.pos.distanceTo(pos);
  if (dpx < radius * EXPLOSION_FALLOFF_MULTIPLIER_ROCKET) {
    const falloff = 1 - dpx / (radius * EXPLOSION_FALLOFF_MULTIPLIER_ROCKET);
    player.applyKnockback(pos, force * falloff);
  }

  // Damage + knockback balls
  for (const ball of balls) {
    if (ball.dead) continue;
    const db = ball.pos.distanceTo(pos);
    if (db < radius + ball.radius) {
      ball.applyKnockback(pos, force * KNOCKBACK_MULTIPLIER);
    }
  }
}

// ---- Disc explosion processing (pull instead of push) ----
function processDiscExplosion(pos: THREE.Vector3, radius: number, force: number): void {
  const imp = new Implosion(scene, pos);
  implosions.push(imp);

  // Pull player toward explosion
  const dpx = player.pos.distanceTo(pos);
  if (dpx < radius * EXPLOSION_FALLOFF_MULTIPLIER_DISC) {
    const falloff = 1 - dpx / (radius * EXPLOSION_FALLOFF_MULTIPLIER_DISC);
    player.applyPull(pos, force * falloff);
  }

  // Pull balls toward explosion
  for (const ball of balls) {
    if (ball.dead) continue;
    const db = ball.pos.distanceTo(pos);
    if (db < radius * EXPLOSION_COLLISION_MULTIPLIER + ball.radius) {
      ball.applyPull(pos, force * PULL_MULTIPLIER);
    }
  }
}

// ---- Update rockets ----
function updateRockets(dt: number): void {
  // Clean up stale pending rockets (no server response within timeout)
  const now = Date.now();
  for (let i = pendingLocalRockets.length - 1; i >= 0; i--) {
    const r = pendingLocalRockets[i];
    const timestamp = pendingRocketTimestamps.get(r) || 0;
    if (now - timestamp > PENDING_ROCKET_TIMEOUT) {
      // Server didn't respond within timeout, remove from pending queue
      // Rocket will continue to exist in rockets array and update normally
      pendingLocalRockets.splice(i, 1);
      pendingRocketTimestamps.delete(r);
    }
  }

  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    
    // Get remote player positions for collision (skip dead players)
    const remotePlayerPositions = new Map<string, THREE.Vector3>();
    remotePlayers.forEach((rp, playerId) => {
      // Skip dead players for collision detection
      if ((rp as any).isDead) return;
      remotePlayerPositions.set(playerId, rp.position);
    });
    
    r.update(dt, terrain, balls, remotePlayerPositions);

    if (r.exploded && !r.explosionProcessed) {
      r.explosionProcessed = true;
      // Don't remove remote rockets immediately - let trails fade out
      // They will be removed when r.dead becomes true (particles gone)
      
      // Notify server to destroy this projectile (for any hit: terrain, ball, or player)
      if (r.serverProjectileId) {
        networkManager.sendProjectileDestroy(r.serverProjectileId);
      }
      
      processExplosion(r.pos, r.explosionRadius, r.knockbackForce);

      if (r.hitBall) {
        const ball = r.hitBall;
        const destroyed = ball.takeDamage();
        // Accuracy: 1-10 scale, direct core hits = 10, wake hits = 1-9 based on distance
        const accRaw = r.hitAccuracy;
        let acc = 1 + Math.max(0, 9 - (accRaw / HIT_MAX * 9));
        if (r.directHit) acc = 10; // direct core hit = max accuracy
        const dist  = r.hitDistance;
        const air   = r.hitAge;
        const score = Math.round(acc * dist * air);
        logger.debug(`direct=${r.directHit} accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        if (destroyed) {
          debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
          player.kills++;
        }
        showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();
      }

      if (r.hitPlayerId) {
        // INSTANT HIT CONFIRMATION: Client-side hit detection provides immediate feedback
        // Calculate score for player hit (same formula as ball)
        const accRaw = r.hitAccuracy;
        let acc = 1 + Math.max(0, 9 - (accRaw / HIT_MAX * 9));
        if (r.directHit) acc = 10; // direct core hit = max accuracy
        const dist  = r.hitDistance;
        const air   = r.hitAge;
        const score = Math.round(acc * dist * air);
        logger.debug(`direct=${r.directHit} accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();
      }
      
      if (r.hitPlayerId && networkManager) {
        // Send hit event to server for validation and authoritative confirmation
        // Server may override if client prediction was wrong (anti-cheat)
        networkManager.sendShot(r.hitPlayerId, { x: r.pos.x, y: r.pos.y, z: r.pos.z }, { x: r.vel.x, y: r.vel.y, z: r.vel.z }, Date.now(), r.serverProjectileId);
        logger.debug(`Hit player ${r.hitPlayerId} with projectile ${r.serverProjectileId}, direct=${r.directHit}`);
      }
    }

    if (r.dead) {
      r.dispose();
      rockets.splice(i, 1);
    }
  }
}

// ---- Update discs ----
function updateDiscs(dt: number): void {
  // Get remote player positions for collision (skip dead players)
  const remotePlayerPositions = new Map<string, THREE.Vector3>();
  remotePlayers.forEach((rp, playerId) => {
    // Skip dead players for collision detection
    if ((rp as any).isDead) return;
    remotePlayerPositions.set(playerId, rp.position);
  });

  for (let i = discs.length - 1; i >= 0; i--) {
    const d = discs[i];
    d.update(dt, terrain, balls, remotePlayerPositions);

    if (d.exploded && !d.explosionProcessed) {
      d.explosionProcessed = true;
      processDiscExplosion(d.pos, d.explosionRadius, d.pullForce);
      if (d.hitBall) {
        const ball = d.hitBall;
        const destroyed = ball.takeDamage();
        if (destroyed) {
          debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
          player.kills++;
          
          // Calculate score for ball hit
          const accRaw = d.hitAccuracy;
          let acc = 1 + (ACCURACY_MAX - 1) * (1 - accRaw / ACCURACY_NORMALIZATION); // 1-10 scale
          const dist = d.hitDistance;
          const air = d.hitAge;
          const score = Math.round(acc * dist * air);
          logger.debug(`accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
          showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        }
      }

      if (d.hitPlayerId && networkManager) {
        // Send hit event to server
        networkManager.sendShot(d.hitPlayerId, { x: d.pos.x, y: d.pos.y, z: d.pos.z }, { x: d.vel.x, y: d.vel.y, z: d.vel.z }, Date.now(), null);
        logger.debug(`Disc hit player ${d.hitPlayerId}`);
        
        // Calculate score for player hit
        const accRaw = d.hitAccuracy;
        let acc = 1 + (ACCURACY_MAX - 1) * (1 - accRaw / ACCURACY_NORMALIZATION); // 1-10 scale
        const dist = d.hitDistance;
        const air = d.hitAge;
        const score = Math.round(acc * dist * air);
        logger.debug(`accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
      }
    }

    if (d.dead) {
      d.dispose();
      discs.splice(i, 1);
    }
  }
}

// ---- Ball spawning ----
function spawnBall(): void {
  if (balls.filter(b => !b.dead).length >= BALL_MAX) return;
  balls.push(new Ball(scene, terrain, pickVariant()));
}

function updateBalls(dt: number): void {
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
}

// ---- Game loop ----
let lastTime = 0;
let isTabHidden = false;

function loop(time: number): void {
  requestAnimationFrame(loop);
  const dt = Math.min((time - lastTime) / 1000, MAX_DELTA_TIME);
  lastTime = time;

  // Update player physics even when tab is hidden (to keep position changing)
  player.update(dt);
  terrain.update(player.pos.x, player.pos.z);

  // Send position to server if connected (even when tab is hidden)
  if (networkManager && networkManager.isConnected()) {
    networkManager.sendPosition(
      { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      { yaw: player.yaw, pitch: player.pitch }
    );
    
    // Update remote players (only create from gameState, updates come via onPlayerUpdate)
    const players = networkManager.getPlayers();
    const previousRemoteCount = remotePlayers.size;

    // Log remote player positions periodically (every 2 seconds)
    if (Math.random() < 0.03) { // ~3% chance per frame at 60fps = ~2 seconds
      const remotePositions: string[] = [];
      players.forEach((playerState, playerId) => {
        if (playerId !== networkManager.getLocalPlayerId()) {
          remotePositions.push(`${playerId}: (${playerState.position.x.toFixed(1)}, ${playerState.position.y.toFixed(1)}, ${playerState.position.z.toFixed(1)})`);
        }
      });
      if (remotePositions.length > 0) {
        logger.info(`Remote players: ${remotePositions.join(' | ')}`);
      }
    }

    players.forEach((playerState, playerId) => {
      // Skip local player - don't create RemotePlayer for self
      if (playerId === networkManager.getLocalPlayerId()) {
        return;
      }

      let remotePlayer = remotePlayers.get(playerId);
      if (!remotePlayer) {
        logger.debug(`Creating new RemotePlayer for ${playerId} at ${JSON.stringify(playerState.position)}`);
        remotePlayer = new RemotePlayer(scene, playerId, playerState.position, terrain);
        remotePlayers.set(playerId, remotePlayer);
      }
      // RemotePlayer.update is called via onPlayerUpdate callback to store target position
      // Call tick() every frame for smooth interpolation
      remotePlayer.tick(dt);
      if ((remotePlayer as any).model && (remotePlayer as any).loaded) {
        (remotePlayer as any).model.update(dt);
      }

      // Update HUD indicator for this player
      hud.updatePlayerIndicator(playerId, playerState.position, camera, playerState.isDead);
    });

    if (remotePlayers.size !== previousRemoteCount) {
      logger.debug(`Remote players in scene: ${remotePlayers.size}`);
    }
    
    // Remove disconnected players
    for (const [playerId, remotePlayer] of remotePlayers) {
      if (!players.has(playerId)) {
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
        hud.removePlayerIndicator(playerId);
      }
      // Remove dead players that have shrunk to 0
      if ((remotePlayer as any).scale === 0) {
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
        hud.removePlayerIndicator(playerId);
      }
    }
  }
  
  // Sync fog uniforms to terrain shader
  if (scene.fog instanceof THREE.FogExp2) {
    (terrain as any).material.uniforms.fogColor.value = scene.fog.color;
    (terrain as any).material.uniforms.fogDensity.value = scene.fog.density;
  }
  updateBalls(dt);
  updateRockets(dt);
  updateDiscs(dt);
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
  hud.update(dt, player, networkManager.getPing(), networkManager.getPacketLoss(), networkManager.getJitter());

  // Jetpack particles
  if (!player.onGround && (document as any)._jetActive) {
    effects.spawnJetpack(player.pos.clone());
  }

  // Update atmospheric effects
  volumetricClouds.update(dt);
  atmosphericSky.update(dt);

  // Sync sun position with atmospheric sky (for dynamic day/night)
  sun.position.copy(atmosphericSky.getSunPosition());
  volumetricClouds.setSunDirection(atmosphericSky.getSunDirection());

  // Shadow camera follows player
  sun.shadow.camera.position.copy(sun.position).add(player.pos);
  sun.target.position.copy(player.pos);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);
}

// ---- Boot ----
async function init(): Promise<void> {
  await loadHeightmap('/assets/heightmaps/Vortex_Smooth2_2048.png');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  effects = new EffectsManager(scene);
  effects.setTerrain(terrain);
  player = new Player(terrain, camera, scene);
  player.onFire = onFire;
  player.onDisc = onDisc;
  player.onJump = (pos) => effects.spawnJumpDust(pos);
  player.onJetpack = (pos) => effects.spawnJetpack(pos);
  player.onSki = (pos, vel) => effects.spawnSkiDust(pos, vel);

  // Initialize networking with selected backend
  const adapter = NetworkAdapterFactory.createAdapter(NETWORK_BACKEND);
  networkManager = new NetworkManager(adapter);

  // Set control object for client-side prediction
  networkManager.setControlObject(player);
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  player.onNetworkInput = (input, rotation) => networkManager.sendInputMove(input, rotation);
  hud = new HUD();

  // Load player model
  await player.loadModel();
  
  // Register player hit handler (non-lethal hits)
  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number) => {
    // Check if local player was hit
    if (targetId === networkManager.getLocalPlayerId()) {
      logger.info(`Local player hit for ${damage} damage by ${shooterId}`);
      return;
    }

    // Non-lethal hits don't trigger death animation
      logger.info(`Remote player ${targetId} hit for ${damage} damage by ${shooterId}`);
  };

  // Register player kill handler (lethal kills)
  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    // Check if local player was killed
    if (targetId === networkManager.getLocalPlayerId()) {
      logger.info(`Local player killed by ${shooterId}`);
      player.isDead = true;
      hud.hide();
      return;
    }

    // Show frag message if local player got the kill
    if (shooterId === networkManager.getLocalPlayerId()) {
      showFragMessage(`FRAGGED PLAYER!`);
    }

    const remotePlayer = remotePlayers.get(targetId);
    if (remotePlayer) {
      // Find matching explosion from this shooter
      let explosionPos: THREE.Vector3 | undefined;
      let explosionForce: number | undefined;
      for (const exp of recentExplosions) {
        if (exp.shooterId === shooterId) {
          explosionPos = exp.position;
          explosionForce = exp.force;
          break;
        }
      }

      // Play death animation (ragdoll physics with explosion impulse)
      remotePlayer.playDeath(explosionPos, explosionForce);

      // Spawn player debris
      const debris = new PlayerDebris(scene, terrain, remotePlayer.position.x, remotePlayer.position.y, remotePlayer.position.z);
      playerDebrisList.push(debris);

      // Hide the model immediately
      remotePlayer.hide();

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
  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => {
    let remotePlayer = remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, REMOTE_PLAYER_FIXED_DT, networkManager.getPing()); // Store target position for interpolation
      if (Math.random() < DEBUG_LOG_SAMPLE_RATE) { // 5% of updates log for debugging
        logger.debug(`onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
    } else {
      logger.debug(`onPlayerUpdate called for unknown player: ${playerId}, creating...`);
      remotePlayer = new RemotePlayer(scene, playerId, position, terrain);
      remotePlayers.set(playerId, remotePlayer);
    }
  };

  // Register state reconciliation handler for client-side prediction
  // Now handled by Tribes2Adapter directly
  // networkManager.onStateReconciliation = (state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => {
  //   logger.debug(`State reconciliation: pos(${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}) seq=${state.lastProcessedSequence}`);
  // 
  //   // Reconcile client state with server authoritative state
  //   // Snap to server position first
  //   player.pos.set(state.position.x, state.position.y, state.position.z);
  //   player.vel.set(state.velocity.x, state.velocity.y, state.velocity.z);
  //   player.yaw = state.rotation.yaw;
  //   player.pitch = state.rotation.pitch;
  // 
  //   // Replay unprocessed inputs from lastProcessedSequence to current
  //   // This smooths out the prediction correction instead of snapping
  //   const unprocessedInputs = inputHistory.filter(entry => entry.sequenceNumber > state.lastProcessedSequence);
  //   if (unprocessedInputs.length > 0) {
  //     logger.debug(`Replaying ${unprocessedInputs.length} unprocessed inputs for smooth reconciliation`);
  //     // Replay inputs at 15Hz tick rate (67ms per tick)
  //     const dt = GAME_LOOP_FIXED_DT;
  //     for (const entry of unprocessedInputs) {
  //       // Apply input to player movement controller for proper replay
  //       const movementInput = {
  //         forward: entry.input.forward,
  //         right: entry.input.right,
  //         jump: entry.input.jump,
  //         ski: entry.input.ski
  //       };
  //       player.movement.setInput(movementInput);
  //       player.movement.update(dt);
  //       logger.debug(`Replaying input seq=${entry.sequenceNumber} pos=${player.pos.x.toFixed(1)},${player.pos.y.toFixed(1)},${player.pos.z.toFixed(1)}`);
  //     }
  //   }
  // 
  //   // Clean up old inputs from history
  //   const cutoffSequence = state.lastProcessedSequence;
  //   const oldCount = inputHistory.length;
  //   for (let i = inputHistory.length - 1; i >= 0; i--) {
  //     if (inputHistory[i].sequenceNumber <= cutoffSequence) {
  //       inputHistory.splice(i, 1);
  //     }
  //   }
  //   if (oldCount !== inputHistory.length) {
  //     logger.debug(`Cleaned up ${oldCount - inputHistory.length} old inputs from history`);
  //   }
  // };

  // Server-authoritative projectile handlers
  const remoteProjectiles = new Map<string, Rocket>();

  networkManager.onProjectileCreated = (projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => {
    // For own projectiles: link the pending local rocket to this server ID
    if (ownerId === networkManager.getLocalPlayerId()) {
      const localRocket = pendingLocalRockets.shift();
      if (localRocket) {
        localRocket.serverProjectileId = projectileId;
        localRocketById.set(projectileId, localRocket);
        pendingRocketTimestamps.delete(localRocket); // Clean up timestamp
      }
      return;
    }

    const vel = new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const dir = vel.clone().normalize();
    const rocket = new Rocket(scene, origin, dir, new THREE.Vector3(0, 0, 0));
    rocket.vel.copy(vel); // override with exact server velocity
    rocket.isRemote = true;
    rockets.push(rocket);
    remoteProjectiles.set(projectileId, rocket);
  };

  networkManager.onProjectileUpdate = (projectileId: string, position: { x: number; y: number; z: number }) => {
    const rocket = remoteProjectiles.get(projectileId);
    if (rocket) {
      rocket.pos.set(position.x, position.y, position.z);
    }
  };

  networkManager.onProjectileDestroyed = (projectileId: string) => {
    // Kill remote rocket (explode so trail particles fade out naturally)
    const remoteRocket = remoteProjectiles.get(projectileId);
    if (remoteRocket) {
      remoteRocket.explode();
      // Don't delete from remoteProjectiles - let it fade out naturally
      // The rocket will be removed from rockets array when r.dead becomes true
    }
    // Kill local rocket if server says it's gone - explode to let trails fade
    const localRocket = localRocketById.get(projectileId);
    if (localRocket) {
      localRocket.explode();
      localRocketById.delete(projectileId);
      // Also remove from pending queue if it's still there (shouldn't happen but defensive)
      const pendingIndex = pendingLocalRockets.indexOf(localRocket);
      if (pendingIndex !== -1) {
        pendingLocalRockets.splice(pendingIndex, 1);
        pendingRocketTimestamps.delete(localRocket);
      }
    }
  };
  
  // Register player respawn handler
  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    // Check if local player respawned
    if (playerId === networkManager.getLocalPlayerId()) {
      logger.info(`Local player respawned at ${JSON.stringify(position)}`);
      player.isDead = false;
      player.health = 100;
      player.vel.set(0, 0, 0);
      player.pos.set(position.x, position.y, position.z);
      player.yaw = rotation.yaw;
      player.pitch = rotation.pitch;
      hud.show();
      return;
    }

    // Dispose old remote player if exists
    const oldPlayer = remotePlayers.get(playerId);
    if (oldPlayer) {
      oldPlayer.dispose();
    }

    // Create new remote player at respawn position
    const remotePlayer = new RemotePlayer(scene, playerId, position);
    remotePlayers.set(playerId, remotePlayer);
    remotePlayer.show(); // Ensure model is visible on respawn
      logger.info(`Player ${playerId} respawned at ${JSON.stringify(position)}`);
  };
  
  // Register playerJoined handler (for new players joining after initial connection)
  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    logger.info(`Player joined: ${playerId} at ${JSON.stringify(position)}`);
    // RemotePlayer will be created in the main loop when networkManager.getPlayers() includes this player
  };

  // Register gameState handler (for initial connection and reconnection)
  networkManager.onGameState = (players: any[], localPlayerState: any) => {
    logger.debug(`gameState received, players: ${players.length}`);

    if (localPlayerState) {
      logger.debug(`Restoring local player state from gameState: ${JSON.stringify(localPlayerState)}`);

      // Restore position and rotation
      player.pos.set(localPlayerState.position.x, localPlayerState.position.y, localPlayerState.position.z);
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

  // Register state restore handler (for reconnection via stateReconciliation)
  // Now handled by Tribes2Adapter directly
  // networkManager.onStateRestore = (state) => {
  //   logger.debug(`Restoring player state: ${JSON.stringify(state)}`);
  // 
  //   // Restore position and rotation
  //   player.pos.set(state.position.x, state.position.y, state.position.z);
  //   player.yaw = state.rotation.yaw;
  //   player.pitch = state.rotation.pitch;
  // 
  //   // Restore velocity if available
  //   if (state.velocity) {
  //     player.vel.set(state.velocity.x, state.velocity.y, state.velocity.z);
  //   }
  // 
  //   // Restore last processed sequence if available (for input reconciliation)
  //   if (state.lastProcessedSequence !== undefined) {
  //     // Note: This would need to be passed to the network manager's input history
  //     // For now, we'll log it - full implementation would require network manager changes
  //     logger.debug(`Last processed sequence: ${state.lastProcessedSequence}`);
  //   }
  // 
  //   // If player was dead, they'll respawn normally via server logic
  //   // If alive, they continue from their last position
  //   logger.debug(`Player state restored - pos(${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}) vel(${state.velocity?.x.toFixed(1) || 0},${state.velocity?.y.toFixed(1) || 0},${state.velocity?.z.toFixed(1) || 0})`);
  // };
  
  // Connect to server
  const serverUrl = NETWORK_BACKEND === 'tribes2' ? 'ws://localhost:8080' : 'http://localhost:2567';
  try {
    await networkManager.connect(serverUrl);
    logger.info(`Connected to server at ${serverUrl} using ${NETWORK_BACKEND} backend`);
  } catch (error) {
    logger.error('Failed to connect to server', error);
  }

  // Initial balls
  for (let i = 0; i < 8; i++) spawnBall();

  // Track jet button for continuous particles
  document.addEventListener('mousedown', (e) => { if (e.button === 2) (document as any)._jetActive = true; });
  document.addEventListener('mouseup', (e) => { if (e.button === 2) (document as any)._jetActive = false; });

  // Detect tab visibility changes to keep sending position when alt-tabbed
  document.addEventListener('visibilitychange', () => {
    isTabHidden = document.hidden;
    logger.debug(`Tab visibility changed: ${isTabHidden ? 'hidden' : 'visible'}`);
  });

  requestAnimationFrame(loop);
}

// ---- Overlay / pointer-lock helpers ----
const overlay = document.getElementById('overlay')!;
let gameStarted = false;

function requestLock(): void {
  renderer.domElement.requestPointerLock();
}

document.addEventListener('pointerlockchange', () => {
  logger.debug(`Pointer lock changed: locked=${document.pointerLockElement === renderer.domElement}`);
  if (document.pointerLockElement === renderer.domElement) {
    overlay.style.display = 'none';
  }
  // Don't auto-show overlay - let keydown handler control it
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && gameStarted) {
    if (document.pointerLockElement === renderer.domElement) {
      // Pointer is locked, release it and show overlay
      document.exitPointerLock();
      setTimeout(() => {
        overlay.style.display = 'flex';
      }, BUTTON_TIMEOUT);
    } else if (overlay.style.display === 'flex') {
      // Overlay is visible, hide it and re-lock
      overlay.style.display = 'none';
      logger.debug('Requesting pointer lock...');
      requestLock();
    } else {
      // Overlay is hidden, show it
      overlay.style.display = 'flex';
    }
  }
  if (e.code === 'F4') {
    pixelated = !pixelated;
    updateRendererSize();
    pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';
  }
});

// Clicking overlay or canvas re-locks.
document.getElementById('start-btn')!.addEventListener('click', requestLock);
const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
pixelToggleBtn.addEventListener('click', () => {
  pixelated = !pixelated;
  updateRendererSize();
  pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';
});
pixelToggleBtn.textContent = 'PIXELATED: ON';
renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) requestLock();
});

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
init().then(() => {
  gameStarted = true;
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
        velocity: { x: 0, y: 0, z: 0 }, // RemotePlayer velocity is private, use 0 for now
        health: 100, // RemotePlayer doesn't track health, use default
        isDead: (rp as any).isDead || false,
        rotation: { yaw: rp.rotation.yaw, pitch: rp.rotation.pitch }
      });
    }
    
    const snapshot = StateSnapshot.create(playerMap, [...rockets, ...discs], 'client');
    StateSnapshot.save(snapshot);
    logger.info('Client snapshot taken');
    return snapshot.hash;
  };
  
  (window as any).requestServerSnapshot = () => {
    if (networkManager) {
      // networkManager.send({ type: 'snapshot' });
      logger.info('Requested server snapshot (not supported in basic Colyseus)');
    }
  };
  
  (window as any).exportClientSnapshots = () => {
    StateSnapshot.exportSnapshots();
  };
  
  console.log('Client snapshot functions available: takeClientSnapshot(), requestServerSnapshot(), exportClientSnapshots()');
  
  // Add global function to request rough state comparison
  (window as any).requestRoughState = () => {
    if (networkManager) {
      // networkManager.send({ type: 'roughStateRequest' });
      logger.info('Requested rough state comparison (not supported in basic Colyseus)');
    }
  };
}
