import * as THREE from 'three';

import { JET_FORCE_UP, JET_FORCE_DIR, MAX_ENERGY, MAX_HEALTH, JET_DRAIN, JET_CHARGE, FIRE_RATE, DISC_RATE, GRENADE_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE, PLASMA_RATE, RAILGUN_RATE, LG_RATE, SHOTGUN_RATE, CANNON_RATE, RKT_RATE, MELEE_COOLDOWN, MELEE_LUNGE } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { PlayerSkills } from './player/skills.js';

import { MovementController, MovementState } from './movement.js';
import { WeaponType } from '../../../shared/weapons.js';
import { settings } from '../core/settings.js';
import { matchCode, isDown, type BindAction } from '../core/keybinds.js';
import { audio } from '../core/audio.js';
import { PlayerModel } from './PlayerModel.js';
import { PlayerVisuals } from './PlayerVisuals.js';
import { THROW_TOTAL } from './ViewModel.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('Player');

export interface FireEvent {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  playerVel: THREE.Vector3;
}

export type SkillId = 'bounce' | 'blink' | 'dash' | 'slam' | 'warp';
export const SKILL_ORDER: SkillId[] = ['bounce', 'blink', 'dash', 'slam', 'warp'];

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
  /** Nugget pickup: free jetting for a few seconds (refresh, not stack). */
  jetBoostTimer = 0;
  fireTimer = 0.0;
  discTimer = 0.0;
  grenadeTimer = 0.0;
  // Primary fire is locked while the belt-throw anim plays — the weapon is
  // physically lowered, shooting mid-throw would fire through the hip.
  throwLockT = 0;
  health = 100;
  kills = 0;
  isDead = false;
  /** Verb phrase for the death message ("devoured by a crawler") — set by
   *  every environment-damage path so the kill feed names the real killer. */
  lastDamageSource = '';
  inputFrozen = false; // when true, keyboard/mouse input is ignored (demo playback)

  // Spectator fly: the death-observer free-flight cam without dying — no
  // desaturation, no respawn timer, body follows the ghost (pos IS the
  // camera rig). Toggled by the 'spectate' bind (V).
  private spectating = false;
  get isSpectating(): boolean { return this.spectating; }
  toggleSpectator(): void {
    if (this.isDead) return; // dead already gives you this cam
    this.spectating = !this.spectating;
    // Land mid-toggle-off in the air and the body floats — drop the ghost's
    // drift so gravity owns the fall again. Also drop any fire/jet clicks
    // queued while ghosted so they don't discharge on the way out.
    if (!this.spectating) {
      this.vel.set(0, 0, 0);
      this.firePending = false;
      this.jetPending = false;
    }
    this.model?.setVisible(!this.spectating && this.thirdPerson && !this.isDead);
  }

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
    this.skills.reset(); // abandon blink mid-flight, kill the beacon
  }

  setSkill(s: SkillId): void {
    this.skill = s;
    this.skills.reset();
    settings.set('fps-skill', s);
  }

  // Power punch (E): CoD-style lunge toward the crosshair, hit itself is
  // resolved in combat.melee() as a cone + small AOE claim.
  private meleeCooldown = 0.0;
  private tryMelee(): void {
    if (this.meleeCooldown > 0) return;
    this.meleeCooldown = MELEE_COOLDOWN;
    const dir = this.getAimDir();
    this.vel.addScaledVector(dir, MELEE_LUNGE);
    this.syncMovement();
    this.onMelee?.({ origin: this.pos.clone(), dir, playerVel: this.vel.clone() });
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
  // Railgun kill-refund zeroes the cooldown — but the shot is still held,
  // so without this the same click re-fires the gun on kill. Require a
  // mouse release before the next shot.
  private needsRelease = false;
  private jetPending = false;
  private jumpHeld = false;
  private discHeld = false;
  private grenadeHeld = false;
  // Skills live on Q — the loadout picks which one is equipped.
  skill: SkillId = (SKILL_ORDER as string[]).includes(settings.get('fps-skill'))
    ? settings.get('fps-skill') as SkillId : 'bounce';
  private skills!: PlayerSkills;
  // Declared discontinuity: next position report goes out as a 'teleport'
  // message so the server reseats its plausibility anchor instead of
  // rejecting the jump as a speedhack (the >50m rubber-band loop).
  pendingTeleport = false;
  markTeleport(): void { this.pendingTeleport = true; }

  private scene: THREE.Scene;
  private prevVelY = 0;        // vel.y entering this frame — impact speed at grounding (post-update vel.y is already zeroed)
  // Weapon slots: 0 = rocket (LMB), 1 = disc launcher, 2 = chaingun,
  // 3 = mortar, 4 = grenade launcher
  weaponIndex = 0;
  // 4-slot loadout: weaponIndex is the SLOT (0-3); loadout[slot] is the
  // weapon id (index into WEAPON_RATES / viewmodel order). ESC menu assigns.
  loadout: number[] = Player.parseLoadout(settings.get('fps-loadout'));
  static readonly LOADOUT_SLOTS = 4;
  // Belt: one throwable equipped, F throws it. ESC menu picks.
  beltItem: 'disc' | 'grenade' = settings.get('fps-belt') === 'grenade' ? 'grenade' : 'disc';

  private static parseLoadout(raw: string): number[] {
    const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < Player.WEAPON_RATES.length);
    return ids.length === Player.LOADOUT_SLOTS ? ids : [0, 2, 6, 7];
  }

  get currentWeapon(): number { return this.loadout[this.weaponIndex]; }

  /** Kill-refund (railgun): ready instantly, but requires a fresh click —
   *  without needsRelease the still-held trigger would re-fire same-frame. */
  refundWeaponCooldown(): void {
    this.fireTimer = 0;
    this.needsRelease = true;
  }

  setLoadoutSlot(slot: number, weaponId: number): void {
    // Picking a weapon that's already equipped elsewhere swaps the slots
    // instead of duplicating it — standard loadout-menu behavior.
    const other = this.loadout.indexOf(weaponId);
    if (other >= 0 && other !== slot) this.loadout[other] = this.loadout[slot];
    this.loadout[slot] = weaponId;
    settings.set('fps-loadout', this.loadout.join(','));
    if (this.weaponIndex === slot || this.weaponIndex === other) {
      this.onWeaponSwitch?.(this.loadout[this.weaponIndex]);
    }
  }

  setBeltItem(item: 'disc' | 'grenade'): void {
    this.beltItem = item;
    settings.set('fps-belt', item);
  }
  private wheelAcc = 0; // accumulates deltaY for smooth-scroll mice
  private static readonly WEAPON_RATES = [FIRE_RATE, DISC_RATE, CHAINGUN_RATE, MORTAR_RATE, GL_RATE, FLAK_RATE, PLASMA_RATE, RAILGUN_RATE, LG_RATE, SHOTGUN_RATE, CANNON_RATE, RKT_RATE];
  // wid (loadout/WEAPON_RATES index) → WeaponType wire id. The enum has
  // Grenade=2/Slam=8/Railgun=9/Melee=10 gaps, so positional ids diverge
  // from wid 2 onward — viewmodel/HUD consumers need this mapping.
  static widToWeaponType(wid: number): WeaponType {
    return ([0, 1, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15] as const)[wid] ?? WeaponType.Rocket;
  }
  private _lastJetpackSend = 0;

  // Events
  onFire: ((e: FireEvent) => void) | null = null;
  onJump: ((pos: THREE.Vector3) => void) | null = null;
  onLand: ((impactSpeed: number) => void) | null = null;
  /** Exposed for the audio engine: continuous loops follow these flags. */
  jetting = false;
  skiing = false;
  /** Z toggles Tribes Ascend-style chase cam — centered, under the crosshair. */
  thirdPerson = false;
  onJetpack: ((pos: THREE.Vector3) => void) | null = null;
  onSki: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;
  onFootDust: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null;
  onBounce: ((pos: THREE.Vector3, dir: THREE.Vector3) => void) | null = null; // skill FX hook
  onBlink: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;  // fires at blink start
  onDash: ((pos: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;   // fires on dash impulse
  onWarpThrow: ((pos: THREE.Vector3, vel: THREE.Vector3) => void) | null = null; // beacon launch
  onWarpTick: ((pos: THREE.Vector3) => void) | null = null; // trail emitter while beacon flies
  onWarp: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null; // the warp itself
  onSlam: ((pos: THREE.Vector3, impactSpeed: number) => void) | null = null;  // fires on slam impact — speed scales the blast
  onDisc: ((e: FireEvent) => void) | null = null;
  onGrenade: ((e: FireEvent) => void) | null = null;
  onDiscLauncher: ((e: FireEvent) => void) | null = null;
  onChaingun: ((e: FireEvent) => void) | null = null;
  onMortar: ((e: FireEvent) => void) | null = null;
  onGrenadeLauncher: ((e: FireEvent) => void) | null = null;
  onFlak: ((e: FireEvent) => void) | null = null;
  onPlasma: ((e: FireEvent) => void) | null = null;
  onRailgun: ((e: FireEvent) => void) | null = null;
  onLightning: ((e: FireEvent) => void) | null = null;
  onShotgun: ((e: FireEvent) => void) | null = null;
  onCannon: ((e: FireEvent) => void) | null = null;
  onRocketLauncher: ((e: FireEvent) => void) | null = null;
  onMelee: ((e: FireEvent) => void) | null = null;
  onWeaponSwitch: ((index: number) => void) | null = null;
  onNetworkJump: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkJetpack: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkInput: ((input: { forward: number; right: number; jump: number; ski: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;

  constructor(terrain: Terrain, camera: THREE.PerspectiveCamera, scene: THREE.Scene) {
    this.terrain = terrain;
    this.camera = camera;
    this.scene = scene;

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

    // Q-slot skills — reads pos/vel by ref and reaches the assignable on*
    // hooks through emit closures (they're wired after construction).
    this.skills = new PlayerSkills({
      pos: this.pos,
      vel: this.vel,
      scene,
      terrain,
      isOnGround: () => this.onGround,
      aimDir: () => this.getAimDir(),
      syncMovement: () => this.syncMovement(),
      markTeleport: () => this.markTeleport(),
      blinkFrame: () => {
        this.movement.setState({ pos: this.pos, vel: this.vel, yaw: this.yaw, pitch: this.pitch, onGround: false });
        this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
        this.visuals.updateShadowBlob(this.terrain, this.pos);
      },
      emitBlink: (a, b) => this.onBlink?.(a, b),
      emitDash: (a, b) => this.onDash?.(a, b),
      emitWarpThrow: (a, b) => this.onWarpThrow?.(a, b),
      emitWarpTick: (a) => this.onWarpTick?.(a),
      emitWarp: (a, b) => this.onWarp?.(a, b),
      emitSlam: (a, b) => this.onSlam?.(a, b),
      emitBounce: (a, b) => this.onBounce?.(a, b),
    });

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
      if (matchCode('spectate', e.code) && !e.repeat) this.toggleSpectator();
      // Spectating: only the spectate toggle and raw movement keys (tracked
      // above for the fly cam) respond — no weapons, skills, camera flips
      if (this.spectating) return;
      if (matchCode('jump', e.code)) {
        this.jumpHeld = true;
      }
      if (matchCode('belt', e.code)) {
        if (this.beltItem === 'disc') this.discHeld = true;
        else this.grenadeHeld = true;
      }
      if (matchCode('melee', e.code)) {
        this.tryMelee();
      }
      if (matchCode('camera', e.code)) {
        this.thirdPerson = !this.thirdPerson;
        this.model?.setVisible(this.thirdPerson && !this.isDead);
      }
      if (matchCode('skill', e.code) && !e.repeat) this.skills.press(this.skill);
      for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
        if (matchCode(`slot${i}` as BindAction, e.code) && i !== this.weaponIndex) {
          this.weaponIndex = i;
          if (this.onWeaponSwitch) this.onWeaponSwitch(this.loadout[i]);
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
      const n = this.loadout.length;
      const idx = (this.weaponIndex + step + n) % n;
      if (idx !== this.weaponIndex) {
        this.weaponIndex = idx;
        if (this.onWeaponSwitch) this.onWeaponSwitch(this.loadout[idx]);
      }
    }, { passive: true });
    document.addEventListener('keyup', (e) => {
      if (this.inputFrozen) return;
      this.keys[e.code] = false;
      if (matchCode('jump', e.code)) {
        this.jumpHeld = false;
      }
      if (matchCode('skill', e.code)) this.skills.release(this.skill);
      if (matchCode('belt', e.code)) {
        this.discHeld = false;
        this.grenadeHeld = false;
      }
    });
    document.addEventListener('mousedown', (e) => {
      if (this.inputFrozen) return;
      if (!document.pointerLockElement) return; // ignore clicks that lock the cursor
      this.keys[`Mouse${e.button}`] = true;
      if (e.button === 0) { this.firePending = true; this.mouseHeld = true; this.needsRelease = false; }
      if (e.button === 2) { this.jetPending = true; }
      // Buttons bound to key actions (keybinds allow Mouse0-4) need the
      // same press/release semantics as keyboard codes
      if (matchCode('jump', `Mouse${e.button}`)) this.jumpHeld = true;
      if (matchCode('skill', `Mouse${e.button}`)) this.skills.press(this.skill);
      if (matchCode('belt', `Mouse${e.button}`)) {
        if (this.beltItem === 'disc') this.discHeld = true; else this.grenadeHeld = true;
      }
      if (matchCode('melee', `Mouse${e.button}`)) this.tryMelee();
      if (matchCode('camera', `Mouse${e.button}`)) {
        this.thirdPerson = !this.thirdPerson;
        this.model?.setVisible(this.thirdPerson && !this.isDead);
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (this.inputFrozen) return;
      this.keys[`Mouse${e.button}`] = false;
      if (e.button === 0) this.mouseHeld = false;
      if (e.button === 2) { this.jetPending = false; }
      if (matchCode('jump', `Mouse${e.button}`)) this.jumpHeld = false;
      if (matchCode('skill', `Mouse${e.button}`)) this.skills.release(this.skill);
      if (matchCode('belt', `Mouse${e.button}`)) { this.discHeld = false; this.grenadeHeld = false; }
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

    const volInput = document.getElementById('vol-input') as HTMLInputElement | null;
    if (volInput) {
      volInput.value = audio.getVolume().toString();
      volInput.addEventListener('input', () => {
        const v = parseFloat(volInput.value);
        if (isFinite(v)) audio.setVolume(Math.max(0, Math.min(1, v)));
      });
      volInput.addEventListener('keydown', (e) => e.stopPropagation());
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
    if (isDown(this.keys, 'forward') || this.keys['ArrowUp'])    forward += 1;
    if (isDown(this.keys, 'back') || this.keys['ArrowDown'])     forward -= 1;
    if (isDown(this.keys, 'left') || this.keys['ArrowLeft'])     right -= 1;
    if (isDown(this.keys, 'right') || this.keys['ArrowRight'])   right += 1;

    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward,
      right,
      jumpPressed: this.jumpHeld,
      jumpHeld: this.jumpHeld,
      skiHeld: isDown(this.keys, 'ski'),
      firePressed: this.firePending,
      jetHeld: this.jetPending,
      discHeld: this.discHeld,
      grenadeHeld: this.grenadeHeld
    };
  }

  update(dt: number): void {
    if (this.isDead || this.spectating) {
      const obInput = this.readMoveInput();
      // T1/T2 observer mode: free-look + fly till respawn
      this.visuals.updateObserverCam(dt, this.camera, this.terrain, this.pos, this.vel, this.yaw, this.pitch, {
        forward: obInput.forward, right: obInput.right, jumpHeld: obInput.skiHeld,
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
    this.throwLockT = Math.max(0, this.throwLockT - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.skills.tickCooldowns(dt);
    this.skills.updateBeacon(dt);

    if (this.skills.updateBlink(dt)) return;

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

    // Fall speed entering this frame — grounding inside movement.update
    // zeroes vel.y, so the slam impact reads the pre-integration value
    this.prevVelY = this.vel.y;

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
    if (this.jetBoostTimer > 0) this.jetBoostTimer -= dt;
    const isJetting = this.jetPending && (this.energy > 0 || this.jetBoostTimer > 0);
    this.jetting = isJetting;
    if (isJetting) {
      this.vel.y += JET_FORCE_UP * dt;
      this.vel.x += input.moveX * JET_FORCE_DIR * dt;
      this.vel.z += input.moveZ * JET_FORCE_DIR * dt;
      if (this.jetBoostTimer <= 0) this.energy -= JET_DRAIN * dt;
      this.onGround = false; // Force off ground if jetting
    }

    // Energy recharge — paused while jetting (Tribes-style: drain 12/s
    // while burning, recharge 8/s only when off the jet)
    if (!isJetting) {
      this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * dt);
    }

    // ---- All visual/event spawns below use the final post-physics position ----

    this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch, this.thirdPerson);
    this.checkCameraSpinout(dt);
    // Model visibility follows the toggle AND death (observer cam is ghost
    // flight — your corpse shouldn't fly with you)
    this.model?.setVisible(this.thirdPerson && !this.isDead);
    this.visuals.updateFeetMarker(this.terrain, this.pos);
    this.fireWeapons();
    this.emitMoveEvents(isJetting, input.skiHeld, input.jumpHeld, dt);
    this.visuals.updateShadowBlob(this.terrain, this.pos);
    this.jumpAnimTimer = this.visuals.updateModelAnim(this.model, this.pos, this.yaw, this.pitch, this.jumpAnimTimer, this.getSpeed(), dt, this.onGround);
  }

  // Spinout detector: a camera rotation jump >35° in a single frame is a
  // discontinuity (snap/teleport/NaN), not human input — even a violent
  // flick is <2°/frame at 60fps. Warn logs carry pose so we can repro.
  private _prevCamQuat = new THREE.Quaternion();
  private _camQuatValid = false;
  private _spinoutCd = 0;

  private checkCameraSpinout(dt: number): void {
    const q = this.camera.quaternion;
    if (this._camQuatValid && this._spinoutCd <= 0) {
      const deg = q.angleTo(this._prevCamQuat) * 180 / Math.PI;
      if (deg > 35) {
        this._spinoutCd = 0.5; // throttle — a stuck spinout spams otherwise
        logger.warn(`Camera spinout ${deg.toFixed(1)}deg/frame`, {
          pos: `(${this.pos.x.toFixed(1)},${this.pos.y.toFixed(1)},${this.pos.z.toFixed(1)})`,
          yaw: this.yaw.toFixed(3), pitch: this.pitch.toFixed(3),
          dt: dt.toFixed(4), thirdPerson: this.thirdPerson, dead: this.isDead,
        });
      }
    }
    this._spinoutCd -= dt;
    this._prevCamQuat.copy(q);
    this._camQuatValid = true;
  }

  private readMoveInput(): { forward: number; right: number; jumpHeld: boolean; skiHeld: boolean; moveX: number; moveZ: number } {
    const fwd = this.getForwardXZ();
    const rgt = this.getRightXZ();

    let forward = 0, right = 0;
    if (isDown(this.keys, 'forward') || this.keys['ArrowUp'])    forward += 1;
    if (isDown(this.keys, 'back') || this.keys['ArrowDown'])     forward -= 1;
    if (isDown(this.keys, 'left') || this.keys['ArrowLeft'])     right -= 1;
    if (isDown(this.keys, 'right') || this.keys['ArrowRight'])   right += 1;

    // Normalize input
    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward, right,
      jumpHeld: this.jumpHeld, // autoHop: held = pressed
      skiHeld: isDown(this.keys, 'ski'),
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
    // Chaingun + lightning gun auto-fire while held; the rest are per-click.
    const wid = this.loadout[this.weaponIndex];
    const isBeam = wid === 2 || wid === 8;
    // Weapon is lowered during a belt-throw — no primary fire mid-throw.
    const wantFire = this.throwLockT <= 0 &&
      (isBeam ? this.mouseHeld : (this.firePending || (this.mouseHeld && !this.needsRelease)));
    if (!this.mouseHeld) this.needsRelease = false;
    if (wantFire && this.fireTimer <= 0) {
      this.fireTimer = Player.WEAPON_RATES[wid];
      const fireCallback = wid === 1 ? this.onDiscLauncher
        : wid === 2 ? this.onChaingun
        : wid === 3 ? this.onMortar
        : wid === 4 ? this.onGrenadeLauncher
        : wid === 5 ? this.onFlak
        : wid === 6 ? this.onPlasma
        : wid === 7 ? this.onRailgun
        : wid === 8 ? this.onLightning
        : wid === 9 ? this.onShotgun
        : wid === 10 ? this.onCannon
        : wid === 11 ? this.onRocketLauncher
        : this.onFire;
      fireCallback?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }
    this.firePending = false;

    // Disc (C key) - belt throw, hold to fire
    if (this.discHeld && this.discTimer <= 0) {
      this.discTimer = DISC_RATE;
      this.throwLockT = THROW_TOTAL;
      this.onDisc?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }

    // Grenade (F key) - belt throw, hold to fire
    if (this.grenadeHeld && this.grenadeTimer <= 0) {
      this.grenadeTimer = GRENADE_RATE;
      this.throwLockT = THROW_TOTAL;
      this.onGrenade?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }
  }

  // Movement-event FX: jetpack trail, ski dust, jump event + anim trigger
  private stepAcc = 0; // footstep-dust distance accumulator

  private emitMoveEvents(isJetting: boolean, skiHeld: boolean, jumpHeld: boolean, dt: number): void {
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
    this.skiing = skiHeld && this.onGround && this.vel.lengthSq() > 10;
    if (this.skiing && this.onSki) {
      this.onSki(this.pos, this.vel); // read-only use — no clones, runs every frame
    }

    // Footstep dust — grounded, not skiing, actually moving. Distance-paced
    // (~0.9m ≈ one puff per step) so a jog puffs at footfall cadence and
    // standing still puffs nothing.
    const wsp = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && !this.skiing && wsp > 1.5) {
      this.stepAcc += wsp * dt;
      if (this.stepAcc >= 0.9) {
        this.stepAcc = 0;
        this.onFootDust?.(this.pos, this.vel);
      }
    } else {
      this.stepAcc = 0;
    }

    this.skills.postMove(this.wasOnGround, this.onGround, this.prevVelY);

    // Ground-contact sound — any landing transition (slam stacks its own
    // bigger boom on top via onSlam).
    if (!this.wasOnGround && this.onGround) {
      this.onLand?.(Math.max(0, -this.prevVelY));
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

  /** Nugget pickup: refill the tank + free jetting for 5s (refresh only). */
  grantJetBoost(): void {
    this.energy = MAX_ENERGY;
    this.jetBoostTimer = 5;
  }

  /** Nugget pickup: restore a chunk of health, capped at max. */
  heal(fraction: number): void {
    this.health = Math.min(MAX_HEALTH, this.health + MAX_HEALTH * fraction);
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
