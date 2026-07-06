import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { AtmosphericSky } from './atmosphericSky.js';
import { VolumetricClouds } from './volumetricClouds.js';
import { loadHeightmap, Terrain } from './terrain.js';
import { Player } from './Player.js';
import { Ball, pickVariant } from './balls.js';
import { Rocket } from './rocket.js';
import { Disc } from './disc.js';
import { EffectsManager } from './effects.js';
import { HUD } from './hud.js';
import { HealthBarSystem } from './HealthBarSystem.js';
import { BallDebris } from './debris.js';
import { Explosion } from './explosion.js';
import { Implosion } from './implosion.js';
import { RemotePlayer } from './RemotePlayer.js';
import { DamageNumberManager } from './damageNumbers.js';
import { PlayerDebris } from './PlayerDebris.js';
import { NetworkManager } from './networking/NetworkManager.js';
import { NetworkAdapterFactory } from './networking/NetworkAdapterFactory.js';
import { ChildLogger } from './Logger.js';
import { StateSnapshot } from './StateSnapshot.js';
import { DemoManager } from './demo/index.js';
import { InputFlags, JetpackFlags, ProjectileEventType } from './demo/types.js';
import {
  ROCKET_SPEED, ROCKET_AOE_DAMAGE, ROCKET_AOE_RADIUS, HIT_MAX, BALL_SPAWN_INTERVAL, BALL_MAX,
  PIXEL_SCALE, RENDERER_PIXEL_RATIO,
  CAMERA_FOV, CAMERA_NEAR, CAMERA_FAR,
  FOG_COLOR, FOG_DENSITY,
  SKY_TURBIDITY, SKY_RAYLEIGH, SKY_MIE_COEFFICIENT, SKY_MIE_DIRECTIONAL_G, SKY_SUN_INTENSITY,
  CLOUD_COUNT, CLOUD_DENSITY, CLOUD_WIND_SPEED, CLOUD_MIN_HEIGHT, CLOUD_MAX_HEIGHT, CLOUD_SPREAD_RADIUS,
  AMBIENT_COLOR, AMBIENT_INTENSITY, SUN_COLOR, SUN_INTENSITY,
  SHADOW_MAP_SIZE, SHADOW_CAMERA_NEAR, SHADOW_CAMERA_FAR, SHADOW_CAMERA_SIZE,
  HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY,
  PENDING_ROCKET_TIMEOUT, FRAG_MESSAGE_DURATION, FRAG_MESSAGE_FADE,
  TONE_MAPPING_EXPOSURE,
  EXPLOSION_FALLOFF_MULTIPLIER_ROCKET, EXPLOSION_FALLOFF_MULTIPLIER_DISC, EXPLOSION_COLLISION_MULTIPLIER, KNOCKBACK_MULTIPLIER, PULL_MULTIPLIER,
  ACCURACY_MAX, ACCURACY_NORMALIZATION,
  MAX_DELTA_TIME, REMOTE_PLAYER_FIXED_DT, DEBUG_LOG_SAMPLE_RATE,
  BUTTON_TIMEOUT, NETWORK_BACKEND
} from './config.js';

const logger = new ChildLogger('Main');

// ---- Demo system ----
let demoManager: DemoManager | null = null;

// ---- Load Time Profiling ----
const loadTimes: { [key: string]: number } = {};
const loadStart = performance.now();
loadTimes['scriptStart'] = loadStart;

function markTime(name: string): void {
  loadTimes[name] = performance.now();
  const elapsed = (loadTimes[name] - loadStart).toFixed(2);
  console.log(`[PROFILE] ${name}: ${elapsed}ms`);
}

function printLoadSummary(): void {
  console.log('=== LOAD TIME SUMMARY ===');
  let prev = loadStart;
  for (const [name, time] of Object.entries(loadTimes)) {
    const elapsed = (time - loadStart).toFixed(2);
    const delta = (time - prev).toFixed(2);
    console.log(`${name}: +${delta}ms (total: ${elapsed}ms)`);
    prev = time;
  }
  const total = (performance.now() - loadStart).toFixed(2);
  console.log(`=== TOTAL: ${total}ms ===`);
}


