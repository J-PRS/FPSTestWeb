import * as THREE from '../node_modules/@types/three';
import { NetworkManager } from './systems/NetworkManager';

// Game constants (matching Heaps client)
const WALK_SPEED = 7.0;
const JUMP_IMPULSE = 11.25;
const GRAVITY = -20.0;
const JET_FORCE_UP = 19.6;
const JET_FORCE_DIR = 14.0;
const AIR_CONTROL = 8.0;
const MAX_ENERGY = 60.0;
const JET_DRAIN = 12.0;
const JET_CHARGE = 8.0;
const PLAYER_HEIGHT = 1.8;
const FIRE_RATE = 1.0;
const MAX_AMMO = 10;
const RELOAD_TIME = 2.0;

class Player {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number = 0;
  pitch: number = 0;
  onGround: boolean = false;
  energy: number = MAX_ENERGY;
  jumpCooldown: number = 0;
  health: number = 100;
  ammo: number = MAX_AMMO;
  kills: number = 0;
  isReloading: boolean = false;
  reloadTimer: number = 0;
  fireTimer: number = 0;
  isDead: boolean = false;
  team: number = 0; // 0 = red, 1 = blue
  respawnTimer: number = 0;
  spectatorTarget: any = null;

  // Input state
  keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; } = { w: false, a: false, s: false, d: false, space: false };
  mouseHeld: boolean = false;
  jetPending: boolean = false;

  constructor() {
    this.position = new THREE.Vector3(0, 10, 0);
    this.velocity = new THREE.Vector3(0, 0, 0);
  }

  getForwardXZ(): THREE.Vector3 {
    const lookDir = this.getLookDirection();
    return new THREE.Vector3(lookDir.x, 0, lookDir.z).normalize();
  }

  getRightXZ(): THREE.Vector3 {
    const lookDir = this.getLookDirection();
    return new THREE.Vector3(-lookDir.z, 0, lookDir.x).normalize();
  }

  getLookDirection(): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw)
    ).normalize();
  }

  update(dt: number, terrain: Terrain) {
    if (this.isDead) {
      this.respawnTimer -= dt;
      return;
    }

    this.handleInput(dt);
    this.applyPhysics(dt, terrain);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.reloadTimer = Math.max(0, this.reloadTimer - dt);

    // Energy recharge
    this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * dt);

    // Reload logic
    if (this.isReloading && this.reloadTimer <= 0) {
      this.isReloading = false;
      this.ammo = MAX_AMMO;
    }
  }

  handleInput(dt: number) {
    const forward = this.getForwardXZ();
    const right = this.getRightXZ();

    const moveDir = new THREE.Vector3(0, 0, 0);
    if (this.keys.w) { moveDir.add(forward); }
    if (this.keys.s) { moveDir.sub(forward); }
    if (this.keys.a) { moveDir.sub(right); }
    if (this.keys.d) { moveDir.add(right); }

    if (moveDir.length() > 0) moveDir.normalize();

    const isJumping = this.keys.space;
    const isJetting = this.jetPending && !this.onGround && this.energy > 0;

    // Ground movement
    if (this.onGround) {
      const targetX = moveDir.x * WALK_SPEED;
      const targetZ = moveDir.z * WALK_SPEED;
      this.velocity.x += (targetX - this.velocity.x) * 0.5;
      this.velocity.z += (targetZ - this.velocity.z) * 0.5;
    }

    // Jump
    if (isJumping && this.onGround && this.jumpCooldown <= 0) {
      this.velocity.y = JUMP_IMPULSE;
      this.onGround = false;
      this.jumpCooldown = 0.3;
    }

    // Jetpack
    if (isJetting) {
      this.velocity.y += JET_FORCE_UP * dt;
      this.velocity.x += moveDir.x * JET_FORCE_DIR * dt;
      this.velocity.z += moveDir.z * JET_FORCE_DIR * dt;
      this.energy -= JET_DRAIN * dt;
    }

    // Air control
    if (!this.onGround && !isJetting && moveDir.length() > 0) {
      this.velocity.x += moveDir.x * AIR_CONTROL * dt;
      this.velocity.z += moveDir.z * AIR_CONTROL * dt;
    }
  }

  applyPhysics(dt: number, terrain: Terrain) {
    // Gravity
    this.velocity.y += GRAVITY * dt;

    // Integrate
    this.position.add(this.velocity.clone().multiplyScalar(dt));

    // Terrain collision
    const groundY = terrain.getHeight(this.position.x, this.position.z) + PLAYER_HEIGHT;
    if (this.position.y <= groundY) {
      this.position.y = groundY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
  }

  wantsToFire(): boolean {
    if (this.isDead || this.isReloading) return false;
    if (this.ammo <= 0) {
      this.isReloading = true;
      this.reloadTimer = RELOAD_TIME;
      return false;
    }
    if ((this.mouseHeld) && this.fireTimer <= 0) {
      this.fireTimer = FIRE_RATE;
      this.ammo--;
      if (this.ammo <= 0) {
        this.isReloading = true;
        this.reloadTimer = RELOAD_TIME;
      }
      return true;
    }
    return false;
  }

  takeDamage(amount: number) {
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0 && !this.isDead) {
      this.isDead = true;
      this.respawnTimer = 3.0; // 3 second respawn
    }
  }

  resetHealth() {
    this.health = 100;
    this.isDead = false;
    this.respawnTimer = 0;
    this.spectatorTarget = null;
    this.ammo = MAX_AMMO;
    this.energy = MAX_ENERGY;
  }
}

