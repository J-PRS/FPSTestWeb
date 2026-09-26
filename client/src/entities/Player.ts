import * as THREE from 'three';

import { JET_FORCE_UP, JET_FORCE_DIR, MAX_ENERGY, JET_DRAIN, JET_CHARGE, FIRE_RATE, DISC_RATE, GRENADE_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE, PLASMA_RATE } from '../core/config.js';

import { Terrain } from '../world/terrain.js';

import { MovementController, MovementState } from './movement.js';
import { settings } from '../core/settings.js';
import { PlayerModel } from './PlayerModel.js';
import { PlayerVisuals } from './PlayerVisuals.js';

export interface FireEvent {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  playerVel: THREE.Vector3;
}

export type SkillId = 'bounce' | 'blink' | 'dash' | 'slam';
export const SKILL_ORDER: SkillId[] = ['bounce', 'blink', 'dash', 'slam'];

// Blink: freeze (momentum suspended), fast-lerp along the crosshair, then
// restore the pre-blink velocity exactly — Tracer-style repositioning
// that keeps your ski speed through the warp.
const BLINK_RANGE = 20;      // metres along the crosshair
const BLINK_TIME = 0.16;     // lerp duration — reads as a flash, not a slide
const BLINK_COOLDOWN = 1.2;  // s between blinks
// Dash: instant impulse along the crosshair — vel += dir * impulse, so it
// stacks with current momentum rather than redirecting it.
const DASH_IMPULSE = 25;     // m/s added along aim
const DASH_COOLDOWN = 0.9;   // s between dashes
// Slam: airborne-only — kills vertical velocity and spikes you straight
// down; the landing detonates an AOE (shared weapon table, type 8).
// Horizontal momentum is kept so you can slam-dive down a slope.
const SLAM_SPEED = 55;       // m/s straight down
const SLAM_COOLDOWN = 1.4;   // s

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0.0;
  pitch = 0.0;
  // Invert vertical mouse look ("flight sim" style). Persisted via settings.
  invertY = settings.get('fps-invert-y');
  sensitivity = settings.get('fps-sens');

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
    this.bounceHeld = false;
    this.bounceArmed = false;
    this.blinkActive = false; // abandon a blink mid-flight
  }

  setSkill(s: SkillId): void {
    this.skill = s;
    this.bounceHeld = this.bounceArmed = false;
    this.blinkActive = false;
    this.slamActive = false;
  }

  private tryBlink(): void {
    if (this.blinkActive || this.blinkCooldown > 0) return;

    const dir = this.getAimDir();
    // March the ray — truncate at the last point that stays clear of
    // terrain so you can't blink inside a hillside.
    let dist = 0;
    for (let d = 0.5; d <= BLINK_RANGE; d += 0.5) {
      const px = this.pos.x + dir.x * d;
      const py = this.pos.y + dir.y * d;
      const pz = this.pos.z + dir.z * d;
      if (py < this.terrain.getHeight(px, pz) + 0.5) break;
      dist = d;
    }
    if (dist < 2) return; // wall in the face — fizzle, no cooldown

    this.blinkFrom.copy(this.pos);
    this.blinkTo.copy(dir).multiplyScalar(dist).add(this.pos);
    this.blinkSavedVel.copy(this.vel);
    this.blinkT = 0;
    this.blinkActive = true;
    this.blinkCooldown = BLINK_COOLDOWN;
    this.vel.set(0, 0, 0);
    this.onBlink?.(this.blinkFrom, this.blinkTo);
  }

  private tryDash(): void {
    if (this.dashCooldown > 0) return;
    this.dashCooldown = DASH_COOLDOWN;
    const dir = this.getAimDir();
    this.vel.addScaledVector(dir, DASH_IMPULSE);
    this.syncMovement();
    this.onDash?.(this.pos.clone(), dir.clone());
  }

  private trySlam(): void {
    if (this.onGround || this.slamCooldown > 0) return; // airborne only
    this.slamActive = true;
    this.slamCooldown = SLAM_COOLDOWN;
    this.vel.y = -SLAM_SPEED; // keep horizontal momentum — spike the vertical
    this.syncMovement();
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
  private visuals: PlayerVisuals; // camera/shadow/gizmo/observer — see PlayerVisuals.ts

  // Input state
  private keys: Record<string, boolean> = {};
  private mouseHeld = false;
  private firePending = false;
  private jetPending = false;
  private jumpHeld = false;
  private discHeld = false;
  private grenadeHeld = false;
  // Bounce skill (hold Q): arms while airborne — on the first terrain
  // touch after arming, velocity is redirected along the crosshair with
  // its magnitude preserved exactly (like an enraged ball's lunge, but
  // aimed by you). Consumed on trigger; re-arms on the next airborne
  // period so holding Q across a landing only fires once.
  private bounceHeld = false;
  private bounceArmed = false;
  // Skills live on Q — the loadout picks which one is equipped.
  skill: SkillId = 'bounce';
  // Blink state: while active, physics is suspended and pos lerps
  // blinkFrom→blinkTo; blinkSavedVel restores momentum on completion.
  private blinkActive = false;
  private blinkT = 0;
  private blinkCooldown = 0;
  private blinkFrom = new THREE.Vector3();
  private blinkTo = new THREE.Vector3();
  private blinkSavedVel = new THREE.Vector3();
  private dashCooldown = 0;
  private slamActive = false;  // falling at slam speed — detonates on landing
  private slamCooldown = 0;
  // Weapon slots: 0 = rocket (LMB), 1 = disc launcher, 2 = chaingun,
  // 3 = mortar, 4 = grenade launcher
  weaponIndex = 0;
  private wheelAcc = 0; // accumulates deltaY for smooth-scroll mice
  private static readonly WEAPON_RATES = [FIRE_RATE, DISC_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE, PLASMA_RATE];
  private _lastJetpackSend = 0;

  // Events
  onFire: ((e: FireEvent) => void) | null = null;
  onJump: ((pos: THREE.Vector3) => void) | null = null;
  onJetpack: ((pos: THREE.Vector3) => void) | null = null;
  onSki: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;
  onBounce: ((pos: THREE.Vector3, dir: THREE.Vector3) => void) | null = null; // skill FX hook
  onBlink: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;  // fires at blink start
  onDash: ((pos: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;   // fires on dash impulse
  onSlam: ((pos: THREE.Vector3) => void) | null = null;                        // fires on slam impact
  onDisc: ((e: FireEvent) => void) | null = null;
  onGrenade: ((e: FireEvent) => void) | null = null;
  onDiscLauncher: ((e: FireEvent) => void) | null = null;
  onChaingun: ((e: FireEvent) => void) | null = null;
  onMortar: ((e: FireEvent) => void) | null = null;
  onGrenadeLauncher: ((e: FireEvent) => void) | null = null;
  onFlak: ((e: FireEvent) => void) | null = null;
  onPlasma: ((e: FireEvent) => void) | null = null;
  onWeaponSwitch: ((index: number) => void) | null = null;
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
    this.visuals = new PlayerVisuals(scene);

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
      if (e.code === 'KeyQ') {
        if (this.skill === 'blink') this.tryBlink();
        else if (this.skill === 'dash') this.tryDash();
        else if (this.skill === 'slam') this.trySlam();
        else this.bounceHeld = true;
      }
      if (e.code.startsWith('Digit')) {
        const idx = Number(e.code[5]) - 1;
        if (idx >= 0 && idx < Player.WEAPON_RATES.length && idx !== this.weaponIndex) {
          this.weaponIndex = idx;
          if (this.onWeaponSwitch) this.onWeaponSwitch(idx);
        }
      }
    });
    // Mouse wheel cycles weapons (down = next, up = previous). Accumulate
    // deltaY so smooth-scroll/trackpads switch once per gesture, not per tick.
    document.addEventListener('wheel', (e) => {
      if (this.inputFrozen) return;
      if (!document.pointerLockElement) return;
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) < 40) return;
      const step = this.wheelAcc > 0 ? 1 : -1;
      this.wheelAcc = 0;
      const n = Player.WEAPON_RATES.length;
      const idx = (this.weaponIndex + step + n) % n;
      if (idx !== this.weaponIndex) {
        this.weaponIndex = idx;
        if (this.onWeaponSwitch) this.onWeaponSwitch(idx);
      }
    }, { passive: true });
    document.addEventListener('keyup', (e) => {
      if (this.inputFrozen) return;
      this.keys[e.code] = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.jumpHeld = false;
      }
      if (e.code === 'KeyC') {
        this.discHeld = false;
      }
      if (e.code === 'KeyQ') {
        this.bounceHeld = false;
        this.bounceArmed = false;
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
        this.yaw   -= e.movementX * 0.002 * this.sensitivity;
        this.pitch += e.movementY * 0.002 * this.sensitivity * (this.invertY ? 1 : -1);
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
      }
    });

    // Wire the ESC-menu toggle for inverted vertical mouse look
    const invertYBtn = document.getElementById('invert-y-toggle') as HTMLButtonElement | null;
    if (invertYBtn) {
      invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      invertYBtn.addEventListener('click', () => {
        this.invertY = !this.invertY;
        settings.set('fps-invert-y', this.invertY);
        invertYBtn.textContent = this.invertY ? 'INVERT Y: ON' : 'INVERT Y: OFF';
      });
    }

    // Wire the ESC-menu sensitivity field (plain decimal input, no steppers).
    // Display scale is ×10 the internal multiplier so default shows "10" and
    // whole numbers give coarse-but-usable steps.
    const sensInput = document.getElementById('sens-input') as HTMLInputElement | null;
    if (sensInput) {
      sensInput.value = (this.sensitivity * 10).toString();
      // Click/focus selects the whole value so typing replaces it outright
      sensInput.addEventListener('focus', () => sensInput.select());
      sensInput.addEventListener('input', () => {
        const v = parseFloat(sensInput.value);
        if (!isFinite(v)) return;
        this.sensitivity = Math.max(0.5, Math.min(100, v)) / 10;
        settings.set('fps-sens', this.sensitivity);
      });
      // Don't let WASD-type keys inside the field reach game input
      sensInput.addEventListener('keydown', (e) => e.stopPropagation());
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
    if (this.isDead) {
      const obInput = this.readMoveInput();
      // T1/T2 observer mode: free-look + fly till respawn
      this.visuals.updateObserverCam(dt, this.camera, this.terrain, this.pos, this.vel, this.yaw, this.pitch, {
        forward: obInput.forward, right: obInput.right, jumpHeld: obInput.jumpHeld,
        shiftDown: !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']),
      });
      return;
    }
    if (this.inputFrozen) {
      // still update camera for demo playback
      this.visuals.updateFrozenCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
      return;
    }

    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.discTimer = Math.max(0, this.discTimer - dt);
    this.grenadeTimer = Math.max(0, this.grenadeTimer - dt);
    this.blinkCooldown = Math.max(0, this.blinkCooldown - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.slamCooldown = Math.max(0, this.slamCooldown - dt);

    // Blink: physics suspended, position lerps along the stored path,
    // velocity held at zero until the restore on completion.
    if (this.blinkActive) {
      this.blinkT += dt / BLINK_TIME;
      const t = Math.min(this.blinkT, 1);
      const ease = t * t * (3 - 2 * t); // smoothstep — snap in, settle out
      this.pos.lerpVectors(this.blinkFrom, this.blinkTo, ease);
      if (t >= 1) {
        this.blinkActive = false;
        this.vel.copy(this.blinkSavedVel);
      }
      this.movement.setState({ pos: this.pos, vel: this.vel, yaw: this.yaw, pitch: this.pitch, onGround: false });
      this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
      this.visuals.updateShadowBlob(this.terrain, this.pos);
      return;
    }

    const input = this.readMoveInput();

    // Update movement controller with input and current yaw/pitch
    this.movement.setState({
      pos: this.pos,
      vel: this.vel,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    });
    this.movement.setInput({
      forward: input.forward, right: input.right,
      jumpPressed: input.jumpHeld, jumpHeld: input.jumpHeld, // autoHop: pressed = held
      skiHeld: input.skiHeld,
    });

    // Run physics
    this.movement.update(dt);

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward: input.forward, right: input.right, jump: input.jumpHeld ? 1 : 0, ski: input.skiHeld ? 1 : 0 },
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
      this.vel.x += input.moveX * JET_FORCE_DIR * dt;
      this.vel.z += input.moveZ * JET_FORCE_DIR * dt;
      this.energy -= JET_DRAIN * dt;
      this.onGround = false; // Force off ground if jetting
    }

    // Energy recharge — paused while jetting (Tribes-style: drain 12/s
    // while burning, recharge 8/s only when off the jet)
    if (!isJetting) {
      this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * dt);
    }

    // ---- All visual/event spawns below use the final post-physics position ----

    this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
    this.visuals.updateFeetMarker(this.terrain, this.pos);
    this.fireWeapons();
    this.emitMoveEvents(isJetting, input.skiHeld, input.jumpHeld);
    this.visuals.updateShadowBlob(this.terrain, this.pos);
    this.jumpAnimTimer = this.visuals.updateModelAnim(this.model, this.pos, this.yaw, this.pitch, this.jumpAnimTimer, this.getSpeed(), dt);
  }

  private readMoveInput(): { forward: number; right: number; jumpHeld: boolean; skiHeld: boolean; moveX: number; moveZ: number } {
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

    return {
      forward, right,
      jumpHeld: this.jumpHeld, // autoHop: held = pressed
      skiHeld: this.keys['Space'] || false,
      // World-space move dir for jetpack thrust
      moveX: fwd.x * forward + rgt.x * right,
      moveZ: fwd.y * forward + rgt.y * right,
    };
  }

  private getAimDir(): THREE.Vector3 {
    return new THREE.Vector3(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw)
    ).normalize();
  }

  // Weapon triggers: selected weapon (LMB) plus C/F belt throws.
  private fireWeapons(): void {
    // Chaingun auto-fires while held; rocket/disc launcher are per-click.
    const wantFire = this.weaponIndex === 2 ? this.mouseHeld : (this.firePending || this.mouseHeld);
    if (wantFire && this.fireTimer <= 0) {
      this.fireTimer = Player.WEAPON_RATES[this.weaponIndex];
      const fireCallback = this.weaponIndex === 1 ? this.onDiscLauncher
        : this.weaponIndex === 2 ? this.onChaingun
        : this.weaponIndex === 3 ? this.onMortar
        : this.weaponIndex === 4 ? this.onGrenadeLauncher
        : this.weaponIndex === 5 ? this.onFlak
        : this.weaponIndex === 6 ? this.onPlasma
        : this.onFire;
      fireCallback?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }
    this.firePending = false;

    // Disc (C key) - belt throw, hold to fire
    if (this.discHeld && this.discTimer <= 0) {
      this.discTimer = DISC_RATE;
      this.onDisc?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }

    // Grenade (F key) - belt throw, hold to fire
    if (this.grenadeHeld && this.grenadeTimer <= 0) {
      this.grenadeTimer = GRENADE_RATE;
      this.onGrenade?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }
  }

  // Movement-event FX: jetpack trail, ski dust, jump event + anim trigger
  private emitMoveEvents(isJetting: boolean, skiHeld: boolean, jumpHeld: boolean): void {
    // Jetpack trail particles
    if (isJetting && this.onJetpack) {
      this.onJetpack(this.pos); // read-only use — no clone, runs every frame
      // Send jetpack event to network (throttled to ~20/s)
      const now = performance.now();
      if (this.onNetworkJetpack && now - this._lastJetpackSend > 50) {
        this._lastJetpackSend = now;
        this.onNetworkJetpack({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
    }

    // Ski dust particles (when space is held, on ground, and moving)
    if (skiHeld && this.onGround && this.vel.lengthSq() > 10 && this.onSki) {
      this.onSki(this.pos, this.vel); // read-only use — no clones, runs every frame
    }

    // Bounce skill: arm while airborne, fire on the landing transition —
    // redirect full speed along the crosshair. Pure redirect: magnitude
    // preserved, nothing added or taken away.
    if (this.bounceHeld && !this.onGround) this.bounceArmed = true;
    if (this.bounceArmed && !this.wasOnGround && this.onGround) {
      const speed = this.vel.length();
      if (speed > 0.01) {
        const dir = this.getAimDir();
        this.vel.copy(dir).multiplyScalar(speed);
        this.syncMovement();
        this.onBounce?.(this.pos.clone(), dir.clone());
      }
      this.bounceArmed = false;
    }

    // Slam detonation — the landing IS the trigger (mutually exclusive
    // with Bounce since they're one skill slot, so no ordering conflict)
    if (this.slamActive && !this.wasOnGround && this.onGround) {
      this.slamActive = false;
      this.onSlam?.(this.pos.clone());
    }

    // Trigger jump animation when leaving ground
    if (this.wasOnGround && !this.onGround) {
      this.jumpAnimTimer = 0.8;
      if (jumpHeld && this.onJump) {
        this.onJump(this.pos.clone());
      }
      this.onNetworkJump?.({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
    }
    this.wasOnGround = this.onGround;
  }

  // Every impulse path must push pos/vel back into the controller —
  // it owns integration and its snapshot would overwrite our values
  // next update otherwise.
  syncMovement(): void {
    this.movement.setState({ pos: this.pos, vel: this.vel, yaw: this.yaw, pitch: this.pitch, onGround: this.onGround });
  }

  applyKnockback(from: THREE.Vector3, force: number): void {
    const dir = this.pos.clone().sub(from).normalize();
    this.vel.addScaledVector(dir, force);
    this.vel.y += force * 0.5;
    // Explosion impulse ungrounds — otherwise ground friction eats the
    // horizontal component while still within the near-ground band.
    this.onGround = false;
    this.syncMovement();
  }

  applyPull(to: THREE.Vector3, force: number): void {
    const dir = to.clone().sub(this.pos).normalize();
    this.vel.addScaledVector(dir, force);
    this.vel.y += force * 0.3;
    this.onGround = false;
    this.syncMovement();
  }

  getSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  getCameraDir(): THREE.Vector3 {
    return this.getAimDir();
  }
}
