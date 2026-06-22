import * as THREE from 'three';
import { createSkyDome } from './sky.js';
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

// Worker-based networking proxy
class WorkerNetworkManager {
  private worker: Worker;
  private localPlayerId: string;
  private players: Map<string, any> = new Map();
  private connected = false;
  private ping = 0;
  private packetLoss = 0;
  private jitter = 0;
  
  // Callbacks
  public onPlayerHit: ((shooterId: string, targetId: string, damage: number) => void) | null = null;
  public onPlayerKill: ((shooterId: string, targetId: string) => void) | null = null;
  public onPlayerRespawn: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;
  public onStateRestore: ((state: any) => void) | null = null;
  public onPlayerJump: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onPlayerJetpack: ((playerId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileCreated: ((projectileId: string, ownerId: string, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileUpdate: ((projectileId: string, position: { x: number; y: number; z: number }) => void) | null = null;
  public onProjectileDestroyed: ((projectileId: string) => void) | null = null;
  public onPlayerJoined: ((playerId: string) => void) | null = null;
  public onPlayerLeft: ((playerId: string) => void) | null = null;
  public onPlayerUpdate: ((playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => void) | null = null;
  public onGameState: ((players: any[], localPlayerState: any) => void) | null = null;
  public onStateReconciliation: ((state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => void) | null = null;

  constructor(playerId: string) {
    this.localPlayerId = playerId;
    console.log('[WorkerNetworkManager] Creating worker...');
    this.worker = new Worker(new URL('./networking/networking.worker.ts', import.meta.url), { type: 'module' });
    console.log('[WorkerNetworkManager] Worker created');
    this.setupWorkerHandlers();
  }

  private setupWorkerHandlers() {
    this.worker.onmessage = (e) => {
      const data = e.data;
      switch (data.type) {
        case 'connected':
          this.connected = true;
          console.log('[WorkerNetworkManager] Connected');
          break;
        case 'disconnected':
          this.connected = false;
          console.log('[WorkerNetworkManager] Disconnected');
          this.players.clear();
          break;
        case 'error':
          console.error('[WorkerNetworkManager] Error:', data.error);
          break;
        case 'playerJoined':
          if (data.playerId !== this.localPlayerId) {
            this.players.set(data.playerId, {
              playerId: data.playerId,
              position: { x: 0, y: 0, z: 0 },
              rotation: { yaw: 0, pitch: 0 },
              timestamp: Date.now()
            });
          }
          if (this.onPlayerJoined) this.onPlayerJoined(data.playerId);
          break;
        case 'playerLeft':
          this.players.delete(data.playerId);
          if (this.onPlayerLeft) this.onPlayerLeft(data.playerId);
          break;
        case 'playerUpdate':
          if (data.playerId !== this.localPlayerId) {
            this.players.set(data.playerId, {
              playerId: data.playerId,
              position: data.position,
              rotation: data.rotation,
              timestamp: data.timestamp
            });
          }
          if (this.onPlayerUpdate) this.onPlayerUpdate(data.playerId, data.position, data.rotation, data.timestamp);
          break;
        case 'gameState':
          data.players.forEach((p: any) => {
            if (p.playerId !== this.localPlayerId) {
              this.players.set(p.playerId, p);
            }
          });
          if (this.onGameState) this.onGameState(data.players, data.localPlayerState);
          break;
        case 'hit':
          if (this.onPlayerHit) this.onPlayerHit(data.shooterId, data.targetId, data.damage);
          break;
        case 'kill':
          if (this.onPlayerKill) this.onPlayerKill(data.shooterId, data.targetId);
          break;
        case 'playerRespawn':
          this.players.set(data.playerId, {
            playerId: data.playerId,
            position: data.position,
            rotation: data.rotation,
            timestamp: Date.now()
          });
          if (this.onPlayerRespawn) this.onPlayerRespawn(data.playerId, data.position, data.rotation);
          break;
        case 'jump':
          if (this.onPlayerJump) this.onPlayerJump(data.playerId, data.position);
          break;
        case 'jetpack':
          if (this.onPlayerJetpack) this.onPlayerJetpack(data.playerId, data.position);
          break;
        case 'projectileCreated':
          if (this.onProjectileCreated) this.onProjectileCreated(data.projectileId, data.ownerId, data.position, data.velocity);
          break;
        case 'projectileUpdate':
          if (this.onProjectileUpdate) this.onProjectileUpdate(data.projectileId, data.position);
          break;
        case 'projectileDestroyed':
          if (this.onProjectileDestroyed) this.onProjectileDestroyed(data.projectileId);
          break;
        case 'stateRestore':
          if (this.onStateRestore) this.onStateRestore(data.state);
          break;
        case 'stateReconciliation':
          if (this.onStateReconciliation) this.onStateReconciliation(data.data);
          break;
        case 'ping':
          this.ping = data.value;
          break;
        case 'packetLoss':
          this.packetLoss = data.value;
          break;
        case 'jitter':
          this.jitter = data.value;
          break;
      }
    };
  }

  async connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        if (e.data.type === 'connected') {
          this.worker.removeEventListener('message', onMessage);
          resolve();
        } else if (e.data.type === 'error') {
          this.worker.removeEventListener('message', onMessage);
          reject(new Error(e.data.error));
        }
      };
      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ type: 'connect', url, playerId: this.localPlayerId });
    });
  }