// ---- Renderer ----
let pixelated = localStorage.getItem('fps-pixelated') === 'false' ? false : true;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(RENDERER_PIXEL_RATIO);
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
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied by OutputPass at end of post chain
renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
document.body.appendChild(renderer.domElement);

// Initialize button text from localStorage
const pixelToggleBtn = document.getElementById('pixel-toggle')! as HTMLButtonElement;
pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';

let postproEnabled = localStorage.getItem('fps-postpro') === 'false' ? false : true;
const postproToggleBtn = document.getElementById('bloom-toggle')! as HTMLButtonElement;
postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';

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
  const w = pixelated
    ? Math.floor(window.innerWidth / PIXEL_SCALE)
    : window.innerWidth;
  const h = pixelated
    ? Math.floor(window.innerHeight / PIXEL_SCALE)
    : window.innerHeight;
  composer.setSize(w, h);
});

// ---- Camera ----
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);

// ---- Scene ----
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY); // exponential like Tribes 2 - warm haze
renderer.setClearColor(FOG_COLOR);

// ---- Post-processing (Bloom) ----
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(
    pixelated ? Math.floor(window.innerWidth / PIXEL_SCALE) : window.innerWidth,
    pixelated ? Math.floor(window.innerHeight / PIXEL_SCALE) : window.innerHeight
  ),
  0.6,  // strength
  0.4,  // radius
  1     // threshold (linear HDR — only emissive/additive elements exceed this)
);
composer.addPass(bloomPass);

