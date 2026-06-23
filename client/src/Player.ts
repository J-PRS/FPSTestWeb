import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { GRAVITY, JET_FORCE_UP, JET_FORCE_DIR, MAX_ENERGY, JET_DRAIN, JET_CHARGE, FIRE_RATE, DISC_RATE } from './config.js';
import { MovementController, MovementState, MovementInput, MOVEMENT_CONFIG } from './movement.js';
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

  onGround = false;
  energy = MAX_ENERGY;
  fireTimer = 0.0;
  discTimer = 0.0;
  health = 100;
  kills = 0;
  isDead = false;

  private terrain: Terrain;
  private camera: THREE.PerspectiveCamera;
  public movement: MovementController; // Public for client-side prediction reconciliation
  private model: PlayerModel | null = null;
  private jumpAnimTimer = 0.0;
  private wasOnGround = false;

  // Input state
  private keys: Record<string, boolean> = {};
  private mouseHeld = false;
  private firePending = false;
  private jetPending = false;
  private jumpHeld = false;
  private discHeld = false;

  // Events
  onFire: ((e: FireEvent) => void) | null = null;
  onJump: ((pos: THREE.Vector3) => void) | null = null;
  onJetpack: ((pos: THREE.Vector3) => void) | null = null;
  onSki: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;
  onDisc: ((e: FireEvent) => void) | null = null;
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
      this.keys[e.code] = true;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.jumpHeld = true;
      }
      if (e.code === 'KeyC') {
        this.discHeld = true;
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.jumpHeld = false;
      }
      if (e.code === 'KeyC') {
        this.discHeld = false;
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.firePending = true; this.mouseHeld = true; }
      if (e.button === 2) { this.jetPending = true; }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseHeld = false;
      if (e.button === 2) { this.jetPending = false; }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        this.yaw   -= e.movementX * 0.002;
        this.pitch += e.movementY * 0.002;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
      }
    });
  }

  private getForwardXZ(): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
  }
  private getRightXZ(): THREE.Vector2 {
    return new THREE.Vector2(-Math.cos(this.yaw), Math.sin(this.yaw));
  }

  update(dt: number): void {
    if (this.isDead) return;

    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.discTimer = Math.max(0, this.discTimer - dt);

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
    this.movement.update(dt);

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward, right, jump: jumpPressed ? 1 : 0, ski: skiHeld ? 1 : 0 },
        { yaw: this.yaw, pitch: this.pitch }
      );
    }

    // INSTANT MOVEMENT: Client-side prediction updates position immediately
    // Sync state from movement controller (local prediction)
    const moveState = this.movement.getState();
    this.pos.copy(moveState.pos);
    this.vel.copy(moveState.vel);
    this.onGround = moveState.onGround;

    // Ski dust particles (when space is held, on ground, and moving)
    if (skiHeld && this.onGround && this.vel.lengthSq() > 10) {
      if (this.onSki) this.onSki(this.pos.clone(), this.vel.clone());
    }

    // Trigger jump animation when leaving ground
    if (this.wasOnGround && !this.onGround) {
      this.jumpAnimTimer = 0.8; // Play jump animation for 0.8 seconds
      // Send jump event to network
      if (this.onNetworkJump) {
        this.onNetworkJump({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
    }
    this.wasOnGround = this.onGround;

    // Jetpack (separate from movement controller)
    // Allow jetting even if just jumped (don't require !onGround)
    const isJetting = this.jetPending && this.energy > 0;
    if (isJetting) {
      this.vel.y += JET_FORCE_UP * dt;
      this.vel.x += mx * JET_FORCE_DIR * dt;
      this.vel.z += mz * JET_FORCE_DIR * dt;
      this.energy -= JET_DRAIN * dt;
      if (this.onJetpack) this.onJetpack(this.pos.clone());
      // Send jetpack event to network
      if (this.onNetworkJetpack) {
        this.onNetworkJetpack({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
      // Force off ground if jetting
      this.onGround = false;
    }

    // Energy recharge
    this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * dt);

    // Fire
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

    // Update camera
    this.camera.position.copy(this.pos);
    const tx = this.pos.x + Math.cos(this.pitch) * Math.sin(this.yaw);
    const ty = this.pos.y + Math.sin(this.pitch);
    const tz = this.pos.z + Math.cos(this.pitch) * Math.cos(this.yaw);
    this.camera.lookAt(tx, ty, tz);

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