  disconnect(): void {
    this.worker.postMessage({ type: 'disconnect' });
  }

  sendInput(input: any): void {
    this.worker.postMessage({ type: 'sendInput', input });
  }

  sendPosition(position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }): void {
    this.worker.postMessage({ type: 'sendPosition', position, rotation });
  }

  sendShot(targetId: string | null, position?: { x: number; y: number; z: number }, velocity?: { x: number; y: number; z: number }, timestamp?: number, projectileId?: string | null, directHit?: boolean): void {
    this.worker.postMessage({ type: 'sendShot', targetId, position, velocity, timestamp, projectileId, directHit });
  }

  sendJump(position: { x: number; y: number; z: number }): void {
    this.worker.postMessage({ type: 'sendJump', position });
  }

  sendJetpack(position: { x: number; y: number; z: number }): void {
    this.worker.postMessage({ type: 'sendJetpack', position });
  }

  sendProjectileDestroy(projectileId: string): void {
    this.worker.postMessage({ type: 'sendProjectileDestroy', projectileId });
  }

  getPlayers(): Map<string, any> {
    return this.players;
  }

  getLocalPlayerId(): string {
    return this.localPlayerId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getPing(): number {
    this.worker.postMessage({ type: 'getPing' });
    return this.ping;
  }

  getPacketLoss(): number {
    this.worker.postMessage({ type: 'getPacketLoss' });
    return this.packetLoss;
  }

  getJitter(): number {
    this.worker.postMessage({ type: 'getJitter' });
    return this.jitter;
  }
}

// ---- Renderer ----
const PIXEL_SCALE = 4; // Each pixel is 4x4 screen pixels (Doom-style)
let pixelated = true;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
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
renderer.toneMappingExposure = 1.0;
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
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 6000);

// ---- Scene ----
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x88bbdd, 0.006); // exponential like Tribes 2 - warm haze
renderer.setClearColor(0x88bbdd);

createSkyDome(scene);

// ---- Lighting (Tribes 2 aesthetic: bright overhead sun, warm fill) ----
const ambient = new THREE.AmbientLight(0x886644, 0.5);  // warm brown fill
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffe8aa, 3.2);  // bright warm sun
sun.position.set(300, 600, 100);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 2000;
sun.shadow.camera.left = -600;
sun.shadow.camera.right = 600;
sun.shadow.camera.top = 600;
sun.shadow.camera.bottom = -600;
scene.add(sun);

const hemi = new THREE.HemisphereLight(0x5599cc, 0x664422, 0.5);  // blue sky top, warm earth bounce
scene.add(hemi);

// ---- Game state ----
let terrain: Terrain;
let player: Player;
let hud: HUD;
let networkManager: WorkerNetworkManager;
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

const BALL_MAX = 20;
const BALL_SPAWN_INTERVAL = 2.5;
let ballTimer = 0;

// ---- Score display ----
const scoreDiv = document.createElement('div');
scoreDiv.style.cssText = `
  position:absolute; top:calc(50% - 60px); left:50%; transform:translate(-50%,-100%);
  font-family:sans-serif; font-size:1rem; color:#fff;
  text-shadow:1px 1px 3px #000;
  pointer-events:none; text-align:center; white-space:pre; line-height:1.5;
  opacity:0; transition:opacity 0.5s ease;
`;
document.body.appendChild(scoreDiv);