class Terrain {
  scene: THREE.Scene;
  mesh: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    
    const segments = 40;
    const size = 500;
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const indices: number[] = [];
    const half = size / 2;
    const step = size / segments;

    for (let row = 0; row <= segments; row++) {
      for (let col = 0; col <= segments; col++) {
        const x = -half + col * step;
        const z = -half + row * step;
        const y = this.getHeight(x, z);
        positions.push(x, y, z);
      }
    }

    for (let row = 0; row < segments; row++) {
      for (let col = 0; col < segments; col++) {
        const a = row * (segments + 1) + col;
        const b = a + 1;
        const c = a + (segments + 1);
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    
    const material = new THREE.MeshBasicMaterial({ 
      color: 0x3d7a3d,
      side: THREE.DoubleSide,
      wireframe: true
    });
    
    this.mesh = new THREE.Mesh(geometry, material);
    scene.add(this.mesh);
  }

  getHeight(x: number, z: number): number {
    return Math.sin(x * 0.01) * Math.cos(z * 0.01) * 100;
  }
}

class RocketTrail {
  points: THREE.Vector3[] = [];
  line: THREE.Line;
  dead: boolean = false;
  lifetime: number = 0;
  maxLifetime: number = 2.0;

  constructor(scene: THREE.Scene) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(100 * 3); // Max 100 points
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    const material = new THREE.LineBasicMaterial({ 
      color: 0xff6600,
      transparent: true,
      opacity: 0.8
    });
    
    this.line = new THREE.Line(geometry, material);
    scene.add(this.line);
  }

  addPoint(x: number, y: number, z: number, _prevX: number, _prevY: number, _prevZ: number) {
    this.points.push(new THREE.Vector3(x, y, z));
    if (this.points.length > 100) {
      this.points.shift();
    }
    this.updateLine();
  }

  updateLine() {
    const positions = this.line.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < this.points.length; i++) {
      positions[i * 3] = this.points[i].x;
      positions[i * 3 + 1] = this.points[i].y;
      positions[i * 3 + 2] = this.points[i].z;
    }
    this.line.geometry.setDrawRange(0, this.points.length);
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  update(dt: number) {
    this.lifetime += dt;
    (this.line.material as THREE.Material).opacity = 0.8 * (1 - this.lifetime / this.maxLifetime);
    
    if (this.lifetime >= this.maxLifetime) {
      this.dead = true;
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.line);
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}

class Rocket {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  velocity: THREE.Vector3;
  prevPosition: THREE.Vector3;
  dead: boolean = false;
  trail: RocketTrail;

  constructor(scene: THREE.Scene, position: THREE.Vector3, direction: THREE.Vector3, playerVelocity: THREE.Vector3) {
    this.position = position.clone();
    this.prevPosition = position.clone();
    this.direction = direction.clone().normalize();
    this.velocity = this.direction.clone().multiplyScalar(50).add(playerVelocity);
    
    const geometry = new THREE.SphereGeometry(0.2, 8, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xff4400 });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);

    this.trail = new RocketTrail(scene);
  }

  update(dt: number, terrain: Terrain) {
    this.prevPosition.copy(this.position);
    this.velocity.y += GRAVITY * dt * 0.5;
    this.position.add(this.velocity.clone().multiplyScalar(dt));
    this.mesh.position.copy(this.position);

    // Update trail
    this.trail.addPoint(
      this.position.x, this.position.y, this.position.z,
      this.prevPosition.x, this.prevPosition.y, this.prevPosition.z
    );
    this.trail.update(dt);

    // Ground collision
    const groundY = terrain.getHeight(this.position.x, this.position.z);
    if (this.position.y <= groundY) {
      this.dead = true;
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.trail.dispose(scene);
  }
}

