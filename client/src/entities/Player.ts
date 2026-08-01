import * as THREE from 'three';

import { JET_FORCE_UP, JET_FORCE_DIR, MAX_ENERGY, JET_DRAIN, JET_CHARGE, FIRE_RATE, DISC_RATE, GRENADE_RATE } from '../core/config.js';

import { Terrain } from '../world/terrain.js';

import { MovementController, MovementState } from './movement.js';
import { PlayerModel, AnimationState } from './PlayerModel.js';

export interface FireEvent {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  playerVel: THREE.Vector3;
}

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0.0;
  pitch = 0.0;
  // Invert vertical mouse look ("flight sim" style). Persisted in localStorage.
  invertY = localStorage.getItem('fps-invert-y') === 'true';

  onGround = false;
  energy = MAX_ENERGY;
  fireTimer = 0.0;
  discTimer = 0.0;
  grenadeTimer = 0.0;
  health = 100;
  kills = 0;
  isDead = false;
  inputFrozen = false; // when true, keyboard/mouse input is ignored (demo playback)

  freezeInput(): void {
    this.inputFrozen = true;
    // Clear all tracked input so nothing leaks from before playback
    this.keys = {};
    this.mouseHeld = false;
    this.firePending = false;
    this.jetPending = false;
    this.jumpHeld = false;
    this.discHeld = false;
    this.grenadeHeld = false;
  }

  unfreezeInput(): void {
    this.inputFrozen = false;
  }

  private terrain: Terrain;
  private camera: THREE.PerspectiveCamera;
  public movement: MovementController; // Public for client-side prediction reconciliation
  private model: PlayerModel | null = null;
  private jumpAnimTimer = 0.0;
  private wasOnGround = false;
  private shadowBlob: THREE.Mesh | null = null;
  private groundGizmo: THREE.Mesh | null = null;

  // Input state
  private keys: Record<string, boolean> = {};
  private mouseHeld = false;
  private firePending = false;
  private jetPending = false;
  private jumpHeld = false;
  private discHeld = false;
  private grenadeHeld = false;
  private _lastJetpackSend = 0;

  // Events
  onFire: ((e: FireEvent) => void) | null = null;
  onJump: ((pos: THREE.Vector3) => void) | null = null;
  onJetpack: ((pos: THREE.Vector3) => void) | null = null;
  onSki: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;
  onDisc: ((e: FireEvent) => void) | null = null;
  onGrenade: ((e: FireEvent) => void) | null = null;
  onNetworkJump: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkJetpack: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkInput: ((input: { forward: number; right: number; jump: number; ski: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;

  constructor(terrain: Terrain, camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
    this.terrain = terrain;
    this.camera = camera;

    const startH = terrain.getHeight(0, 0);
    this.pos.set(0, startH + 10, 0);

    // Initialize movement controller
    const movementState: MovementState = {
      pos: this.pos,
      vel: this.vel,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    };
    this.movement = new MovementController(terrain, movementState);

    // Initialize player model
    this.model = new PlayerModel(scene);

    // Create simple shadow blob for first-person view with soft edges
    const shadowGeo = new THREE.CircleGeometry(0.8, 32);
    const shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0x000000) },
        opacity: { value: 0.4 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying vec2 vUv;
        void main() {
          float dist = distance(vUv, vec2(0.5));
          float alpha = smoothstep(0.5, 0.2, dist) * opacity;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false
    });
    this.shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowBlob.rotation.x = -Math.PI / 2; // Lay flat on ground
    this.shadowBlob.renderOrder = 999; // Render after terrain
    scene.add(this.shadowBlob);

    // Ground check gizmo — small green wireframe sphere at feet position
    const gizmoGeo = new THREE.SphereGeometry(0.12, 8, 6);
    const gizmoMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false, depthWrite: false });
    this.groundGizmo = new THREE.Mesh(gizmoGeo, gizmoMat);
    this.groundGizmo.renderOrder = 1000;
    scene.add(this.groundGizmo);

    this.bindInput();
  }

  async loadModel(): Promise<void> {
    if (this.model) {
      await this.model.load();
      // Hide model for first-person view
      this.model.setVisible(false);
      // Hide collider gizmo for local player (only show for remote players)
      this.model.setColliderVisible(false);
    }
  }

  private bindInput(): void {
    document.addEventListener('keydown', (e) => {
      if (this.inputFrozen) return;
      this.keys[e.code] = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.jumpHeld = true;
      }
      if (e.code === 'KeyC') {
        this.discHeld = true;
      }
      if (e.code === 'KeyF') {
        this.grenadeHeld = true;
      }
    });
    document.addEventListener('keyup', (e) => {
      if (this.inputFrozen) return;
      this.keys[e.code] = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.jumpHeld = false;
      }
      if (e.code === 'KeyC') {
        this.discHeld = false;
      }
      if (e.code === 'KeyF') {
        this.grenadeHeld = false;
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (this.inputFrozen) return;
      if (!document.pointerLockElement) return; // ignore clicks that lock the cursor
      if (e.button === 0) { this.firePending = true; this.mouseHeld = true; }
      if (e.button === 2) { this.jetPending = true; }
    });
    document.addEventListener('mouseup', (e) => {
      if (this.inputFrozen) return;
      if (e.button === 0) this.mouseHeld = false;
      if (e.button === 2) { this.jetPending = false; }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement && !this.inputFrozen) {
        this.yaw   -= e.movementX * 0.002;
        this.pitch += e.movementY * 0.002 * (this.invertY ? 1 : -1);
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
      }
    });

    // Wire the ESC-menu toggle for inverted vertical mouse look
    const invertYBtn = document.getElementById('invert-y-toggle') as HTMLButtonElement | null;
    if (invertYBtn) {
      invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      invertYBtn.addEventListener('click', () => {
        this.invertY = !this.invertY;
        localStorage.setItem('fps-invert-y', this.invertY.toString());
        invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      });
    }
  }

  private getForwardXZ(): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
  }
  private getRightXZ(): THREE.Vector2 {
    return new THREE.Vector2(-Math.cos(this.yaw), Math.sin(this.yaw));
  }

  getInputState(): { forward: number; right: number; jumpPressed: boolean; jumpHeld: boolean; skiHeld: boolean; firePressed: boolean; jetHeld: boolean; discHeld: boolean; grenadeHeld: boolean } {
    let forward = 0, right = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    forward += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  forward -= 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  right -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) right += 1;

    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward,
      right,
      jumpPressed: this.jumpHeld,
      jumpHeld: this.jumpHeld,
      skiHeld: this.keys['Space'] || false,
      firePressed: this.firePending,
      jetHeld: this.jetPending,
      discHeld: this.discHeld,
      grenadeHeld: this.grenadeHeld
    };
  }

  update(dt: number): void {
    if (this.isDead) return;

    if (this.inputFrozen) {
      // Still update camera for demo playback
      this.camera.position.copy(this.pos);
      const tx = this.pos.x + Math.cos(this.pitch) * Math.sin(this.yaw);
      const ty = this.pos.y + Math.sin(this.pitch);
      const tz = this.pos.z + Math.cos(this.pitch) * Math.cos(this.yaw);
      this.camera.lookAt(tx, ty, tz);
      if (this.groundGizmo) {
        this.groundGizmo.position.set(this.pos.x, this.pos.y - 1.8, this.pos.z);
      }
      return;
    }

    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.discTimer = Math.max(0, this.discTimer - dt);
    this.grenadeTimer = Math.max(0, this.grenadeTimer - dt);

    // Calculate movement input
    const fwd = this.getForwardXZ();
    const rgt = this.getRightXZ();

    let forward = 0, right = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    forward += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  forward -= 1;
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  right -= 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) right += 1;

    // Normalize input
    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    // Convert to world space for movement controller
    const mx = fwd.x * forward + rgt.x * right;
    const mz = fwd.y * forward + rgt.y * right;

    // Jump input (Shift key) - in autoHop mode, held = pressed
    const jumpHeld = this.jumpHeld;
    const jumpPressed = jumpHeld; // For autoHop, pressed is same as held

    // Ski input (Space key) - keydown/keyup is sufficient for hold-to-use
    const skiHeld = this.keys['Space'] || false;

    // Update movement controller with input and current yaw/pitch
    this.movement.setState({
      pos: this.pos,
      vel: this.vel,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    });
    this.movement.setInput({ forward, right, jumpPressed, jumpHeld, skiHeld });

    // Run physics
    this.movement.update(dt);

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward, right, jump: jumpPressed ? 1 : 0, ski: skiHeld ? 1 : 0 },
        { yaw: this.yaw, pitch: this.pitch }
      );
    }

    // Sync state from movement controller (local prediction)
    const moveState = this.movement.getState();
    this.pos.copy(moveState.pos);
    this.vel.copy(moveState.vel);
    this.onGround = moveState.onGround;

    // Jetpack (separate from movement controller, applied after physics sync)
    const isJetting = this.jetPending && this.energy > 0;
    if (isJetting) {
      this.vel.y += JET_FORCE_UP * dt;
      this.vel.x += mx * JET_FORCE_DIR * dt;
      this.vel.z += mz * JET_FORCE_DIR * dt;
      this.energy -= JET_DRAIN * dt;
      // Force off ground if jetting
      this.onGround = false;
    }

    // Energy recharge
    this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * dt);

    // ---- All visual/event spawns below use the final post-physics position ----

    // Update camera to final position
    this.camera.position.copy(this.pos);
    const tx = this.pos.x + Math.cos(this.pitch) * Math.sin(this.yaw);
    const ty = this.pos.y + Math.sin(this.pitch);
    const tz = this.pos.z + Math.cos(this.pitch) * Math.cos(this.yaw);
    this.camera.lookAt(tx, ty, tz);

    // Update ground check gizmo (at player feet = pos - PLAYER_HEIGHT)
    if (this.groundGizmo) {
      this.groundGizmo.position.set(this.pos.x, this.pos.y - 1.8, this.pos.z);
    }

    // Fire projectiles (from final position, matches camera)
    if ((this.firePending || this.mouseHeld) && this.fireTimer <= 0) {
      this.firePending = false;
      this.fireTimer = FIRE_RATE;
      if (this.onFire) {
        const dir = new THREE.Vector3(
          Math.cos(this.pitch) * Math.sin(this.yaw),
          Math.sin(this.pitch),
          Math.cos(this.pitch) * Math.cos(this.yaw)
        ).normalize();
        this.onFire({ origin: this.pos.clone(), dir, playerVel: this.vel.clone() });
      }
    }
    this.firePending = false;

    // Disc (C key) - hold to fire
    if (this.discHeld && this.discTimer <= 0) {
      this.discTimer = DISC_RATE;
      if (this.onDisc) {
        const dir = new THREE.Vector3(
          Math.cos(this.pitch) * Math.sin(this.yaw),
          Math.sin(this.pitch),
          Math.cos(this.pitch) * Math.cos(this.yaw)
        ).normalize();
        this.onDisc({ origin: this.pos.clone(), dir, playerVel: this.vel.clone() });
      }
    }

    // Grenade (F key) - hold to fire
    if (this.grenadeHeld && this.grenadeTimer <= 0) {
      this.grenadeTimer = GRENADE_RATE;
      if (this.onGrenade) {
        const dir = new THREE.Vector3(
          Math.cos(this.pitch) * Math.sin(this.yaw),
          Math.sin(this.pitch),
          Math.cos(this.pitch) * Math.cos(this.yaw)
        ).normalize();
        this.onGrenade({ origin: this.pos.clone(), dir, playerVel: this.vel.clone() });
      }
    }

    // Jetpack trail particles
    if (isJetting && this.onJetpack) {
      this.onJetpack(this.pos.clone());
      // Send jetpack event to network (throttled to ~20/s)
      const now = performance.now();
      if (this.onNetworkJetpack && now - this._lastJetpackSend > 50) {
        this._lastJetpackSend = now;
        this.onNetworkJetpack({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
    }

    // Ski dust particles (when space is held, on ground, and moving)
    if (skiHeld && this.onGround && this.vel.lengthSq() > 10) {
      if (this.onSki) this.onSki(this.pos.clone(), this.vel.clone());
    }

    // Trigger jump animation when leaving ground
    if (this.wasOnGround && !this.onGround) {
      this.jumpAnimTimer = 0.8; // Play jump animation for 0.8 seconds

      // Spawn jump dust particles if jump was pressed
      if (jumpHeld && this.onJump) {
        this.onJump(this.pos.clone());
      }

      // Send jump event to network
      if (this.onNetworkJump) {
        this.onNetworkJump({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
    }
    this.wasOnGround = this.onGround;

    // Update shadow blob position (follows player on ground)
    if (this.shadowBlob) {
      this.shadowBlob.position.x = this.pos.x;
      this.shadowBlob.position.z = this.pos.z;
      this.shadowBlob.position.y = this.terrain.getHeight(this.pos.x, this.pos.z) + 0.05; // Slightly above ground to prevent z-fighting
      // Fade shadow smoothly when in air
      const airHeight = this.pos.y - this.terrain.getHeight(this.pos.x, this.pos.z);
      const maxFadeHeight = 8.0;
      const fadeStart = 2.0;
      let opacity = 0.4;
      if (airHeight > fadeStart) {
        opacity = Math.max(0, 0.4 * (1 - (airHeight - fadeStart) / (maxFadeHeight - fadeStart)));
      }
      (this.shadowBlob.material as THREE.ShaderMaterial).uniforms.opacity.value = opacity;
    }

    // Update player model animation based on movement
    if (this.model) {
      // Handle jump animation timer
      if (this.jumpAnimTimer > 0) {
        this.jumpAnimTimer -= dt;
        if (this.jumpAnimTimer <= 0) {
          // Return to movement animation after jump
          this.jumpAnimTimer = 0;
        }
      }

      const speed = this.getSpeed();
      let animState: AnimationState = 'idle';
      
      // Jump animation takes priority
      if (this.jumpAnimTimer > 0) {
        animState = 'jump';
      } else {
        // Hysteresis to prevent flickering between animations
        // Use different thresholds for entering vs leaving states
        const currentAnim = this.model['currentState'] as AnimationState;
        
        if (currentAnim === 'run') {
          // Stay in run until speed drops below 6.0
          if (speed < 6.0) {
            animState = speed > 1.5 ? 'walk' : 'idle';
          } else {
            animState = 'run';
          }
        } else if (currentAnim === 'walk') {
          // Stay in walk until speed drops below 0.8 or exceeds 9.0
          if (speed < 0.8) {
            animState = 'idle';
          } else if (speed > 9.0) {
            animState = 'run';
          } else {
            animState = 'walk';
          }
        } else {
          // Idle: need higher threshold to start walking
          if (speed > 1.5) {
            animState = speed > 8.0 ? 'run' : 'walk';
          } else {
            animState = 'idle';
          }
        }
      }
      
      this.model.setAnimationState(animState);
      this.model.setPosition(this.pos.x, this.pos.y, this.pos.z);
      this.model.setRotation(this.yaw, this.pitch);
      this.model.update(dt);
    }
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    let dir = this.pos.clone().sub(from).normalize();
    this.vel.addScaledVector(dir, force);
    this.vel.y += force * 0.5;
    // Sync back to movement controller
    this.movement.setState({
      pos: this.pos,
      vel: this.vel,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    });
  }

  applyPull(to: THREE.Vector3, force: number): void {
    let dir = to.clone().sub(this.pos).normalize();
    this.vel.addScaledVector(dir, force);
    this.vel.y += force * 0.3;
    // Sync back to movement controller
    this.movement.setState({
      pos: this.pos,
      vel: this.vel,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    });
  }

  getSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  getCameraDir(): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw)
    ).normalize();
  }
}