function showFragMessage(msg: string): void {
  scoreDiv.textContent = msg;
  scoreDiv.style.transition = 'none';
  scoreDiv.style.opacity = '1';
  clearTimeout((scoreDiv as any)._t);
  (scoreDiv as any)._t = setTimeout(() => {
    scoreDiv.style.transition = 'opacity 0.5s ease';
    scoreDiv.style.opacity = '0';
  }, 2000);
}

// ---- Rocket fire handler ----
const pendingLocalRockets: Rocket[] = []; // queue: rockets waiting for server projectileId
const localRocketById = new Map<string, Rocket>(); // server projectileId -> local Rocket

function onFire(e: { origin: THREE.Vector3; dir: THREE.Vector3; playerVel: THREE.Vector3 }): void {
  const r = new Rocket(scene, e.origin, e.dir, e.playerVel);
  rockets.push(r);
  pendingLocalRockets.push(r);
  
  // Send shot to server with projectile position/velocity for tracking
  const velocity = e.dir.clone().multiplyScalar(120.0); // ROCKET_SPEED
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
  const cutoff = Date.now() - 2000;
  while (recentExplosions.length > 0 && recentExplosions[0].timestamp < cutoff) {
    recentExplosions.shift();
  }

  // Knock back player
  const dpx = player.pos.distanceTo(pos);
  if (dpx < radius * 2.5) {
    const falloff = 1 - dpx / (radius * 2.5);
    player.applyKnockback(pos, force * falloff);
  }

  // Damage + knockback balls
  for (const ball of balls) {
    if (ball.dead) continue;
    const db = ball.pos.distanceTo(pos);
    if (db < radius + ball.radius) {
      ball.applyKnockback(pos, force * 0.4);
    }
  }
}

// ---- Disc explosion processing (pull instead of push) ----
function processDiscExplosion(pos: THREE.Vector3, radius: number, force: number): void {
  const imp = new Implosion(scene, pos);
  implosions.push(imp);

  // Pull player toward explosion
  const dpx = player.pos.distanceTo(pos);
  if (dpx < radius * 3.0) {
    const falloff = 1 - dpx / (radius * 3.0);
    player.applyPull(pos, force * falloff);
  }

  // Pull balls toward explosion
  for (const ball of balls) {
    if (ball.dead) continue;
    const db = ball.pos.distanceTo(pos);
    if (db < radius * 2.0 + ball.radius) {
      ball.applyPull(pos, force * 0.5);
    }
  }
}