class Explosion {
  mesh: THREE.Mesh;
  dead: boolean = false;
  lifetime: number = 0;

  constructor(scene: THREE.Scene, position: THREE.Vector3) {
    const geometry = new THREE.SphereGeometry(3, 16, 16);
    const material = new THREE.MeshBasicMaterial({ 
      color: 0xffaa00,
      transparent: true,
      opacity: 0.8
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(position);
    scene.add(this.mesh);
  }

  update(dt: number) {
    this.lifetime += dt;
    this.mesh.scale.multiplyScalar(1.05);
    (this.mesh.material as THREE.Material).opacity = 0.8 - (this.lifetime * 0.8);
    
    if (this.lifetime >= 1.0) {
      this.dead = true;
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

async function main() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  
  // Scene setup
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  // Disable fog temporarily to see terrain
  // scene.fog = new THREE.Fog(0x87CEEB, 50, 300);

  // Add grid helper for visibility
  const gridHelper = new THREE.GridHelper(500, 50, 0x000000, 0x444444);
  scene.add(gridHelper);
  
  // Camera
  const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 6000);
  camera.position.set(0, 10, 0);
  
  // Renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  
  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
  directionalLight.position.set(5, 10, 5);
  scene.add(directionalLight);
  
  // Game objects
  const terrain = new Terrain(scene);
  const player = new Player();
  const network = new NetworkManager('ws://localhost:8095');
  const rockets: Rocket[] = [];
  const explosions: Explosion[] = [];
  const fadingTrails: RocketTrail[] = [];

  // Terrain debug: sample getHeight() on a grid and show sphere gizmos
  const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const sphereGeo = new THREE.SphereGeometry(1, 6, 6);
  const step = 20;
  const range = 200;
  for (let x = -range; x <= range; x += step) {
    for (let z = -range; z <= range; z += step) {
      const y = terrain.getHeight(x, z);
      console.log(`SAMPLE x=${x} y=${y.toFixed(1)} z=${z}`);
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.position.set(x, y, z);
      scene.add(sphere);
    }
  }


  // Input handling
  document.addEventListener('click', () => {
    if (document.pointerLockElement === null) {
      canvas.requestPointerLock();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== null) {
      player.yaw -= e.movementX * 0.002;
      player.pitch += e.movementY * 0.002;
      player.pitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, player.pitch));
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (e.button === 0) player.mouseHeld = true;
    if (e.button === 2) player.jetPending = true;
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) player.mouseHeld = false;
    if (e.button === 2) player.jetPending = false;
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    switch(e.code) {
      case 'KeyW': player.keys.w = true; break;
      case 'KeyA': player.keys.a = true; break;
      case 'KeyS': player.keys.s = true; break;
      case 'KeyD': player.keys.d = true; break;
      case 'Space': player.keys.space = true; break;
    }
  });

  document.addEventListener('keyup', (e) => {
    switch(e.code) {
      case 'KeyW': player.keys.w = false; break;
      case 'KeyA': player.keys.a = false; break;
      case 'KeyS': player.keys.s = false; break;
      case 'KeyD': player.keys.d = false; break;
      case 'Space': player.keys.space = false; break;
    }
  });

  // Handle resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // HUD
  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.top = '10px';
  hud.style.left = '10px';
  hud.style.color = 'white';
  hud.style.fontFamily = 'monospace';
  hud.style.fontSize = '14px';
  hud.style.textShadow = '1px 1px 2px black';
  document.body.appendChild(hud);

  // Network state
  let networkTimer = 0;
  let pingTimer = 0;
  const NETWORK_UPDATE_RATE = 0.05;
  const PING_INTERVAL = 1.0;
  let inputSequence = 0;

  let lastTime = performance.now();

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);
    
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // Update player
    player.update(dt, terrain);

    // Network updates
    network.update(dt);
    networkTimer += dt;
    pingTimer += dt;

    if (networkTimer >= NETWORK_UPDATE_RATE) {
      networkTimer = 0;
      network.sendPlayerPosition(
        { x: player.position.x, y: player.position.y, z: player.position.z },
        { x: player.pitch, y: player.yaw, z: 0 },
        inputSequence++
      );
    }

    if (pingTimer >= PING_INTERVAL) {
      pingTimer = 0;
      network.sendPing();
    }

