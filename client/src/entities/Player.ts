import * as THREE from 'three';

import { MAX_ENERGY, MAX_HEALTH, JET_DRAIN, JET_CHARGE, MELEE_COOLDOWN, MELEE_LUNGE } from '../core/config.js';

import { Terrain } from '../world/terrain.js';
import { PlayerSkills } from './player/skills.js'
import { buildSkillsCtx, buildInputCtx } from './playerCtor.js';;
import { perkMods, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import { CLASS_STATS, CLASS_MODEL_SCALE, type ArmorClass } from '../../../shared/botClasses.js';
import { PlayerStatus } from './playerStatus.js';

import { MovementController, MovementState } from './movement.js';
import { type WeaponDef } from '../weapons.js';
import { settings } from '../core/settings.js';
import * as read from './playerRead.js';
import { PlayerInput } from './player/input.js';
import { PlayerModel } from './PlayerModel.js';
import * as imp from './playerImpulse.js';
import { PlayerEmit } from './playerEmit.js';
import { PlayerLoadout } from './playerLoadout.js';
import { DEPLOY_KINDS, type DeployKind } from '../../../shared/deployables.js';
import { PlayerVisuals } from './PlayerVisuals.js';
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
export const BELT_ITEMS = ['disc', 'grenade', 'cluster', 'javelin', 'sticky', 'impact', 'remoterailgun', 'armornade'] as const;
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
  /** Passive loadout pick — mods from shared/perks.ts; announced at join.
   *  This is the PICKED intent; `appliedPerk` is what the sim reads. */
  perk: PerkId = (PERK_ORDER as string[]).includes(settings.get('fps-perk')) ? settings.get('fps-perk') as PerkId : 'none';
  /** The perk actually in effect — diverges from `perk` between a
   *  mid-match pick and the respawn that banks it (same rule as class). */
  appliedPerk: PerkId = 'none';
  /** The tier you PICKED — drives the join handshake + the loadout
   *  filter. The sim/body wear `appliedClass` until the pick banks. */
  armorClass: ArmorClass = (['light','medium','heavy'] as string[]).includes(settings.get('fps-class')) ? settings.get('fps-class') as ArmorClass : 'medium';
  /** The tier actually in effect. Diverges from armorClass between a
   *  mid-match pick and the respawn that applies it — swapping speed/HP
   *  mid-life would desync the shadow and hand out free heals. */
  appliedClass: ArmorClass = 'medium';
  get mods() { return perkMods(this.appliedPerk); }
  /** Pool cap after the perk multiplier — cloak/shield/mend share it. */
  get energyCap(): number { return MAX_ENERGY * this.mods.energyMax; }
  get maxHealth(): number { return MAX_HEALTH + this.mods.maxHealth + CLASS_STATS[this.appliedClass].maxHealth; }
  setPerk(p: PerkId): void { this.armory.setPerk(p); }
  /** Menu pick — records the intent; the swap banks at respawn. */
  setArmorClass(c: ArmorClass): void { this.armory.setArmorClass(c); }
  /** Respawn-time class/perk banking — armory applies speed scale, HP
   *  pool, ordnance unshoulder and the silhouette rescale together. */
  applyPendingClass(): void { this.armory.applyPendingClass(); }
  applyPendingPerk(): void { this.armory.applyPendingPerk(); }

  /** New-life state reset — shared by the wire respawn path and the
   *  offline killLocal respawn so neither forgets a field (a stale buff
   *  or lastDamageSource leaking into the next life already happened). */
  resetLifeState(): void {
    this.isDead = false;
    this.applyPendingPerk(); // banked perk lands first — maxHealth reads it
    this.applyPendingClass(); // banked tier swap lands on the new life
    this.health = this.maxHealth;
    this.armor = 0;
    this.buffUntil.regen = 0;
    this.buffUntil.dd = 0;
    this.lastDamageSource = '';
    this.vel.set(0, 0, 0);
  }

  kills = 0;
  isDead = false;
  /** Verb phrase for the death message ("devoured by a crawler") — set by
   *  every environment-damage path so the kill feed names the real killer. */
  lastDamageSource = '';
  get inputFrozen(): boolean { return this.input.frozen; } // true = keyboard/mouse ignored (demo playback)

  // Toggle-status family (cloak/shield/mend flags, wire status byte,
  // shield bubble, spectator ghost-flight) lives in playerStatus.ts —
  // these getters/hooks keep the public names the rest of the app reads.
  status = new PlayerStatus(this);
  get isSpectating(): boolean { return this.status.spectating; }
  get isCloaked(): boolean { return this.status.cloaked; }
  get isShielded(): boolean { return this.status.shielded; }
  get isMending(): boolean { return this.status.mending; }
  onSpectate: ((on: boolean) => void) | null = null;
  onCloak: ((on: boolean) => void) | null = null;
  onShield: ((on: boolean) => void) | null = null;
  onMend: ((on: boolean) => void) | null = null;
  /** Live connectivity probe — in MP the server ticks the heal, not us.
   *  Queried per-frame rather than latched: a mid-match disconnect must
   *  hand health authority back to the client. */
  serverOwnsHealth: (() => boolean) | null = null;

  absorbShieldDamage(dmg: number): number { return this.status.absorbShieldDamage(dmg); }
  toggleSpectator(): void { this.status.toggleSpectator(); }

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
  tryMelee(): void {
    if (this.meleeCooldown > 0) return;
    this.meleeCooldown = MELEE_COOLDOWN;
    const dir = this.getAimDir();
    this.vel.addScaledVector(dir, MELEE_LUNGE);
    this.syncMovement();
    this.model?.weaponPunch();
    this.onMelee?.({ origin: this.pos.clone(), dir, playerVel: this.vel.clone() });
  }

  unfreezeInput(): void {
    this.input.frozen = false;
  }

  private terrain: Terrain;
  camera: THREE.PerspectiveCamera;
  public movement: MovementController; // Public for client-side prediction reconciliation
  model: PlayerModel | null = null; // public — PlayerEmit/PlayerStatus read it
  jumpAnimTimer = 0.0; // public — PlayerEmit re-arms it on lift-off
  shootAnimTimer = 0.0;
  wasOnGround = false; // public — PlayerEmit owns the transition edge
  visuals: PlayerVisuals; // camera/shadow/gizmo/observer — see PlayerVisuals.ts

  // Input state lives in PlayerInput — raw DOM events → flags, game
  // semantics reach back through the handler interface it was given.
  input!: PlayerInput; // public — PlayerStatus clears pending fire/jet
  // Skills live on Q — the loadout picks which one is equipped.
  skill: SkillId = (SKILL_ORDER as string[]).includes(settings.get('fps-skill'))
    ? settings.get('fps-skill') as SkillId : 'bounce';
  skills!: PlayerSkills; // public — PlayerEmit calls postMove on it
  // Declared discontinuity: next position report goes out as a 'teleport'
  // message so the server reseats its plausibility anchor instead of
  // rejecting the jump as a speedhack (the >50m rubber-band loop).
  pendingTeleport = false;
  markTeleport(): void {
    this.pendingTeleport = true;
    // Declared snaps also re-arm the spinout detector — a respawn/skill
    // teleport legitimately jumps the camera, which isn't a spinout.
    this._camQuatValid = false;
  }

  scene: THREE.Scene; // public — PlayerStatus builds the shield bubble in it
  prevVelY = 0;        // vel.y entering this frame — impact speed at grounding (post-update vel.y is already zeroed); PlayerEmit reads it
  private emitFx = new PlayerEmit(this);
  // Weapon slots: 0 = rocket (LMB), 1 = disc launcher, 2 = chaingun,
  // 3 = mortar, 4 = grenade launcher
  weaponIndex = 0;
  // 4-slot loadout: weaponIndex is the SLOT (0-3); loadout[slot] is the
  // weapon id (index into weapons.ts SLOT_DEFS). ESC menu assigns.
  loadout: number[] = PlayerLoadout.parseLoadout(settings.get('fps-loadout'));

  // Belt: one throwable equipped, the belt key throws it. ESC menu picks.
  beltItem: BeltItem = (BELT_ITEMS as readonly string[]).includes(settings.get('fps-belt'))
    ? settings.get('fps-belt') as BeltItem : 'disc';
  // Sidearm: one hold-out weapon — the sidearm key pulls it while held.
  static readonly HEAVY_ONLY = PlayerLoadout.HEAVY_ONLY;
  static readonly LOADOUT_SLOTS = PlayerLoadout.LOADOUT_SLOTS;
  static readonly SIDEARM_WIDS = PlayerLoadout.SIDEARM_WIDS;
  sidearm: 'pistol' | 'revolver' | 'shotgun' | 'repair' =
    (settings.get('fps-sidearm') as 'pistol' | 'revolver' | 'shotgun' | 'repair') in Player.SIDEARM_WIDS
      ? settings.get('fps-sidearm') as 'pistol' | 'revolver' | 'shotgun' | 'repair' : 'pistol';
  // Pack: one deployable on the deploy key — ESC menu picks.
  packItem: DeployKind =
    (DEPLOY_KINDS as readonly string[]).includes(settings.get('fps-pack'))
      ? settings.get('fps-pack') as DeployKind : 'turret';


  get currentWeapon(): number { return this.armory.currentWid; }

  /** Kill-refund (railgun): ready instantly, fresh click required. */
  refundWeaponCooldown(): void { this.armory.refundWeaponCooldown(); }

  setLoadoutSlot(slot: number, weaponId: number): void { this.armory.setLoadoutSlot(slot, weaponId); }
  setBeltItem(item: BeltItem): void { this.armory.setBeltItem(item); }
  setSidearm(s: 'pistol' | 'revolver' | 'shotgun' | 'repair'): void { this.armory.setSidearm(s); }
  setPackItem(p: DeployKind): void { this.armory.setPackItem(p); }
  get sidearmWid(): number { return this.armory.sidearmWid; }
  // wid → WeaponType lives on the def: weaponDef(wid).weaponType.

  // Hold-out secondaries: while the bind is held the weapon swaps in and
  // auto-fires at its own cadence; release snaps back to the loadout slot.
  // wids are slot-space indices into SLOT_DEFS.
  // Class-tier/perk banking, slot/belt/sidearm/pack picks and the hold-out
  // secondary swap — the armory lives in playerLoadout.ts.
  armory = new PlayerLoadout(this);

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
  /** Body-model barrel tip in world space — the beam/tracer anchor when
   *  the viewmodel is hidden (third person / spectating). */
  muzzleWorld(out: THREE.Vector3): boolean {
    return this.model?.muzzleWorld(out) ?? false;
  }
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
    this.appliedClass = this.armorClass;
    this.appliedPerk = this.perk;
    this.movement.setSpeedScale(CLASS_STATS[this.appliedClass].speedScale);
    if (this.appliedClass !== 'heavy') this.armory.unshoulderHeavy();

    // Your third-person body is the mannequin at your tier's silhouette
    // scale — the same read remotes get (one cast, class reads as bulk).
    this.model = new PlayerModel(scene, 'mannequin');
    this.visuals = new PlayerVisuals(scene);

    // Q-slot skills + input routing — the two ctx objects live in
    // playerCtor.ts (wire-up, not gameplay).
    this.skills = new PlayerSkills(buildSkillsCtx(this, terrain, scene));
    this.input = new PlayerInput(buildInputCtx(this));
  }

  async loadModel(): Promise<void> {
    if (this.model) {
      await this.model.load();
      this.model.setScale(CLASS_MODEL_SCALE[this.appliedClass]);
      // Hide model for first-person view
      this.model.setVisible(false);
      // Hide collider gizmo for local player (only show for remote players)
      this.model.setColliderVisible(false);
    }
  }

  private getForwardXZ(): THREE.Vector2 { return read.getForwardXZ(this); }
  private getRightXZ(): THREE.Vector2 { return read.getRightXZ(this); }

  getInputState(): { forward: number; right: number; jumpPressed: boolean; jumpHeld: boolean; skiHeld: boolean; firePressed: boolean; jetHeld: boolean; beltHeld: boolean } {
    return read.getInputState(this);
  }

  update(dt: number): void {
    // Dying while spectating: death owns the cam now â€” drop the flag so
    // respawn doesn't leave the player stuck flying
    if (this.isDead) this.status.setCloaked(false); // corpse can't stay hidden
    if (this.status.spectating && this.isDead) {
      this.status.spectating = false;
      this.onSpectate?.(false);
    }
    if (this.isDead || this.status.spectating) {
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

    this.tickTimers(dt);

    if (this.skills.updateBlink(dt)) return;

    const input = this.readMoveInput();
    this.stepMovement(dt, input);
    const isJetting = this.tickEnergy(dt);

    // ---- All visual/event spawns below use the final post-physics position ----

    this.visuals.updateCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch, this.thirdPerson);
    this.checkCameraSpinout(dt);
    // Model visibility follows the toggle AND death (observer cam is ghost
    // flight â€” your corpse shouldn't fly with you)
    this.model?.setVisible(this.thirdPerson && !this.isDead && !this.status.cloaked);
    this.visuals.updateFeetMarker(this.terrain, this.pos);
    this.fireWeapons();
    this.emitFx.moveEvents(isJetting, input.skiHeld, input.jumpHeld, dt);
    this.visuals.updateShadowBlob(this.terrain, this.pos);
    this.jumpAnimTimer = this.visuals.updateModelAnim(this.model, this.pos, this.yaw, this.pitch, this.jumpAnimTimer, this.getSpeed(), dt, this.onGround, isJetting, this.vel, input.skiHeld, this.shootAnimTimer, this.thirdPerson);
  }

  private tickTimers(dt: number): void {
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.shootAnimTimer = Math.max(0, this.shootAnimTimer - dt);
    this.beltTimer = Math.max(0, this.beltTimer - dt);
    this.throwLockT = Math.max(0, this.throwLockT - dt);
    this.armory.secondaryDrawT = Math.max(0, this.armory.secondaryDrawT - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.skills.tickCooldowns(dt);
    this.skills.updateBeacon(dt);
    this.skills.updateCloak(dt);
    this.skills.updateShield(dt);
    this.skills.updateMend(dt);
    this.status.tickBubble(dt);
  }

  private stepMovement(dt: number, input: ReturnType<Player['readMoveInput']>): void {
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

    // Fall speed entering this frame â€” grounding inside movement.update
    // zeroes vel.y, so the slam impact reads the pre-integration value
    this.prevVelY = this.vel.y;

    // Run physics
    this.movement.update(dt);

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward: input.forward, right: input.right, jump: input.jumpHeld ? 1 : 0, ski: input.skiHeld ? 1 : 0, jet: this.input.jetPending && this.energy > 0 ? 1 : 0, status: this.status.bits() },
        { yaw: this.yaw, pitch: this.pitch }
      );
    }

    // Sync state from movement controller (local prediction)
    const moveState = this.movement.getState();
    this.pos.copy(moveState.pos);
    this.vel.copy(moveState.vel);
    this.onGround = moveState.onGround;
  }

  // Jetpack thrust is inside the shared sim (fed via jetHeld into
  // stepMovement) â€” here only the energy economy and the FX flag remain.
  // Tribes-style tank: drains while burning, recharges only when off the
  // jet; cloak/shield/mend compete for the same tank, never fill it.
  private tickEnergy(dt: number): boolean {
    const isJetting = this.input.jetPending && this.energy > 0;
    this.jetting = isJetting;
    if (isJetting) {
      this.energy -= JET_DRAIN * this.mods.jetDrain * dt;
      this.onGround = false;
    }
    if (!isJetting && !this.status.cloaked && !this.status.shielded && !this.status.mending) {
      this.energy = Math.min(this.energyCap, this.energy + JET_CHARGE * this.mods.jetRegen * this.mods.energyRegen * dt);
    }

    // Regenerator perk â€” MP regenerates in the server tick; offline we
    // tick it here so the perk works without a connection.
    if (this.mods.regen > 0 && !(this.serverOwnsHealth?.() ?? false) && !this.isDead) {
      this.health = Math.min(this.maxHealth, this.health + this.mods.regen * dt);
    }
    return isJetting;
  }

  // Spinout detector: a camera rotation jump >35Â° in a single frame is a
  // discontinuity (snap/teleport/NaN), not human input â€” even a violent
  // flick is <2Â°/frame at 60fps. Warn logs carry pose so we can repro.
  private _prevCamQuat = new THREE.Quaternion();
  private _camQuatValid = false;
  private _spinoutCd = 0;

  private checkCameraSpinout(dt: number): void {
    const q = this.camera.quaternion;
    if (this._camQuatValid && this._spinoutCd <= 0) {
      const deg = q.angleTo(this._prevCamQuat) * 180 / Math.PI;
      if (deg > 35) {
        this._spinoutCd = 0.5; // throttle â€” a stuck spinout spams otherwise
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
    return read.readMoveInput(this);
  }

  getAimDir(): THREE.Vector3 { return read.getAimDir(this); }

  // Weapon triggers: selected weapon (LMB) plus C/F belt throws.
  private fireWeapons(): void { imp.fireWeapons(this); }

  // Every impulse path must push pos/vel back into the controller —
  // it owns integration and its snapshot would overwrite our values
  // next update otherwise.
  syncMovement(): void {
    this.movement.setState({ pos: this.pos, vel: this.vel, yaw: this.yaw, pitch: this.pitch, onGround: this.onGround });
  }

  grantJetBoost(): void { imp.grantJetBoost(this); }
  heal(fraction: number): void { imp.heal(this, fraction); }
  applyKnockback(from: THREE.Vector3, force: number): void { imp.applyKnockback(this, from, force); }
  applyPull(to: THREE.Vector3, force: number): void { imp.applyPull(this, to, force); }

  getSpeed(): number {
    return Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
  }

  getCameraDir(): THREE.Vector3 {
    return this.getAimDir();
  }
}
