import * as THREE from 'three';

import { MAX_ENERGY, MAX_HEALTH, JET_DRAIN, JET_CHARGE, DISC_RATE, MELEE_COOLDOWN, MELEE_LUNGE } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { PlayerSkills, SHIELD_DMG_PER_ENERGY } from './player/skills.js';
import { STATUS } from '../../../shared/status.js';
import { perkMods, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import { makeShieldBubble, ShieldBubble } from '../effects/shieldBubble.js';

import { MovementController, MovementState } from './movement.js';
import { weaponDef, SLOT_COUNT, type WeaponDef } from '../weapons.js';
import { settings } from '../core/settings.js';
import { isDown } from '../core/keybinds.js';
import { PlayerInput } from './player/input.js';
import { PlayerModel } from './PlayerModel.js';
import { PlayerVisuals } from './PlayerVisuals.js';
import { THROW_TOTAL, SIDEARM_DRAW_TIME } from './ViewModel.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('Player');

export interface FireEvent {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  playerVel: THREE.Vector3;
}

export type SkillId = 'bounce' | 'blink' | 'dash' | 'slam' | 'warp' | 'cloak' | 'shield' | 'medkit';
export const SKILL_ORDER: SkillId[] = ['bounce', 'blink', 'dash', 'slam', 'warp', 'cloak', 'shield', 'medkit'];

// Belt loadout slot — one throwable on the belt key; fire.ts maps each id
// to its projectile config. Order is the loadout-menu order.
// 'remoterailgun' = capacitor slug that discharges a hitscan rail mid-flight.
export const BELT_ITEMS = ['disc', 'grenade', 'cluster', 'javelin', 'sticky', 'impact', 'remoterailgun'] as const;
export type BeltItem = typeof BELT_ITEMS[number];

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0.0;
  pitch = 0.0;

  onGround = false;
  energy = MAX_ENERGY;
  /** Nugget pickup: free jetting for a few seconds (refresh, not stack). */
  fireTimer = 0.0;
  beltTimer = 0.0;
  // Primary fire is locked while the belt-throw anim plays — the weapon is
  // physically lowered, shooting mid-throw would fire through the hip.
  throwLockT = 0;
  health = 100;
  /** Server-owned bonus pool (powerup drops) — absorbs most of a hit
   *  before health; mirrored from playerHit/buff messages, never set
   *  locally. */
  armor = 0;
  /** Timed powerup expiries (server epoch ms — same clock offset the
   *  buff message `until` arrives on; we just compare against Date.now). */
  buffUntil = { regen: 0, dd: 0 };
  /** Passive loadout pick — mods from shared/perks.ts; announced at join. */
  perk: PerkId = (PERK_ORDER as string[]).includes(settings.get('fps-perk')) ? settings.get('fps-perk') as PerkId : 'none';
  get mods() { return perkMods(this.perk); }
  get maxHealth(): number { return MAX_HEALTH + this.mods.maxHealth; }
  setPerk(p: PerkId): void { this.perk = p; settings.set('fps-perk', p); }
  kills = 0;
  isDead = false;
  /** Verb phrase for the death message ("devoured by a crawler") — set by
   *  every environment-damage path so the kill feed names the real killer. */
  lastDamageSource = '';
  get inputFrozen(): boolean { return this.input.frozen; } // true = keyboard/mouse ignored (demo playback)

  // Spectator fly: the death-observer free-flight cam without dying — no
  // desaturation, no respawn timer, body follows the ghost (pos IS the
  // camera rig). Toggled by the 'spectate' bind (V).
  private spectating = false;
  get isSpectating(): boolean { return this.spectating; }
  // HUD hook — spectating drops the combat chrome (crosshair/health/belt)
  // and shows an exit hint instead
  onSpectate: ((on: boolean) => void) | null = null;

  // Cloak state lives in PlayerSkills; mirrored here so targeting, HUD,
  // and model visibility read one flag without reaching into the skill.
  private cloaked = false;
  get isCloaked(): boolean { return this.cloaked; }
  onCloak: ((on: boolean) => void) | null = null;
  private setCloaked(on: boolean): void {
    if (this.cloaked === on) return;
    this.cloaked = on;
    this.model?.setVisible(this.thirdPerson && !this.isDead && !this.spectating && !on);
    this.onCloak?.(on);
  }

  // Shield mirrors cloak: one flag consumed by wire send + HUD + model fx.
  private shielded = false;
  get isShielded(): boolean { return this.shielded; }
  onShield: ((on: boolean) => void) | null = null;

  // Medkit: flag rides the wire like cloak/shield; the server heals while
  // it's up, the client burns energy — see skills.ts for the economy.
  private mending = false;
  get isMending(): boolean { return this.mending; }
  onMend: ((on: boolean) => void) | null = null;
  /** Live connectivity probe — in MP the server ticks the heal, not us.
   *  Queried per-frame rather than latched: a mid-match disconnect must
   *  hand health authority back to the client. */
  serverOwnsHealth: (() => boolean) | null = null;
  private setMending(on: boolean): void {
    if (this.mending === on) return;
    this.mending = on;
    this.onMend?.(on);
  }
  // All toggle states collapse into the wire status byte — one place
  // computes it so a new channel never forgets its wire bit.
  private statusBits(): number {
    return (this.cloaked ? STATUS.CLOAK : 0)
         | (this.shielded ? STATUS.SHIELD : 0)
         | (this.mending ? STATUS.MEND : 0);
  }
  // Third-person bubble — lazily built so a non-shield slot costs nothing.
  private shieldBubble: ShieldBubble | null = null;
  private setShielded(on: boolean): void {
    if (this.shielded === on) return;
    this.shielded = on;
    if (on && !this.shieldBubble) this.shieldBubble = makeShieldBubble(this.scene);
    // Own bubble only renders in third person — in first person it would
    // swallow the camera; the gun shell + vignette are the FP read instead.
    if (this.shieldBubble) this.shieldBubble.mesh.visible = on && this.thirdPerson;
    this.onShield?.(on);
  }

  /** Inbound damage while the bubble is up burns energy (10 dmg = 1 energy)
   *  instead of health. Returns the health damage that still gets through —
   *  zero while the tank holds. */
  absorbShieldDamage(dmg: number): number {
    if (!this.shielded) return dmg;
    this.energy = Math.max(0, this.energy - dmg / SHIELD_DMG_PER_ENERGY);
    this.shieldBubble?.flash();
    if (this.energy <= 0) {
      this.skills.forceShieldOff();
      return 0; // popped exactly on empty — the breaking hit is still soaked
    }
    return 0;
  }

  toggleSpectator(): void {
    if (this.isDead) return; // dead already gives you this cam
    this.spectating = !this.spectating;
    // Land mid-toggle-off in the air and the body floats — drop the ghost's
    // drift so gravity owns the fall again. Also drop any fire/jet clicks
    // queued while ghosted so they don't discharge on the way out.
    if (!this.spectating) {
      this.vel.set(0, 0, 0);
      this.input.firePending = false;
      this.input.jetPending = false;
    }
    this.model?.setVisible(!this.spectating && this.thirdPerson && !this.isDead && !this.cloaked);
    this.onSpectate?.(this.spectating);
  }

  freezeInput(): void {
    // Clear all tracked input so nothing leaks from before playback
    this.input.frozen = true;
    this.input.clearAll();
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
    this.input.frozen = false;
  }

  private terrain: Terrain;
  private camera: THREE.PerspectiveCamera;
  public movement: MovementController; // Public for client-side prediction reconciliation
  private model: PlayerModel | null = null;
  private jumpAnimTimer = 0.0;
  private wasOnGround = false;
  private visuals: PlayerVisuals; // camera/shadow/gizmo/observer — see PlayerVisuals.ts

  // Input state lives in PlayerInput — raw DOM events → flags, game
  // semantics reach back through the handler interface it was given.
  private input!: PlayerInput;
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
  // weapon id (index into weapons.ts SLOT_DEFS). ESC menu assigns.
  loadout: number[] = Player.parseLoadout(settings.get('fps-loadout'));
  static readonly LOADOUT_SLOTS = 4;
  // Belt: one throwable equipped, the belt key throws it. ESC menu picks.
  beltItem: BeltItem = (BELT_ITEMS as readonly string[]).includes(settings.get('fps-belt'))
    ? settings.get('fps-belt') as BeltItem : 'disc';
  // Sidearm: one hold-out weapon — the sidearm key pulls it while held.
  // wid is slot-space (SLOT_DEFS index): pistol 12, revolver 13, shotgun 9.
  // (sticky launcher sits at wid 14 — primary loadout, not a hold-out.)
  static readonly SIDEARM_WIDS = { pistol: 12, revolver: 13, shotgun: 9 } as const;
  sidearm: 'pistol' | 'revolver' | 'shotgun' =
    (settings.get('fps-sidearm') as 'pistol' | 'revolver' | 'shotgun') in Player.SIDEARM_WIDS
      ? settings.get('fps-sidearm') as 'pistol' | 'revolver' | 'shotgun' : 'pistol';
  // Pack: one deployable on the deploy key — ESC menu picks.
  packItem: 'turret' | 'mine' | 'station' | 'drone' =
    (['turret', 'mine', 'station', 'drone'] as const).includes(settings.get('fps-pack') as 'turret' | 'mine' | 'station' | 'drone')
      ? settings.get('fps-pack') as 'turret' | 'mine' | 'station' | 'drone' : 'turret';

  private static parseLoadout(raw: string): number[] {
    const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < SLOT_COUNT);
    return ids.length === Player.LOADOUT_SLOTS ? ids : [0, 2, 6, 7];
  }

  get currentWeapon(): number { return this.loadout[this.weaponIndex]; }

  /** Kill-refund (railgun): ready instantly, but requires a fresh click —
   *  without needsRelease the still-held trigger would re-fire same-frame. */
  refundWeaponCooldown(): void {
    this.fireTimer = 0;
    this.input.needsRelease = true;
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

  setBeltItem(item: BeltItem): void {
    this.beltItem = item;
    settings.set('fps-belt', item);
  }
  setSidearm(s: 'pistol' | 'revolver' | 'shotgun'): void {
    this.sidearm = s;
    settings.set('fps-sidearm', s);
  }
  setPackItem(p: 'turret' | 'mine' | 'station' | 'drone'): void {
    this.packItem = p;
    settings.set('fps-pack', p);
  }
  get sidearmWid(): number { return Player.SIDEARM_WIDS[this.sidearm]; }
  // wid → WeaponType lives on the def: weaponDef(wid).weaponType.
  private _lastJetpackSend = 0;

  // Hold-out secondaries: while the bind is held the weapon swaps in and
  // auto-fires at its own cadence; release snaps back to the loadout slot.
  // wids are slot-space indices into SLOT_DEFS.
  private secondaryWid: number | null = null;
  // Draw delay — the hold-out key swaps the model in instantly but firing
  // waits for the raise, so the gun isn't shooting through its own holster.
  private secondaryDrawT = 0;

  // Events
  /** Trigger handler — receives the weapon's def so combat dispatches by
   *  kind (projectile / pellet fan / beam) instead of a per-weapon table. */
  onWeaponFire: ((def: WeaponDef, e: FireEvent) => void) | null = null;
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
  onBelt: ((e: FireEvent, item: BeltItem) => void) | null = null;
  onMelee: ((e: FireEvent) => void) | null = null;
  onWeaponSwitch: ((index: number) => void) | null = null;
  /** Pack items — main wires these to the deployables manager. */
  onDeploy: (() => void) | null = null;
  onNetworkJump: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkJetpack: ((pos: { x: number; y: number; z: number }) => void) | null = null;
  onNetworkInput: ((input: { forward: number; right: number; jump: number; ski: number; jet?: number; status?: number }, rotation: { yaw: number; pitch: number }) => void) | null = null;

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
      emitCloak: (on) => this.setCloaked(on),
      emitShield: (on) => this.setShielded(on),
      emitMend: (on) => this.setMending(on),
      healSelf: (hp) => { this.health = Math.min(this.maxHealth, this.health + hp); },
      netHeals: () => this.serverOwnsHealth?.() ?? false,
      shieldAbsorb: (dmg) => { this.energy = Math.max(0, this.energy - dmg); if (this.energy <= 0) this.setShielded(false); },
      energy: () => this.energy,
      spendEnergy: (n) => { if (this.energy < n) return false; this.energy -= n; return true; },
      drainEnergy: (n) => { this.energy = Math.max(0, this.energy - n); },
    });

    this.input = new PlayerInput({
      isSpectating: () => this.spectating,
      toggleSpectator: () => this.toggleSpectator(),
      melee: () => this.tryMelee(),
      toggleCamera: () => {
        this.thirdPerson = !this.thirdPerson;
        this.model?.setVisible(this.thirdPerson && !this.isDead && !this.cloaked);
        // Own bubble exists for spectators/remote eyes only — FP is the
        // gun shell + vignette, so it flips with the camera toggle.
        if (this.shieldBubble) this.shieldBubble.mesh.visible = this.shielded && this.thirdPerson;
      },
      skillPress: () => this.skills.press(this.skill),
      skillRelease: () => this.skills.release(this.skill),
      sidearmWid: () => this.sidearmWid,
      secondaryDown: (wid) => {
        if (wid !== this.secondaryWid) {
          this.secondaryWid = wid;
          this.secondaryDrawT = SIDEARM_DRAW_TIME;
          this.onWeaponSwitch?.(wid);
        }
      },
      secondaryUp: () => {
        if (this.secondaryWid !== null) {
          this.secondaryWid = null;
          this.onWeaponSwitch?.(this.currentWeapon);
        }
      },
      deploy: () => this.onDeploy?.(),
      selectSlot: (i) => {
        if (i !== this.weaponIndex) {
          this.weaponIndex = i;
          this.onWeaponSwitch?.(this.loadout[i]);
        }
      },
      cycleWeapon: (step) => {
        const n = this.loadout.length;
        const idx = (this.weaponIndex + step + n) % n;
        if (idx !== this.weaponIndex) {
          this.weaponIndex = idx;
          this.onWeaponSwitch?.(this.loadout[idx]);
        }
      },
      look: (dx, dy) => {
        this.yaw -= dx * 0.002 * this.input.sensitivity;
        this.pitch += dy * 0.002 * this.input.sensitivity * (this.input.invertY ? 1 : -1);
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
      },
    });
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

  private getForwardXZ(): THREE.Vector2 {
    return new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
  }
  private getRightXZ(): THREE.Vector2 {
    return new THREE.Vector2(-Math.cos(this.yaw), Math.sin(this.yaw));
  }

  getInputState(): { forward: number; right: number; jumpPressed: boolean; jumpHeld: boolean; skiHeld: boolean; firePressed: boolean; jetHeld: boolean; beltHeld: boolean } {
    const keys = this.input.keys;
    let forward = 0, right = 0;
    if (isDown(keys, 'forward') || keys['ArrowUp'])    forward += 1;
    if (isDown(keys, 'back') || keys['ArrowDown'])     forward -= 1;
    if (isDown(keys, 'left') || keys['ArrowLeft'])     right -= 1;
    if (isDown(keys, 'right') || keys['ArrowRight'])   right += 1;

    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward,
      right,
      jumpPressed: this.input.jumpHeld,
      jumpHeld: this.input.jumpHeld,
      skiHeld: isDown(keys, 'ski'),
      firePressed: this.input.firePending,
      jetHeld: this.input.jetPending,
      beltHeld: this.input.beltHeld,
    };
  }

  update(dt: number): void {
    // Dying while spectating: death owns the cam now — drop the flag so
    // respawn doesn't leave the player stuck flying
    if (this.isDead) this.setCloaked(false); // corpse can't stay hidden
    if (this.spectating && this.isDead) {
      this.spectating = false;
      this.onSpectate?.(false);
    }
    if (this.isDead || this.spectating) {
      const obInput = this.readMoveInput();
      // T1/T2 observer mode: free-look + fly till respawn
      this.visuals.updateObserverCam(dt, this.camera, this.terrain, this.pos, this.vel, this.yaw, this.pitch, {
        forward: obInput.forward, right: obInput.right, jumpHeld: obInput.skiHeld,
        shiftDown: !!(this.input.keys['ShiftLeft'] || this.input.keys['ShiftRight']),
      });
      return;
    }
    if (this.input.frozen) {
      // still update camera for demo playback
      this.visuals.updateFrozenCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
      return;
    }

    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.beltTimer = Math.max(0, this.beltTimer - dt);
    this.throwLockT = Math.max(0, this.throwLockT - dt);
    this.secondaryDrawT = Math.max(0, this.secondaryDrawT - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.skills.tickCooldowns(dt);
    this.skills.updateBeacon(dt);
    this.skills.updateCloak(dt);
    this.skills.updateShield(dt);
    this.skills.updateMend(dt);
    if (this.shieldBubble) {
      this.shieldBubble.update(dt);
      if (this.shielded) this.shieldBubble.mesh.position.set(this.pos.x, this.pos.y - 0.6, this.pos.z);
    }

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
      // Jet thrust lives inside the sim so the server's shadow replay
      // produces the same trajectory the client renders.
      jetHeld: this.input.jetPending && this.energy > 0,
    });

    // Fall speed entering this frame — grounding inside movement.update
    // zeroes vel.y, so the slam impact reads the pre-integration value
    this.prevVelY = this.vel.y;

    // Run physics
    this.movement.update(dt);

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward: input.forward, right: input.right, jump: input.jumpHeld ? 1 : 0, ski: input.skiHeld ? 1 : 0, jet: this.input.jetPending && this.energy > 0 ? 1 : 0, status: this.statusBits() },
        { yaw: this.yaw, pitch: this.pitch }
      );
    }

    // Sync state from movement controller (local prediction)
    const moveState = this.movement.getState();
    this.pos.copy(moveState.pos);
    this.vel.copy(moveState.vel);
    this.onGround = moveState.onGround;

    // Jetpack thrust is inside the shared sim now (fed via jetHeld above,
    // applied post-collision inside MoveSim.update) — here only the energy
    // economy and the FX flag remain.
    const isJetting = this.input.jetPending && this.energy > 0;
    this.jetting = isJetting;
    if (isJetting) {
      this.energy -= JET_DRAIN * this.mods.jetDrain * dt;
      this.onGround = false;
    }

    // Energy recharge — paused while jetting (Tribes-style: drain 12/s
    // while burning, recharge 8/s only when off the jet)
    // Regen also pauses while cloaked — invisibility and jets compete
    // for the same tank, never fill it together.
    if (!isJetting && !this.cloaked && !this.shielded && !this.mending) {
      this.energy = Math.min(MAX_ENERGY, this.energy + JET_CHARGE * this.mods.jetRegen * this.mods.energyRegen * dt);
    }

    // Regenerator perk — MP regenerates in the server tick; offline we
    // tick it here so the perk works without a connection.
    if (this.mods.regen > 0 && !(this.serverOwnsHealth?.() ?? false) && !this.isDead) {
      this.health = Math.min(this.maxHealth, this.health + this.mods.regen * dt);
    }

    // ---- All visual/event spawns below use the final post-physics position ----

    this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch, this.thirdPerson);
    this.checkCameraSpinout(dt);
    // Model visibility follows the toggle AND death (observer cam is ghost
    // flight — your corpse shouldn't fly with you)
    this.model?.setVisible(this.thirdPerson && !this.isDead && !this.cloaked);
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
    const keys = this.input.keys;

    let forward = 0, right = 0;
    if (isDown(keys, 'forward') || keys['ArrowUp'])    forward += 1;
    if (isDown(keys, 'back') || keys['ArrowDown'])     forward -= 1;
    if (isDown(keys, 'left') || keys['ArrowLeft'])     right -= 1;
    if (isDown(keys, 'right') || keys['ArrowRight'])   right += 1;

    // Normalize input
    const mlen = Math.sqrt(forward * forward + right * right);
    if (mlen > 0) { forward /= mlen; right /= mlen; }

    return {
      forward, right,
      jumpHeld: this.input.jumpHeld, // autoHop: held = pressed
      skiHeld: isDown(keys, 'ski'),
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
    const wid = this.secondaryWid ?? this.loadout[this.weaponIndex];
    const def = weaponDef(wid);
    // Weapon is lowered during a belt-throw — no primary fire mid-throw.
    // A held secondary auto-fires at its own cadence — no click needed.
    const wantFire = this.throwLockT <= 0 &&
      (this.secondaryWid !== null ? this.secondaryDrawT <= 0
        : def.auto ? this.input.mouseHeld : (this.input.firePending || (this.input.mouseHeld && !this.input.needsRelease)));
    if (!this.input.mouseHeld) this.input.needsRelease = false;
    if (wantFire && this.fireTimer <= 0) {
      this.fireTimer = def.rate;
      this.onWeaponFire?.(def, { origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() });
    }
    this.input.firePending = false;

    // Belt item (C key) — the equipped throw; hold to repeat
    if (this.input.beltHeld && this.beltTimer <= 0) {
      this.beltTimer = DISC_RATE;
      this.throwLockT = THROW_TOTAL;
      this.onBelt?.({ origin: this.pos.clone(), dir: this.getAimDir(), playerVel: this.vel.clone() }, this.beltItem);
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

  /** Nugget pickup: half the tank back, no free-jet window — unlimited
   *  energy made the toggle skills (cloak/shield/mend) effectively free. */
  grantJetBoost(): void {
    this.energy = Math.min(MAX_ENERGY, this.energy + MAX_ENERGY * 0.5);
  }

  /** Nugget pickup: restore a chunk of health, capped at max. */
  heal(fraction: number): void {
    this.health = Math.min(this.maxHealth, this.health + this.maxHealth * fraction);
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