    // Update camera
    if (player.isDead) {
      // Spectator mode
      if (player.spectatorTarget) {
        const target = player.spectatorTarget;
        const yaw = target.rotation?.y || 0;
        const dist = 8.0;
        const height = 3.0;
        
        const cx = target.position?.x || 0 - Math.sin(yaw) * dist;
        const cy = (target.position?.y || 0) + height;
        const cz = (target.position?.z || 0) - Math.cos(yaw) * dist;
        
        camera.position.set(cx, cy, cz);
        camera.lookAt(
          target.position?.x || 0,
          (target.position?.y || 0) + 1.5,
          target.position?.z || 0
        );
      } else {
        // Free spectator camera
        camera.position.copy(player.position);
        const lookDir = player.getLookDirection();
        const tx = player.position.x + lookDir.x;
        const ty = player.position.y + lookDir.y;
        const tz = player.position.z + lookDir.z;
        camera.lookAt(tx, ty, tz);
      }
    } else {
      // Normal first-person camera
      camera.position.copy(player.position);
      const lookDir = player.getLookDirection();
      const tx = player.position.x + lookDir.x;
      const ty = player.position.y + lookDir.y;
      const tz = player.position.z + lookDir.z;
      camera.lookAt(tx, ty, tz);
    }

    // Fire rocket
    if (player.wantsToFire()) {
      const camDir = new THREE.Vector3(
        Math.cos(player.pitch) * Math.sin(player.yaw),
        Math.sin(player.pitch),
        Math.cos(player.pitch) * Math.cos(player.yaw)
      ).normalize();
      
      const spawnPos = player.position.clone().add(camDir.clone().multiplyScalar(0.5));
      const rocket = new Rocket(scene, spawnPos, camDir, player.velocity);
      rockets.push(rocket);

      // Send to network
      network.sendRocketFire(
        { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
        { x: camDir.x, y: camDir.y, z: camDir.z }
      );
    }

    // Update rockets
    for (let i = rockets.length - 1; i >= 0; i--) {
      rockets[i].update(dt, terrain);
      if (rockets[i].dead) {
        explosions.push(new Explosion(scene, rockets[i].position));
        network.sendRocketExplode({ x: rockets[i].position.x, y: rockets[i].position.y, z: rockets[i].position.z });
        fadingTrails.push(rockets[i].trail);
        rockets[i].mesh.geometry.dispose();
        (rockets[i].mesh.material as THREE.Material).dispose();
        scene.remove(rockets[i].mesh);
        rockets.splice(i, 1);
      }
    }

    // Update fading trails
    for (let i = fadingTrails.length - 1; i >= 0; i--) {
      fadingTrails[i].update(dt);
      if (fadingTrails[i].dead) {
        fadingTrails[i].dispose(scene);
        fadingTrails.splice(i, 1);
      }
    }

    // Update explosions
    for (let i = explosions.length - 1; i >= 0; i--) {
      explosions[i].update(dt);
      if (explosions[i].dead) {
        explosions[i].dispose(scene);
        explosions.splice(i, 1);
      }
    }

    // Update HUD
    const speed = Math.sqrt(player.velocity.x**2 + player.velocity.z**2);
    const netStatus = network.getConnected() ? 'CONNECTED' : 'OFFLINE';
    const netColor = network.getConnected() ? '#00FF00' : '#FF0000';
    const quality = Math.round(network.getNetworkQuality() * 100);
    const latency = network.getLatency();
    const teamColor = player.team === 0 ? '#FF4444' : '#4444FF';
    const teamName = player.team === 0 ? 'RED' : 'BLUE';
    
    let statusText = '';
    if (player.isDead) {
      statusText = `<span style="color: #FF0000; font-size: 18px;">YOU ARE DEAD - RESPAWN IN ${Math.ceil(player.respawnTimer)}s</span><br>`;
    }
    
    hud.innerHTML = `
      ${statusText}
      Speed: ${Math.round(speed)}<br>
      Energy: ${Math.round(player.energy)}/${MAX_ENERGY}<br>
      Health: ${Math.round(player.health)}/100<br>
      Ammo: ${player.ammo}/${MAX_AMMO}<br>
      Kills: ${player.kills}<br>
      <span style="color: ${teamColor}">TEAM: ${teamName}</span><br>
      ${player.onGround ? 'GROUND' : 'AIR'}<br>
      <span style="color: ${netColor}">NET: ${netStatus} ${quality}% PING: ${latency}ms</span><br>
      WASD=move SPACE=jump RMB=jetpack LMB=fire
    `;

    renderer.render(scene, camera);
  }

  animate();
  console.log('Rundot FPS Game started!');
}

main().catch(console.error);