// Contrast pass — pushes midtones darker, increases contrast
const contrastPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.15 },  // >1 = more contrast
    brightness: { value: -0.02 } // slightly darker
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float brightness;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      color.rgb = (color.rgb - 0.5) * contrast + 0.5 + brightness;
      gl_FragColor = color;
    }
  `
});
composer.addPass(contrastPass);

composer.addPass(new OutputPass()); // ACES tone mapping + sRGB conversion after bloom
bloomPass.enabled = postproEnabled;
contrastPass.enabled = postproEnabled;

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
sun.shadow.bias = -0.0001;
sun.shadow.normalBias = 0.02;
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
let healthBarSystem: HealthBarSystem;
let damageNumberManager: DamageNumberManager;
let networkManager: NetworkManager;
const remotePlayers: Map<string, RemotePlayer> = new Map();
const playersBeingCreated: Set<string> = new Set();
let lastRemotePosLog = '';
const balls: Ball[] = [];
let lastSentPos = { x: 0, y: 0, z: 0 };
const rockets: Rocket[] = [];
const discs: Disc[] = [];
const debrisList: BallDebris[] = [];
const playerDebrisList: PlayerDebris[] = [];
const explosions: Explosion[] = [];
const implosions: Implosion[] = [];
let effects: EffectsManager;

// ---- Playback projectile reconstruction ----
const playbackRockets: Rocket[] = [];
const playbackRocketById = new Map<number, Rocket>();

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
  // Disable input when tab is hidden or during demo playback
  if (isTabHidden) return;
  if (demoManager?.isPlaying) return;

  // INSTANT SHOOTING: Spawn rocket locally immediately for LAN-like feel
  const r = new Rocket(scene, e.origin, e.dir, e.playerVel);
  rockets.push(r);
  pendingLocalRockets.push(r);
  pendingRocketTimestamps.set(r, Date.now());

  // Record projectile fired event for demo
  if (demoManager?.isRecording) {
    const velocity = e.dir.clone().normalize().multiplyScalar(ROCKET_SPEED).addScaledVector(e.playerVel, 0.5);
    r.demoProjectileId = demoManager.recordProjectileFired(
      { x: e.origin.x, y: e.origin.y, z: e.origin.z },
      { x: velocity.x, y: velocity.y, z: velocity.z },
      0 // weaponType: rocket
    );
  }

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
  if (demoManager?.isPlaying) return;
  const d = new Disc(scene, e.origin, e.dir, e.playerVel);
  discs.push(d);
}

// ---- Explosion processing ----
function processExplosion(pos: THREE.Vector3, radius: number, force: number, shooterId?: string, directHit: boolean = false, directHitTargetId?: string | null, age: number = 0): void {
  const exp = new Explosion(scene, pos, directHit, age);
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

  // AOE damage + knockback to remote players
  // Send to server for authoritative damage, apply knockback locally for visual feedback
  if (networkManager && networkManager.isConnected()) {
    networkManager.sendAOEShot(
      { x: pos.x, y: pos.y, z: pos.z },
      directHitTargetId ?? null
    );
  }
  for (const [playerId, rp] of remotePlayers) {
    if (playerId === directHitTargetId) continue; // Direct hit already handled
    if ((rp as any).isDead) continue;
    const d = rp.position.distanceTo(pos);
    // Knockback uses full explosion radius
    if (d < radius * EXPLOSION_FALLOFF_MULTIPLIER_ROCKET) {
      const falloff = 1 - d / (radius * EXPLOSION_FALLOFF_MULTIPLIER_ROCKET);
      rp.applyKnockback(pos, force * falloff);
      // Instant hit marker + damage prediction for AOE splash hit (client prediction)
      hud.showHitMarker();
      healthBarSystem.predictDamage(playerId, Math.round(ROCKET_AOE_DAMAGE * falloff));
    }
  }
}

// ---- Disc explosion processing (pull instead of push) ----
function processDiscExplosion(pos: THREE.Vector3, radius: number, force: number, directHitTargetId?: string | null, age: number = 0): void {
  const imp = new Implosion(scene, pos, age);
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

  // AOE damage + pull to remote players
  // Send to server for authoritative damage, apply pull locally for visual feedback
  if (networkManager && networkManager.isConnected()) {
    networkManager.sendDiscAOEShot(
      { x: pos.x, y: pos.y, z: pos.z },
      directHitTargetId ?? null
    );
  }
  for (const [playerId, rp] of remotePlayers) {
    if (playerId === directHitTargetId) continue;
    if ((rp as any).isDead) continue;
    const d = rp.position.distanceTo(pos);
    if (d < radius * EXPLOSION_FALLOFF_MULTIPLIER_DISC) {
      const falloff = 1 - d / (radius * EXPLOSION_FALLOFF_MULTIPLIER_DISC);
      rp.applyPull(pos, force * falloff);
      // Instant hit marker + damage prediction for disc AOE splash hit (client prediction)
      hud.showHitMarker();
      healthBarSystem.predictDamage(playerId, Math.round(ROCKET_AOE_DAMAGE * falloff));
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
      
      processExplosion(r.pos, r.explosionRadius, r.knockbackForce, undefined, r.directHit, r.hitPlayerId, r.age);

      // Record projectile hit for demo (any hit: terrain, ball, or player)
      if (demoManager?.isRecording && r.demoProjectileId) {
        const targetId = r.hitBall ? balls.indexOf(r.hitBall) : (r.hitPlayerId ? 0xFFFF : 0);
        demoManager.recordProjectileHit(r.demoProjectileId, { x: r.pos.x, y: r.pos.y, z: r.pos.z }, targetId);
      }

      // Auto-clip: if projectile lifetime > 1s, save a demo clip
      if (demoManager?.isRecording && r.age > 1.0) {
        demoManager.autoClipOnHit(r.age);
      }

      if (r.hitBall) {
        const ball = r.hitBall;
        const destroyed = ball.takeDamage();
        // Spawn damage number
        damageNumberManager.spawn(ball.pos, 1, r.directHit ? '#ffd700' : '#ffffff', camera);
        // Spawn healthbar only if not destroyed (killing blow doesn't need healthbar)
        if (!destroyed) {
          healthBarSystem.spawnBall(ball, 1, ball.health);
        }
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

        // Record target hit/destroyed for demo
        if (demoManager?.isRecording) {
          const ballIdx = balls.indexOf(ball);
          if (destroyed) {
            demoManager.recordTargetDestroyed(ballIdx, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z });
          } else {
            demoManager.recordTargetHit(ballIdx, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, ball.health);
          }
        }
      }

      if (r.hitPlayerId) {
        // Get player position for damage number
        const targetPlayer = remotePlayers.get(r.hitPlayerId);
        const hitPos = targetPlayer ? targetPlayer.position : player.pos;
        damageNumberManager.spawn(hitPos, 50, r.directHit ? '#ffd700' : '#ffffff', camera);
        // INSTANT HIT CONFIRMATION: Client-side hit detection provides immediate feedback
        // Predict damage on health bar immediately (don't wait for server)
        healthBarSystem.predictDamage(r.hitPlayerId, 50); // Direct hit = 50 damage
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
      if (demoManager?.isRecording && r.demoProjectileId) {
        demoManager.recordProjectileDestroyed(r.demoProjectileId, { x: r.pos.x, y: r.pos.y, z: r.pos.z });
      }
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
      processDiscExplosion(d.pos, d.explosionRadius, d.pullForce, d.hitPlayerId, d.age);
      if (d.hitBall) {
        const ball = d.hitBall;
        const destroyed = ball.takeDamage();
        damageNumberManager.spawn(ball.pos, 1, '#00ffff', camera);
        // Spawn healthbar only if not destroyed (killing blow doesn't need healthbar)
        if (!destroyed) {
          healthBarSystem.spawnBall(ball, 1, ball.health);
        }
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
        // Get player position for damage number
        const targetPlayer = remotePlayers.get(d.hitPlayerId);
        const hitPos = targetPlayer ? targetPlayer.position : player.pos;
        damageNumberManager.spawn(hitPos, 50, '#00ffff', camera);
        // Send hit event to server
        networkManager.sendShot(d.hitPlayerId, { x: d.pos.x, y: d.pos.y, z: d.pos.z }, { x: d.vel.x, y: d.vel.y, z: d.vel.z }, Date.now(), null);
        // Predict damage on health bar immediately (disc direct hit = 50 damage)
        healthBarSystem.predictDamage(d.hitPlayerId, 50);
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
  const ball = new Ball(scene, terrain, pickVariant());
  balls.push(ball);
  if (demoManager?.isRecording) {
    const idx = balls.length - 1;
    demoManager.recordTargetSpawned(idx, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, { x: ball.vel.x, y: ball.vel.y, z: ball.vel.z }, 0);
  }
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
  
  // Sync fog uniforms to terrain shader
  if (scene.fog instanceof THREE.FogExp2) {
    (terrain as any).material.uniforms.fogColor.value = scene.fog.color;
    (terrain as any).material.uniforms.fogDensity.value = scene.fog.density;
  }
  // Update demo system (zero-overhead when idle)
  if (demoManager) demoManager.update(dt);

  updateBalls(dt);
  updateRockets(dt);
  updateDiscs(dt);

  // Update playback rockets (deterministic reconstruction from events)
  for (let i = playbackRockets.length - 1; i >= 0; i--) {
    const r = playbackRockets[i];
    r.update(dt, terrain);
    if (r.dead) {
      r.dispose();
      playbackRockets.splice(i, 1);
      // Remove from map if present
      for (const [id, rocket] of playbackRocketById) {
        if (rocket === r) {
          playbackRocketById.delete(id);
          break;
        }
      }
    }
  }

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
  healthBarSystem.update(dt, networkManager.getPlayers(), remotePlayers as any, balls);
  damageNumberManager.update(dt);

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

  // Shadow camera follows player (positioned above looking down)
  sun.shadow.camera.position.set(player.pos.x, player.pos.y + 500, player.pos.z);
  sun.shadow.camera.lookAt(player.pos);

  if (postproEnabled) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }

  // Render damage numbers after post-processing (bypass bloom/contrast for visibility)
  damageNumberManager.update(dt);
}

// ---- Boot ----
async function init(): Promise<void> {
  markTime('initStart');
  await loadHeightmap('/assets/heightmaps/Vortex_Smooth2_2048.png');
  markTime('heightmapLoaded');

  terrain = new Terrain(scene, sun.position.clone().normalize());
  markTime('terrainCreated');

  effects = new EffectsManager(scene);
  effects.setTerrain(terrain);
  markTime('effectsCreated');

  player = new Player(terrain, camera, scene);
  player.onFire = onFire;
  player.onDisc = onDisc;
  player.onJump = (pos) => effects.spawnJumpDust(pos);
  player.onJetpack = (pos) => effects.spawnJetpack(pos);
  player.onSki = (pos, vel) => effects.spawnSkiDust(pos, vel);
  markTime('playerCreated');

  // Initialize networking with selected backend
  const adapter = NetworkAdapterFactory.createAdapter(NETWORK_BACKEND);
  networkManager = new NetworkManager(adapter);
  markTime('networkInit');

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
  const coolShotsList = document.getElementById('cool-shots-list')!;
  const renderCoolShots = (shots: any[]) => {
    coolShotsList.innerHTML = '';
    if (shots.length === 0) {
      coolShotsList.innerHTML = '<div class="cool-shot-item empty">No cool shots yet</div>';
      return;
    }
    shots.forEach((shot, i) => {
      const item = document.createElement('div');
      item.className = 'cool-shot-item';
      const timeStr = new Date(shot.timestamp).toLocaleTimeString().slice(0, 5);
      item.innerHTML = `<span class="rank">${i + 1}</span><span class="lifetime">${shot.projectileLifetime.toFixed(2)}s</span><span class="time">${timeStr}</span>`;
      item.onclick = () => {
        demoManager?.playCoolShot(i);
        overlay.style.display = 'none';
        requestLock();
      };
      coolShotsList.appendChild(item);
    });
  };
  demoManager.onCoolShotsChanged = renderCoolShots;

  // ---- Playback projectile reconstruction ----
  // Handle projectile events from demo playback: spawn rockets on Fired, explode on Destroyed
  demoManager.onPlaybackEvent = (events: { projectiles: any[], targets: any[] }) => {
    for (const ev of events.projectiles) {
      if (ev.eventType === ProjectileEventType.Fired) {
        // Reconstruct rocket from recorded position + velocity
        const origin = new THREE.Vector3(ev.posX, ev.posY, ev.posZ);
        const velocity = new THREE.Vector3(ev.velX, ev.velY, ev.velZ);
        const r = new Rocket(scene, origin, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0));
        r.isRemote = true;
        r.vel.copy(velocity);
        playbackRockets.push(r);
        playbackRocketById.set(ev.projectileId, r);
      } else if (ev.eventType === ProjectileEventType.Bounce) {
        // Update rocket velocity to match recorded bounce
        const r = playbackRocketById.get(ev.projectileId);
        if (r && !r.exploded) {
          r.pos.set(ev.posX, ev.posY, ev.posZ);
          r.vel.set(ev.velX, ev.velY, ev.velZ);
        }
      } else if (ev.eventType === ProjectileEventType.Destroyed || ev.eventType === ProjectileEventType.Hit) {
        // Force explode the rocket at the recorded position
        const r = playbackRocketById.get(ev.projectileId);
        if (r && !r.exploded) {
          r.pos.set(ev.posX, ev.posY, ev.posZ);
          r.explode();
          // Spawn explosion effect at the recorded position, using rocket age for visual scale
          explosions.push(new Explosion(scene, r.pos, false, r.age));
        }
      }
    }
  };

  // Apply playback state to the local player (camera follows replay)
  demoManager.onPlaybackState = (state) => {
    if (demoManager?.isPlaying) {
      player.pos.set(state.posX, state.posY, state.posZ);
      player.vel.set(state.velX, state.velY, state.velZ);
      player.yaw = state.yaw;
      player.pitch = state.pitch;
    }
  };

  // Cleanup playback rockets when playback ends, show menu for replay
  demoManager.onPlaybackEnd = () => {
    for (const r of playbackRockets) {
      r.dispose();
    }
    playbackRockets.length = 0;
    playbackRocketById.clear();
    // Show overlay menu so user can replay or pick another clip
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();
    }
    overlay.style.display = 'flex';
    demoManager?.fetchCoolShotsFromServer();
  };

  // Clear playback rockets on seek so they don't get orphaned
  demoManager.onPlaybackSeek = () => {
    for (const r of playbackRockets) {
      r.dispose();
    }
    playbackRockets.length = 0;
    playbackRocketById.clear();
  };

  hud = new HUD();
  healthBarSystem = new HealthBarSystem(camera);
  damageNumberManager = new DamageNumberManager(scene);
  markTime('hudCreated');

  // Load player model
  await player.loadModel();
  markTime('playerModelLoaded');
  
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
      showFragMessage(`FRAGGED PLAYER!`);
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
      for (const exp of recentExplosions) {
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
  networkManager.onPlayerJoined = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
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
  markTime('networkConnectStart');
  networkManager.connect(serverUrl).then(() => {
    markTime('networkConnected');
    logger.info(`Connected to server at ${serverUrl} using ${NETWORK_BACKEND} backend`);
  }).catch((error) => {
    logger.error('Failed to connect to server', error);
  });

  // Initial balls
  for (let i = 0; i < 8; i++) spawnBall();

  // Auto-start demo recording so cool shots are captured seamlessly
  demoManager?.startRecording();
  markTime('initComplete');

  printLoadSummary();

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
let unlockByEscape = false; // Track if unlock was caused by ESC key

function requestLock(): void {
  renderer.domElement.requestPointerLock();
}

document.addEventListener('pointerlockchange', () => {
  logger.debug(`Pointer lock changed: locked=${document.pointerLockElement === renderer.domElement}`);
  if (document.pointerLockElement === renderer.domElement) {
    overlay.style.display = 'none';
    unlockByEscape = false;
  } else if (gameStarted && unlockByEscape) {
    // Only show overlay when unlocked by pressing ESC, not alt-tab
    overlay.style.display = 'flex';
    // Fetch cool shots from server when overlay opens
    demoManager?.fetchCoolShotsFromServer();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && gameStarted) {
    if (document.pointerLockElement === renderer.domElement) {
      // Pointer is locked, release it and mark as ESC unlock
      unlockByEscape = true;
      document.exitPointerLock();
    } else if (overlay.style.display === 'flex' && document.pointerLockElement !== renderer.domElement) {
      // Overlay is visible and pointer is unlocked, hide it and re-lock
      overlay.style.display = 'none';
      logger.debug('Requesting pointer lock...');
      requestLock();
    } else if (document.pointerLockElement !== renderer.domElement) {
      // Pointer is unlocked but overlay not visible, show overlay
      overlay.style.display = 'flex';
    }
  }
  if (e.code === 'F4') {
    pixelated = !pixelated;
    localStorage.setItem('fps-pixelated', pixelated.toString());
    updateRendererSize();
    pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';
  }
  if (e.code === 'F6') {
    if (demoManager) demoManager.toggleUI();
  }
  // Space = play/pause during demo playback (also works when paused)
  if (e.code === 'Space' && demoManager?.isLoadedForPlayback) {
    e.preventDefault();
    demoManager.togglePlayPause();
  }
});

// Clicking overlay or canvas re-locks.
document.getElementById('start-btn')!.addEventListener('click', requestLock);
pixelToggleBtn.addEventListener('click', () => {
  pixelated = !pixelated;
  localStorage.setItem('fps-pixelated', pixelated.toString());
  updateRendererSize();
  const w = pixelated
    ? Math.floor(window.innerWidth / PIXEL_SCALE)
    : window.innerWidth;
  const h = pixelated
    ? Math.floor(window.innerHeight / PIXEL_SCALE)
    : window.innerHeight;
  composer.setSize(w, h);
  pixelToggleBtn.textContent = pixelated ? 'PIXELATED: ON' : 'PIXELATED: OFF';
});
postproToggleBtn.addEventListener('click', () => {
  postproEnabled = !postproEnabled;
  localStorage.setItem('fps-postpro', postproEnabled.toString());
  bloomPass.enabled = postproEnabled;
  contrastPass.enabled = postproEnabled;
  postproToggleBtn.textContent = postproEnabled ? 'POST-PROCESSING: ON' : 'POST-PROCESSING: OFF';
});
renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) requestLock();
});

// Hoisted for use in both init() and window-scope debug functions
let pendingServerSnapshot: ((players: any[], timestamp: number) => void) | null = null;

// Auto-start: init immediately, overlay stays hidden until ESC is pressed
init().then(() => {
  gameStarted = true;

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
    
    const snapshot = StateSnapshot.create(playerMap, [...rockets, ...discs], 'client');
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