// ---- Update rockets ----
function updateRockets(dt: number): void {
  for (let i = rockets.length - 1; i >= 0; i--) {
    const r = rockets[i];
    
    // Get remote player positions for collision (skip dead players)
    const remotePlayerPositions = new Map<string, THREE.Vector3>();
    remotePlayers.forEach((rp, playerId) => {
      // Skip dead players for collision detection
      if ((rp as any).isDead) return;
      remotePlayerPositions.set(playerId, rp.position);
      if (Math.random() < 0.01) { // occasional debug log
        console.log(`[Main] Remote player ${playerId} at ${rp.position.x.toFixed(1)},${rp.position.y.toFixed(1)},${rp.position.z.toFixed(1)}`);
      }
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
        const maxDist = 8.0; // HIT_MAX
        const accRaw = r.hitAccuracy;
        let acc = 1 + Math.max(0, 9 - (accRaw / maxDist * 9));
        if (r.directHit) acc = 10; // direct core hit = max accuracy
        const dist  = r.hitDistance;
        const air   = r.hitAge;
        const score = Math.round(acc * dist * air);
        console.log(`[HIT] direct=${r.directHit} accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        if (destroyed) {
          debrisList.push(new BallDebris(scene, terrain, ball.pos.x, ball.pos.y, ball.pos.z, ball.color, ball.scale));
          player.kills++;
        }
        showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();
      }

      if (r.hitPlayerId) {
        // Calculate score for player hit (same formula as ball)
        const maxDist = 8.0; // HIT_MAX
        const accRaw = r.hitAccuracy;
        let acc = 1 + Math.max(0, 9 - (accRaw / maxDist * 9));
        if (r.directHit) acc = 10; // direct core hit = max accuracy
        const dist  = r.hitDistance;
        const air   = r.hitAge;
        const score = Math.round(acc * dist * air);
        console.log(`[PVP HIT] direct=${r.directHit} accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
        showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        hud.showHitMarker();
      }
      
      if (r.hitPlayerId && networkManager) {
        // Send hit event to server with position/velocity/timestamp/projectileId/directHit for lag compensation
        networkManager.sendShot(r.hitPlayerId, { x: r.pos.x, y: r.pos.y, z: r.pos.z }, { x: r.vel.x, y: r.vel.y, z: r.vel.z }, Date.now(), r.serverProjectileId, r.directHit);
        console.log(`[HIT PLAYER] Hit player ${r.hitPlayerId} with projectile ${r.serverProjectileId}, direct=${r.directHit}`);
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
          let acc = 1 + 9 * (1 - accRaw / 8.0); // 1-10 scale
          const dist = d.hitDistance;
          const air = d.hitAge;
          const score = Math.round(acc * dist * air);
          console.log(`[DISC HIT BALL] accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
          showFragMessage(`${acc.toFixed(1)} · ${Math.round(dist)} · ${air.toFixed(2)}s\n${score}`);
        }
      }

      if (d.hitPlayerId && networkManager) {
        // Send hit event to server
        networkManager.sendShot(d.hitPlayerId, { x: d.pos.x, y: d.pos.y, z: d.pos.z }, { x: d.vel.x, y: d.vel.y, z: d.vel.z }, Date.now(), null, false);
        console.log(`[HIT PLAYER] Disc hit player ${d.hitPlayerId}`);
        
        // Calculate score for player hit
        const accRaw = d.hitAccuracy;
        let acc = 1 + 9 * (1 - accRaw / 8.0); // 1-10 scale
        const dist = d.hitDistance;
        const air = d.hitAge;
        const score = Math.round(acc * dist * air);
        console.log(`[DISC PVP HIT] accRaw=${accRaw.toFixed(2)} acc=${acc.toFixed(1)} dist=${dist.toFixed(1)} air=${air.toFixed(2)}s score=${score}`);
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
  const dt = Math.min((time - lastTime) / 1000, 0.05);
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

    players.forEach((playerState, playerId) => {
      // Skip local player - don't create RemotePlayer for self
      if (playerId === networkManager.getLocalPlayerId()) {
        return;
      }

      let remotePlayer = remotePlayers.get(playerId);
      if (!remotePlayer) {
        console.log('[Main] Creating new RemotePlayer for', playerId, 'at', playerState.position);
        remotePlayer = new RemotePlayer(scene, playerId, playerState.position, terrain);
        remotePlayers.set(playerId, remotePlayer);
      }
      // RemotePlayer.update is called via onPlayerUpdate callback to store target position
      // Call tick() every frame for smooth interpolation
      remotePlayer.tick(dt);
      if ((remotePlayer as any).model && (remotePlayer as any).loaded) {
        (remotePlayer as any).model.update(dt);
      }
    });

    if (remotePlayers.size !== previousRemoteCount) {
      console.log('[Main] Remote players in scene:', remotePlayers.size);
    }
    
    // Remove disconnected players
    for (const [playerId, remotePlayer] of remotePlayers) {
      if (!players.has(playerId)) {
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
      }
      // Remove dead players that have shrunk to 0
      if ((remotePlayer as any).scale === 0) {
        remotePlayer.dispose();
        remotePlayers.delete(playerId);
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
  player.onNetworkJump = (pos) => networkManager.sendJump(pos);
  player.onNetworkJetpack = (pos) => networkManager.sendJetpack(pos);
  hud = new HUD();

  // Load player model
  await player.loadModel();

  // Initialize networking with worker
  const playerId = localStorage.getItem('playerId') || Math.random().toString(36).substr(2, 9);
  if (!localStorage.getItem('playerId')) localStorage.setItem('playerId', playerId);
  networkManager = new WorkerNetworkManager(playerId);
  
  // Register player hit handler (non-lethal hits)
  networkManager.onPlayerHit = (shooterId: string, targetId: string, damage: number) => {
    // Check if local player was hit
    if (targetId === networkManager.getLocalPlayerId()) {
      console.log(`[Main] Local player hit for ${damage} damage by ${shooterId}`);
      return;
    }

    // Non-lethal hits don't trigger death animation
    console.log(`[Main] Remote player ${targetId} hit for ${damage} damage by ${shooterId}`);
  };

  // Register player kill handler (lethal kills)
  networkManager.onPlayerKill = (shooterId: string, targetId: string) => {
    // Check if local player was killed
    if (targetId === networkManager.getLocalPlayerId()) {
      console.log(`[Main] Local player killed by ${shooterId}`);
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

      console.log(`[Main] Player ${targetId} killed by ${shooterId}`);
    }
  };

  // Register jump handler for remote players
  networkManager.onPlayerJump = (playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    effects.spawnJumpDust(pos);
    console.log(`[Main] Remote player ${playerId} jumped at`, position);
  };

  // Register jetpack handler for remote players
  networkManager.onPlayerJetpack = (playerId: string, position: { x: number; y: number; z: number }) => {
    const pos = new THREE.Vector3(position.x, position.y, position.z);
    effects.spawnJetpack(pos);
    console.log(`[Main] Remote player ${playerId} jetpacking at`, position);
  };

  // Register player update handler for remote players
  networkManager.onPlayerUpdate = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, timestamp: number) => {
    let remotePlayer = remotePlayers.get(playerId);
    if (remotePlayer) {
      remotePlayer.update(position, rotation, 0.016); // Store target position for interpolation
      if (Math.random() < 0.05) { // 5% of updates log for debugging
        console.log(`[Main] onPlayerUpdate: ${playerId} at ${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}`);
      }
    } else {
      console.log('[Main] onPlayerUpdate called for unknown player:', playerId, 'creating...');
      remotePlayer = new RemotePlayer(scene, playerId, position, terrain);
      remotePlayers.set(playerId, remotePlayer);
    }
  };

  // Register state reconciliation handler for client-side prediction
  networkManager.onStateReconciliation = (state: { position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }, velocity: { x: number; y: number; z: number }, lastProcessedSequence: number }) => {
    console.log(`[Main] State reconciliation: pos(${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}) seq=${state.lastProcessedSequence}`);
    
    // Reconcile client state with server authoritative state
    // For now, we'll snap to server position. In a full implementation,
    // we would replay unprocessed inputs from the reconciliation point
    player.pos.set(state.position.x, state.position.y, state.position.z);
    player.vel.set(state.velocity.x, state.velocity.y, state.velocity.z);
    player.yaw = state.rotation.yaw;
    player.pitch = state.rotation.pitch;
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
    }
  };
  
  // Register player respawn handler
  networkManager.onPlayerRespawn = (playerId: string, position: { x: number; y: number; z: number }, rotation: { yaw: number; pitch: number }) => {
    // Check if local player respawned
    if (playerId === networkManager.getLocalPlayerId()) {
      console.log(`[Main] Local player respawned at`, position);
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
    console.log(`[Main] Player ${playerId} respawned at`, position);
  };
  
  // Register state restore handler (for reconnection)
  networkManager.onStateRestore = (state) => {
    console.log(`[Main] Restoring player state:`, state);
    
    // Restore position
    player.pos.set(state.position.x, state.position.y, state.position.z);
    player.yaw = state.rotation.yaw;
    player.pitch = state.rotation.pitch;
    
    // If player was dead, they'll respawn normally via server logic
    // If alive, they continue from their last position
    console.log(`[Main] Player position restored to`, state.position);
  };
  
  // Connect to server (uses Vite proxy at /server)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/server`;
  try {
    await networkManager.connect(wsUrl);
    console.log('[Main] Connected to multiplayer server via', wsUrl);
  } catch (error) {
    console.error('[Main] Failed to connect to server:', error);
  }

  // Initial balls
  for (let i = 0; i < 8; i++) spawnBall();

  // Track jet button for continuous particles
  document.addEventListener('mousedown', (e) => { if (e.button === 2) (document as any)._jetActive = true; });
  document.addEventListener('mouseup', (e) => { if (e.button === 2) (document as any)._jetActive = false; });

  // Detect tab visibility changes to keep sending position when alt-tabbed
  document.addEventListener('visibilitychange', () => {
    isTabHidden = document.hidden;
    console.log('[Main] Tab visibility changed:', isTabHidden ? 'hidden' : 'visible');
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
  if (document.pointerLockElement === renderer.domElement) {
    overlay.style.display = 'none';
  }
  // Never auto-show overlay — only ESC keydown does that
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && gameStarted && document.pointerLockElement !== renderer.domElement) {
    overlay.style.display = 'flex';
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
