import * as THREE from 'three';

import { MAX_ENERGY, MAX_HEALTH, JET_DRAIN, JET_CHARGE, MELEE_COOLDOWN } from '../core/config.js';

import type { Terrain } from '../world/terrain.js';
import { PlayerSkills } from './player/skills.js';
import { buildSkillsCtx, buildInputCtx } from './playerCtor.js';
import { perkMods, PERK_ORDER, REGEN_DELAY_S, type PerkId } from '../../../shared/perks.js';
import { CLASS_STATS, CLASS_MODEL_SCALE, classCapsule, type ArmorClass } from '../../../shared/botClasses.js';
import { HeldCrown } from './heldCrown.js';
import { SPAWN_PROTECT_MS } from '../../../shared/constants.js';
import { inv } from '../../../shared/invariants.js';
import { PlayerStatus } from './playerStatus.js';

import { MovementController, type MovementState } from './movement.js';
import { type WeaponDef } from '../weapons.js';
import { settings } from '../core/settings.js';
import * as read from './playerRead.js';
import { PlayerInput } from './player/input.js';
import { PlayerModel, type PlayerModelVariant } from './PlayerModel.js';
import { CLASS_BODY_MAT_REV, CLASS_BODY_VARIANT } from './playerClips.js';
import * as imp from './playerImpulse.js';
import { PlayerEmit } from './playerEmit.js';
import { PlayerLoadout, type SidearmId } from './playerLoadout.js';
import { PACK_KINDS, type DeployKind } from '../../../shared/deployables.js';
import { BELT_MAX, BELT_REGEN_S } from '../../../shared/weapons.js';
import { heldBuffRates, POWERUP } from '../../../shared/pickups.js';
import { ENERGY, MOVEMENT_CONFIG } from '../../../shared/movement.js';
import { PlayerVisuals } from './PlayerVisuals.js';
import { urlParams } from '../core/params.js';
import { ChildLogger } from '../core/Logger.js';
import { markProbe } from '../core/fxDiag.js';

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
export const BELT_ITEMS = ['disc', 'pushdisc', 'grenade', 'cluster', 'javelin', 'sticky', 'impact', 'conc', 'remoterailgun', 'armornade', 'proxy', 'satchel', 'heal', 'hook', 'emp'] as const;

/** Per-item throw-anim stretch — the satchel plant is a deliberate
 *  two-beat reach, not a flick; multiplies THROW_RELEASE/THROW_TOTAL. */
export const BELT_THROW_TIME: Partial<Record<BeltItem, number>> = {
  satchel: 1.9,
};
export type BeltItem = typeof BELT_ITEMS[number];

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  onGround = false;
  energy = MAX_ENERGY;
  /** Sputter lock — set when the tank bottoms, refuses jets briefly. */
  jetLockT = 0;
  /** Nugget pickup: free jetting for a few seconds (refresh, not stack). */
  fireTimer = 0;
  beltTimer = 0;
  // Primary fire is locked while the belt-throw anim plays — the weapon is
  // physically lowered, shooting mid-throw would fire through the hip.
  throwLockT = 0;
  health = 100;
  private _prevHealth = 100;
  private _regenBaseT = 0;
  /** Last local hp drop — the client-side mirror of the server's
   *  lastDamageAt, gating HELD_BUFF's grace window. */
  private _heldHurtT = 0;
  /** Fractional belt-charge drip - ambient regen + predicted hoard buff. */
  private _beltAcc = 0;
  /** Progress toward the next ambient belt charge, for the HUD sliver. */
  get beltProgress(): number { return this.beltCharges >= BELT_MAX ? 0 : Math.min(1, this._beltAcc); }
  private crown: HeldCrown | null = null;
  private _crownFeet = new THREE.Vector3();
  /** Server-owned bonus pool (powerup drops) — absorbs most of a hit
   *  before health; mirrored from playerHit/buff messages, never set
   *  locally. */
  armor = 0;
  /** Timed powerup expiries (server epoch ms — same clock offset the
   *  buff message `until` arrives on; we just compare against Date.now). */
  buffUntil = { regen: 0, dd: 0, shield: 0 };
  /** Spawn shield (performance.now deadline) — prediction suppresses the
   *  enemy-blast shove/damage the server refuses during the window; the
   *  remaining time rides localPlayerState.protectedMs on join. */
  protectedUntil = 0;
  /** Passive loadout pick — mods from shared/perks.ts; announced at join.
   *  This is the PICKED intent; `appliedPerk` is what the sim reads. */
  perk: PerkId = (PERK_ORDER as string[]).includes(settings.get('fps-perk')) ? settings.get('fps-perk') as PerkId : 'jumpstart';
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
  get mods(): ReturnType<typeof perkMods> { return perkMods(this.appliedPerk); }
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
    this.deadConfirmedByWire = false;
    this.applyPendingClass(); // banked tier+gear install first — it writes perk
    this.applyPendingPerk(); // then the banked perk lands — maxHealth reads it
    this.health = this.maxHealth;
    this._prevHealth = this.health;
    this._regenBaseT = 0;
    this.armor = 0;
    this.energy = this.energyCap;
    this.jetLockT = 0;
    this.buffUntil.regen = 0;
    this.buffUntil.dd = 0;
    this.buffUntil.shield = 0;
    this.lastDamageSource = '';
    this.protectedUntil = performance.now() + SPAWN_PROTECT_MS;
    this.beltCharges = BELT_MAX;
    this.ammoPool.clear(); // absent cell = full pool - the refill IS the clear
    this.bloom = 0;
    this._heldHurtT = 0;
    this._beltAcc = 0;
    this.vel.set(0, 0, 0);
    // Re-arm the viewmodel to the active slot — a banked class swap can
    // recall a kit whose slot holds a different wid than the corpse was
    // carrying, and without this the new life opens on the old weapon's
    // model while the HUD reads the recalled one.
    this.armory.emitWeaponSwitch(this.loadout[this.weaponIndex]);
  }

  kills = 0;
  /** Hit-score points (acc·dist·air) — the classic-mode top-center score. */
  score = 0;
  isDead = false;
  /** The kill wire confirmed this death — set by ownDeath only. A
   *  client-predicted death (bot damage → killLocal) leaves it false so
   *  a later server hit can un-brick the seat instead of desyncing. */
  deadConfirmedByWire = false;
  private wasObserving = false;
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
  /** performance.now() stamp of the last real shot — offline bot senses
   *  mask the cloak for SHOOT_REVEAL_S after it, matching the server's
   *  lastFireSim rule. */
  lastFireAt = -Infinity;
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
    // Banked class swap: the pick lands in the armory's pendingGear — the
    // live skill (and its in-flight state) stays untouched until respawn.
    this.armory.setSkill(s);
    if (!this.armory.pendingGear) {this.skills.reset();}
  }

  // Power punch (E): CoD-style lunge toward the crosshair, hit itself is
  // resolved in combat.melee() as a cone + small AOE claim.
  private meleeCooldown = 0;
  tryMelee(): void {
    if (this.meleeCooldown > 0) {return;}
    this.meleeCooldown = MELEE_COOLDOWN;
    const dir = this.getAimDir();
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
  jumpAnimTimer = 0; // public — PlayerEmit re-arms it on lift-off
  shootAnimTimer = 0;
  wasOnGround = false; // public — PlayerEmit owns the transition edge
  visuals: PlayerVisuals; // camera/shadow/gizmo/observer — see PlayerVisuals.ts

  // Input state lives in PlayerInput — raw DOM events → flags, game
  // semantics reach back through the handler interface it was given.
  input!: PlayerInput; // public — PlayerStatus clears pending fire/jet
  // Skills live on Q — the loadout picks which one is equipped.
  skill: SkillId = (SKILL_ORDER as string[]).includes(settings.get('fps-skill'))
    ? settings.get('fps-skill') as SkillId : 'dash';
  skills!: PlayerSkills; // public — PlayerEmit calls postMove on it
  // Declared discontinuity: next position report goes out as a 'teleport'
  // message so the server reseats its plausibility anchor instead of
  // rejecting the jump as a speedhack (the >50m rubber-band loop).
  pendingTeleport = false;
  /** Render-only correction ease: a server snap moves `pos` instantly
   *  (the sim must converge), but the camera reads `renderPos` which
   *  eases the jump over ~100ms. Feel over accuracy — the sim state is
   *  honest, only the view hides the jolt. */
  readonly renderPos = new THREE.Vector3();
  private snapEaseDelta = new THREE.Vector3();
  noteRenderSnap(jump: THREE.Vector3): void {
    this.snapEaseDelta.sub(jump);
  }
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
  // The remembered kit for the loaded class wins over the shared key —
  // that's the whole point of the per-class memory.
  loadout: number[] = PlayerLoadout.parseLoadout(
    settings.get(PlayerLoadout.CLASS_KEY[this.armorClass]) || settings.get('fps-loadout'));

  // Belt: one throwable equipped, the belt key throws it. ESC menu picks.
  beltItem: BeltItem = (BELT_ITEMS as readonly string[]).includes(settings.get('fps-belt'))
    ? settings.get('fps-belt') as BeltItem : 'hook';
  // Sidearm: one hold-out weapon — the sidearm key pulls it while held.
  /** Dead-spectate / kill-cam boom — wider than the inspect cam so the killer reads in frame. */
  static readonly SPECTATE_DIST = 7;
  static readonly KILLCAM_HOLD_MS = 900;  // dwell on the corpse
  static readonly KILLCAM_BLEND_MS = 650; // glide corpse → killer (smoothstep)
  static readonly HEAVY_ONLY = PlayerLoadout.HEAVY_ONLY;
  static readonly MEDIUM_ONLY = PlayerLoadout.MEDIUM_ONLY;
  static readonly LIGHT_ONLY = PlayerLoadout.LIGHT_ONLY;
  static readonly lockedForClass = PlayerLoadout.lockedForClass;
  static readonly LOADOUT_SLOTS = PlayerLoadout.LOADOUT_SLOTS;
  static readonly SIDEARM = PlayerLoadout.SIDEARM;
  sidearm: SidearmId =
    (settings.get('fps-sidearm') as SidearmId) in Player.SIDEARM
      ? settings.get('fps-sidearm') as SidearmId : 'pistol';
  // Pack: one deployable on the deploy key — ESC menu picks.
  packItem: DeployKind =
    (PACK_KINDS as readonly string[]).includes(settings.get('fps-pack'))
      ? settings.get('fps-pack') as DeployKind : 'turret';


  get currentWeapon(): number { return this.armory.currentWid; }

  /** Kill-refund (railgun): ready instantly, fresh click required. */
  refundWeaponCooldown(): void { this.armory.refundWeaponCooldown(); }

  setLoadoutSlot(slot: number, weaponId: number): void { this.armory.setLoadoutSlot(slot, weaponId); }
  /** The kit the menu edits — the banked respawn kit while a class swap
   *  is pending, the live kit otherwise. Never use for fire logic. */
  get menuKit(): readonly number[] { return this.armory.menuKit(); }
  /** Gear picks the menu shows/edits — pendingGear while a swap is banked. */
  get menuGear(): { beltItem: BeltItem; sidearm: SidearmId; packItem: DeployKind; perk: PerkId; skill: SkillId } { return this.armory.menuGear(); }
  setBeltItem(item: BeltItem): void { this.armory.setBeltItem(item); }
  setSidearm(s: SidearmId): void { this.armory.setSidearm(s); }
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
  /** Free-look orbit angles for the middle-mouse inspect cam — separate from
   *  yaw/pitch so orbiting never moves the aim. Seeded from yaw/pitch each
   *  time the orbit engages so the cam starts where you were looking. */
  readonly orbit = { yaw: 0, pitch: 0 };

  /** Dead-spectate target index into spectateTargets() — -1 = ghost
   *  free-fly. Right-click while dead enters orbit then advances; a
   *  target that dies or leaves drops the cam back to free-fly until
   *  the next click. Reset when a new life starts. */
  deadSpectateIdx = -1;
  /** Live teammate anchors for dead-spectate, resolved by main.ts — the
   *  player layer must not know remote rosters/network state. `pos` is
   *  the networked EYE position — the orbit boom pivots on center mass. */
  spectateTargets?: () => { pos: THREE.Vector3; alive: boolean }[];
  private readonly deadSpectateAnchor = new THREE.Vector3();
  /** Kill-cam: anchored on the killer's replica for the first few seconds
   *  of being dead — the "who got me" closure. Seeded by the kill wire,
   *  cancelled by any spectate press or the timeout, then the normal
   *  teammate cycle / ghost observer takes over. Never a permanent
   *  anchor — a dead player parked on an enemy is a ghosting channel. */
  spectateAnchor: { pos: THREE.Vector3; isDead: boolean } | undefined;
  spectateAnchorUntil = 0;
  /** Kill-cam entry pose — the boom pivots on the corpse spot for a beat,
   *  then blends to the killer so the death isn't a camera teleport. */
  readonly spectateAnchorFrom = new THREE.Vector3();
  spectateAnchorStart = 0;
  private anchorOrbitSeeded = false;

  /** L while dead — arms after the suicide press so the FIRST dead frame
   *  opens on a teammate's orbit instead of free-fly. Cleared once it
   *  engages or a new life starts. */
  private spectateOnDeath = false;
  private respawnArmedAt = 0;
  /** Server is holding our corpse (L's die+spectate) — the auto-respawn
   *  timer lapses without reviving; a plain dead-state press releases it.
   *  Clears the moment we're alive again. HUD reads this for the death
   *  overlay text. */
  respawnHeld = false;

  /** Die + spectate in one press: alive = the hold-flagged respawn claim
   *  (server kills us and parks the corpse — no auto-revive), and the
   *  orbit arms so the corpse cam opens on a teammate; dead = same as
   *  right-click, advance the orbit. */
  dieSpectate(): void {
    if (this.isDead) { this.deadSpectateCycle(); return; }
    this.spectateOnDeath = true;
    this.respawnHeld = true;
    this.respawnArmedAt = performance.now();
    this.onRespawn?.(true);
  }

  /** Click while dead: orbit the next living teammate (dir=1) or the
   *  previous one (dir=-1). The ring includes the ghost slot — cycling
   *  off either end drops back to free-fly, where LMB is respawn again. */
  deadSpectateCycle(dir: 1 | -1 = 1): void {
    // A press during the corpse→killer blend is dropped, not queued: the
    // switch only becomes legal once the lerp settles on the killer.
    if (this.killcamBlendActive()) {return;}
    this.spectateAnchor = undefined; // a press is a manual override — kill-cam releases
    const ts = this.spectateTargets?.() ?? [];
    const aliveIdx = ts.map((t, i): number => (t.alive ? i : -1)).filter((i): boolean => i >= 0);
    if (aliveIdx.length === 0) { this.deadSpectateIdx = -1; return; }
    const pos = aliveIdx.indexOf(this.deadSpectateIdx); // -1 = ghost free-fly
    const posNext = pos === -1 ? (dir > 0 ? 0 : aliveIdx.length - 1) : pos + dir;
    const next = posNext < 0 || posNext >= aliveIdx.length ? -1 : (aliveIdx[posNext] ?? -1);
    if (this.deadSpectateIdx < 0 && next >= 0) { this.orbit.yaw = this.yaw; this.orbit.pitch = 0.25; }
    this.deadSpectateIdx = next;
  }
  /** Kill-cam still in its dwell→glide leg — the anchor lerp hasn't
   *  reached the killer yet. Matches the camera block's anchor test so a
   *  press lands exactly when the track phase starts. */
  private killcamBlendActive(): boolean {
    const anchor = this.spectateAnchor;
    return this.isDead && Boolean(anchor) && !anchor!.isDead
      && performance.now() < this.spectateAnchorUntil
      && performance.now() - this.spectateAnchorStart < Player.KILLCAM_HOLD_MS + Player.KILLCAM_BLEND_MS;
  }
  private wasMidHeld = false;
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
  /** T1 collision damage — fires only when the server doesn't own
   *  health (offline); MP's shadow pays it server-side and the wire
   *  carries the bar, so predicting it here would double-charge. */
  onFallDamage: ((impact: number, vImp: number) => void) | null = null;
  /** Kill zone — world Y below which the body is out of the arena. The
   *  server measures this on its shadow and kills authoritatively; the
   *  local prediction just makes the death land on the same frame. */
  killY: number | null = null;
  /** Fired when the predicted body drops below the map's kill zone. */
  onKillZone: (() => void) | null = null;
  onBelt: ((e: FireEvent, item: BeltItem) => void) | null = null;
  /** Instant-skill ante mirror → NetworkManager.sendSkillUse. */
  onSkillUse: (() => void) | null = null;
  /** Belt/pack charge mirror — BELT_MAX on respawn, server owns the truth.
   *  Belt throw −1, pack deploy −2, nugget +1 (shared/weapons.ts). */
  beltCharges = BELT_MAX;
  /** Per-weapon pool rounds (ammoCap rows - PlasmaGun pilot): lazy
   *  accrual on the perf clock; the server owns the same pool through
   *  its own gate, prediction just previews/spends the same formula. */
  ammoPool = new Map<number, { ammo: number; t: number; shotAt: number }>();
  /** Bloom cone radius for def.bloom weapons (chaingun): grows per shot,
   *  decays in tickTimers. Dir-offset units - 0 = pixel tight. */
  bloom = 0;
  /** Residual cone drain rate - stamped by the weapon that grew the
   *  bloom, so a weapon swap keeps decaying it (the server's lazy decay
   *  covers the whole gap at the generating weapon's rate; gating decay
   *  on the CURRENT weapon's def froze the cone across swaps). */
  bloomDecay = 0;
  /** Predicted cone draw counter - mirrors the server's bloomSeq so the
   *  jitter seed (idSeed(id) ^ seq) matches the authoritative draw. */
  bloomSeq = 0;
  /** Swap draw lock - set on every weapon change (emitWeaponSwitch):
   *  firing waits out the viewmodel's lower+raise cycle so a swap can't
   *  chain heavy guns at instant cadence. Mirrors the server's intent
   *  gate only as prediction feel; authority cadence is separate. */
  weaponDrawT = 0;
  /** Headhunt held tokens — server-owned count, HUD reads it raw. */
  heldTokens = 0;
  /** True when the held-token drip is live (≥3 tokens, 8s since last hit). */
  get heldBuffActive(): boolean {
    const hb = heldBuffRates(this.heldTokens, performance.now() - this._heldHurtT);
    return hb.hp > 0 || hb.armor > 0 || hb.belt > 0;
  }
  onMelee: ((e: FireEvent) => void) | null = null;

  onWeaponSwitch: ((index: number) => void) | null = null;
  /** Pack items — main wires these to the deployables manager. */
  onDeploy: (() => void) | null = null;
  /** Deliberate respawn key → the server's self-kill claim (or the
   *  offline kill path when there's no wire). */
  onRespawn: ((hold?: boolean) => void) | null = null;
  onThrowFlag: (() => void) | null = null;
  /** First dead frame — main wires the own-corpse gib burst here. Fires
   *  on every death (wire, suicide, offline) via the observing edge. */
  onLocalDeath: (() => void) | null = null;
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
    this.movement.setBody(CLASS_STATS[this.appliedClass].mass, CLASS_STATS[this.appliedClass].eyeHeight, CLASS_STATS[this.appliedClass].radius);
    this.movement.setJumpstart(this.mods.jumpstart);
    this.armory.unshoulderLocked();

    // Your third-person body wears the same class GLB remotes see on
    // you — what you see looking down IS the hitbox class you claim.
    this.model = new PlayerModel(scene, (CLASS_BODY_VARIANT[this.appliedClass] ?? 'vexa') as PlayerModelVariant,
      CLASS_BODY_MAT_REV.has(this.appliedClass));
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
      // Aim-probe tag — if the FP body ever renders on the crosshair the
      // dump names it instead of an anonymous brute mesh.
      if (this.model.object3D) {markProbe(this.model.object3D, { kind: 'fxMesh', label: 'body:local' });}
      // Hide model for first-person view
      this.model.setVisible(false);
      // A cloak running before the GLB arrived never got its ghost —
      // capture it now or the TP body renders opaque while invisible.
      if (this.status.cloaked) {this.model.setGhost(true);}
      // Collider gizmo stays armed — the update loop refreshes it so the
      // menu DEBUG toggle shows/hides it like every other remote.
      this.model.setColliderVisible(true);
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
    // Corpse holds no channels — server reset status=0, so a stale client
    // bit becomes a phantom rising edge on the next inputMove (fresh cost,
    // ghost aura). Cloak already cleared; shield/mend share the same law.
    if (this.isDead) {this.status.setCloaked(false); this.status.setShielded(false); this.status.setMending(false);}
    if (this.status.spectating && this.isDead) {
      this.status.spectating = false;
      this.onSpectate?.(false);
    }
    // L's armed orbit fires on the first dead frame — the claim round-
    // tripped, death owns the cam, now point it at a teammate.
    if (this.spectateOnDeath && this.isDead && !this.killcamBlendActive()) {
      this.spectateOnDeath = false;
      this.deadSpectateCycle();
    }
    if (!this.isDead) {
      this.respawnHeld = false; // alive again — any hold has served its purpose
      if (this.spectateOnDeath && this.respawnArmedAt && performance.now() - this.respawnArmedAt > 10_000) {
        // Suicide claim never landed (dropped/offline) — don't let a stale
        // arm turn an unrelated future death into an orbit.
        this.spectateOnDeath = false;
      }
    }
    const observing = this.isDead || this.status.spectating;
    if (observing && !this.wasObserving) {
      // Keys held at the moment of death would read as held forever —
      // the ghost drifts until the player happens to re-press them.
      // Clearing on entry means the cam only moves on a fresh press.
      this.input.clearAll();
      // Full-gib on the death edge: the body hides as its baked chunk
      // geos fly — main spawns the burst via onLocalDeath.
      if (this.isDead) { this.model?.setVisible(false); this.onLocalDeath?.(); }
    }
    this.wasObserving = observing;
    if (observing) {
      if (!this.isDead) { this.deadSpectateIdx = -1; }
      const anchor = this.spectateAnchor;
      if (anchor && performance.now() < this.spectateAnchorUntil && !anchor.isDead) {
        if (!this.anchorOrbitSeeded) {
          this.orbit.yaw = this.yaw; this.orbit.pitch = 0.25;
          this.anchorOrbitSeeded = true;
        }
        // Hold on the corpse, then glide to the killer (Battlefield/CoD
        // killcam pacing: dwell → blend → track) — a hard teleport reads
        // as a glitch, not a "who got me" reveal.
        const elapsed = performance.now() - this.spectateAnchorStart;
        if (elapsed < Player.KILLCAM_HOLD_MS) {
          this.deadSpectateAnchor.copy(this.spectateAnchorFrom);
        } else {
          const t = Math.min(1, (elapsed - Player.KILLCAM_HOLD_MS) / Player.KILLCAM_BLEND_MS);
          // smootherstep — zero velocity AND curvature at the ends, so the
          // sweep leaves the corpse and settles on the killer without the
          // smoothstep's mid-end snap.
          const s = t * t * t * (t * (t * 6 - 15) + 10);
          this.deadSpectateAnchor.lerpVectors(this.spectateAnchorFrom, anchor.pos, s);
        }
        this.visuals.updateCamera(this.camera, this.terrain, {
          pos: this.deadSpectateAnchor, yaw: 0, pitch: 0,
          thirdPerson: true,
          orbit: this.orbit, dist: Player.SPECTATE_DIST,
        });
        return;
      }
      this.spectateAnchor = undefined;
      this.anchorOrbitSeeded = false;
      const spectateTarget = this.deadSpectateIdx >= 0
        ? this.spectateTargets?.()[this.deadSpectateIdx]
        : undefined;
      if (spectateTarget?.alive) {
        // Dead-spectate: same boom as the middle-mouse inspect cam,
        // anchored at the networked EYE pos — pivoting on the target's
        // center mass, not their boots.
        this.deadSpectateAnchor.copy(spectateTarget.pos);
        this.visuals.updateCamera(this.camera, this.terrain, {
          pos: this.deadSpectateAnchor, yaw: 0, pitch: 0,
          thirdPerson: true,
          orbit: this.orbit, dist: Player.SPECTATE_DIST,
        });
        return;
      }
      const obInput = this.readMoveInput();
      // T1/T2 observer mode: free-look + fly till respawn
      this.visuals.updateObserverCam(dt, this.camera, this.terrain, this.pos, this.vel, this.yaw, this.pitch, {
        forward: obInput.forward, right: obInput.right, jumpHeld: obInput.jumpHeld || this.input.jetPending,
        shiftDown: obInput.skiHeld || Boolean(this.input.keys['ShiftLeft'] || this.input.keys['ShiftRight']),
      });
      return;
    }
    this.deadSpectateIdx = -1; // alive again — a fresh death re-opens the cycle
    this.spectateAnchor = undefined;
    this.anchorOrbitSeeded = false;
    if (this.input.frozen) {
      // still update camera for demo playback
      this.visuals.updateFrozenCamera(this.camera, this.terrain, this.pos, this.yaw, this.pitch);
      return;
    }

    this.tickTimers(dt);

    if (this.skills.updateBlink(dt)) {return;}

    const input = this.readMoveInput();
    this.stepMovement(dt, input);
    const isJetting = this.tickEnergy(dt);

    // Snap ease: the offset decays exponentially (~100ms to sub-mm); the
    // camera + own body read renderPos, the sim/reports read pos.
    this.snapEaseDelta.multiplyScalar(Math.exp(-dt / 0.045));
    if (this.snapEaseDelta.lengthSq() < 1e-4) { this.snapEaseDelta.set(0, 0, 0); }
    this.renderPos.copy(this.pos).add(this.snapEaseDelta);

    // ---- All visual/event spawns below use the final post-physics position ----

    const orbiting = this.input.midHeld;
    const orbitTransition = orbiting || this.wasMidHeld; // release frame snaps the cam back too
    if (orbiting && !this.wasMidHeld) { this.orbit.yaw = this.yaw; this.orbit.pitch = this.pitch; }
    this.wasMidHeld = orbiting;
    this.visuals.updateCamera(this.camera, this.terrain, {
      pos: this.renderPos, yaw: this.yaw, pitch: this.pitch,
      thirdPerson: this.thirdPerson,
      orbit: orbiting ? this.orbit : undefined,
    });
    this.checkCameraSpinout(dt, orbitTransition);
    // Model visibility follows the toggle AND death (observer cam is ghost
    // flight — your corpse shouldn't fly with you). Debug renders the body
    // wireframe (+collider) — third person / orbit cam only; a capsule
    // around your own camera in first person is noise, not information.
    const dbg = Boolean(urlParams.debug);
    this.model?.setVisible((this.thirdPerson || orbiting) && !this.isDead);
    // Your own hoard crown — you can only see it in third person/orbit,
    // but so can anyone nearby; same scene-rooted follow as remotes.
    if (this.heldTokens > 0 && !this.isDead && (this.thirdPerson || orbiting)) {
      if (!this.crown) { this.crown = new HeldCrown(this.scene); this.crown.setBeams(false); } // own hoard: coins yes, screen-eating shafts no
      this.crown.set(this.heldTokens);
      this._crownFeet.copy(this.renderPos);
      this._crownFeet.y -= CLASS_STATS[this.appliedClass].eyeHeight; // renderPos is eye-space
      this.crown.follow(this._crownFeet, classCapsule(this.appliedClass).height);
      this.crown.update(dt);
    } else if (this.crown) {this.crown.set(0);}
    this.model?.setWireframe(dbg);
    this.model?.setColliderVisible(true);
    this.visuals.updateFeetMarker(this.terrain, this.renderPos,
      this.renderPos.y - CLASS_STATS[this.appliedClass].eyeHeight, this.getSpeed(), this.skiing);
    this.fireWeapons();
    this.emitFx.moveEvents(isJetting, input.skiHeld, input.jumpHeld, dt);
    this.visuals.updateShadowBlob(this.terrain, this.renderPos);
    this.jumpAnimTimer = this.visuals.updateModelAnim(this.model, this.renderPos, this.yaw, this.pitch, this.jumpAnimTimer, this.getSpeed(), dt, this.onGround, isJetting, this.vel, input.skiHeld, this.shootAnimTimer, this.thirdPerson, CLASS_STATS[this.appliedClass].eyeHeight, this.throwLockT);
  }

  private tickTimers(dt: number): void {
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.shootAnimTimer = Math.max(0, this.shootAnimTimer - dt);
    this.beltTimer = Math.max(0, this.beltTimer - dt);
    this.throwLockT = Math.max(0, this.throwLockT - dt);
    this.armory.secondaryDrawT = Math.max(0, this.armory.secondaryDrawT - dt);
    this.weaponDrawT = Math.max(0, this.weaponDrawT - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    // Bloom decays only while the trigger's UP (per-shot decay would
    // swallow the +rate add at any firing cadence). The rate rides the
    // weapon that GREW it, not the shouldered def - gating on the
    // current weapon's def froze the residue across a swap, so the
    // crosshair cone came back frozen at the old width (and the server
    // had already drained it over the gap anyway).
    if (!this.input.mouseHeld) {this.bloom = Math.max(0, this.bloom - this.bloomDecay * dt);}
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
      jetHeld: this.input.jetPending && this.energy > 0 && this.jetLockT <= 0,
    });

    // Fall speed entering this frame â€” grounding inside movement.update
    // zeroes vel.y, so the slam impact reads the pre-integration value
    this.prevVelY = this.vel.y;

    // Run physics
    this.movement.update(dt);

    // T1 fall damage — the sim measured the contact's -v·n this frame.
    // Fires in MP too: the impact dressing is instant prediction feel,
    // and the featherfall soak must mirror the shadow's drain or the two
    // tank models diverge — only the health write stays wire-owned.
    const landing = this.movement.landingImpact * this.movement.fallBoost;
    if (landing > MOVEMENT_CONFIG.fallDamageMinSpeed) {
      this.onFallDamage?.(landing, Math.max(0, -this.prevVelY));
    }

    // Send input to network for client-side prediction
    if (this.onNetworkInput) {
      this.onNetworkInput(
        { forward: input.forward, right: input.right, jump: input.jumpHeld ? 1 : 0, ski: input.skiHeld ? 1 : 0, jet: this.input.jetPending && this.energy > 0 && this.jetLockT <= 0 ? 1 : 0, status: this.status.bits() },
        { yaw: this.yaw, pitch: this.pitch }
      );
    }

    // Sync state from movement controller (local prediction)
    const moveState = this.movement.getState();
    this.pos.copy(moveState.pos);
    this.vel.copy(moveState.vel);
    this.onGround = moveState.onGround;

    // Kill zone — the deck ran out. Predicted locally so the death lands
    // on the frame the body crossed it; the server's shadow measures the
    // same fall and owns the actual kill.
    if (this.killY !== null && this.pos.y < this.killY) {this.onKillZone?.();}
  }

  // Jetpack thrust is inside the shared sim (fed via jetHeld into
  // stepMovement) â€” here only the energy economy and the FX flag remain.
  // Tribes-style tank: drains while burning, recharges only when off the
  // jet; cloak/shield/mend compete for the same tank, never fill it.
  private tickEnergy(dt: number): boolean {
    if (this.jetLockT > 0) {this.jetLockT -= dt;}
    const isJetting = this.input.jetPending && this.energy > 0 && this.jetLockT <= 0;
    this.jetting = isJetting;
    if (isJetting) {
      this.energy -= JET_DRAIN * this.mods.jetDrain * dt;
      this.onGround = false;
    }
    if (!isJetting && !this.status.cloaked && !this.status.shielded && !this.status.mending) {
      this.energy = Math.min(this.energyCap, this.energy + JET_CHARGE * this.mods.jetRegen * this.mods.energyRegen * dt);
    }

    // NaN is sticky through Math.max/min — a poisoned tank rides forever.
    // Drain to empty once and let regen rebuild, same rule as the server.
    if (!Number.isFinite(this.energy)) {this.energy = 0;}
    // Pool law mirrors the server: floor at empty (a skill drain can
    // overshoot between frames), over-cap means a write skipped its clamp.
    this.energy = Math.max(0, this.energy);
    inv('local-energy-bounds', this.energy <= this.energyCap + 0.01,
      { e: Number(this.energy.toFixed(1)), cap: Number(this.energyCap.toFixed(1)) });
    if (this.energy <= 0) {this.jetLockT = ENERGY.jetLockout;}

    // Regenerator perk â€” MP regenerates in the server tick; offline we
    // tick it here so the perk works without a connection. Ramp mirrors
    // the server rule: unhurt seconds past REGEN_DELAY_S Ã— regenRamp,
    // reset by any hp drop.
    if ((this.mods.regen > 0 || this.mods.regenRamp > 0) && !(this.serverOwnsHealth?.() ?? false) && !this.isDead) {
      const now = performance.now();
      if (this.health < this._prevHealth) {this._regenBaseT = now;}
      if (!this._regenBaseT) {this._regenBaseT = now;}
      const rate = this.mods.regen + this.mods.regenRamp * Math.max(0, (now - this._regenBaseT) / 1000 - REGEN_DELAY_S);
      this.health = Math.min(this.maxHealth, this.health + rate * dt);
    }
    // Headhunt hoard-drip — HELD_BUFF rates from heldTokens, muted 8s
    // after any hit (hp drops stamp _heldHurtT; a same-frame heal can't
    // hide damage because the drop is measured on _prevHealth). Offline
    // is the authority for all three channels; online only the belt is
    // predicted — hp/armor arrive on the yourHealth echo, which the
    // server emits while any channel is live.
    if (this.health < this._prevHealth) {this._heldHurtT = performance.now();}
    const hb = heldBuffRates(this.heldTokens, performance.now() - this._heldHurtT);
    if (hb.belt + hb.hp + hb.armor > 0 && !this.isDead) {
      if (!(this.serverOwnsHealth?.() ?? false)) {
        this.health = Math.min(this.maxHealth, this.health + hb.hp * dt);
        this.armor = Math.min(POWERUP.maxArmor, this.armor + hb.armor * dt);
      }
    }
    // Belt income is predicted for every channel - the ambient drip
    // (BELT_REGEN_S/piece) plus the hoard rate, same math the server
    // runs in tickRecords. A rejected throw is the correction.
    if (!this.isDead && this.beltCharges < BELT_MAX) {
      this._beltAcc += (hb.belt + 1 / BELT_REGEN_S) * dt;
      if (this._beltAcc >= 1) {this.beltCharges += 1; this._beltAcc -= 1;}
    }
    // Every ingest gate protects the wire paths — this is the local
    // write-side catch: a NaN pool can't heal through Math.min and
    // rides forever. Name it, snap to full.
    if (!inv('local-health-finite', Number.isFinite(this.health), { hp: this.health })) {this.health = this.maxHealth;}
    this._prevHealth = this.health;
    return isJetting;
  }

  // Spinout detector: a camera rotation jump >35Â° in a single frame is a
  // discontinuity (snap/teleport/NaN), not human input â€” even a violent
  // flick is <2Â°/frame at 60fps. Warn logs carry pose so we can repro.
  private _prevCamQuat = new THREE.Quaternion();
  private _camQuatValid = false;
  private _spinoutCd = 0;

  private checkCameraSpinout(dt: number, intentionalOrbit = false): void {
    const q = this.camera.quaternion;
    // angleTo(NaN) is NaN — never >35 — so a poisoned quaternion spins
    // out silently forever. Recover the pose from yaw/pitch once.
    if (!Number.isFinite(q.x + q.y + q.z + q.w)) {
      logger.warn('Camera quaternion NaN — rebuilt from yaw/pitch', { yaw: this.yaw, pitch: this.pitch });
      // Rebuild from finite-ized yaw/pitch — a resync/poisoned state can
      // leave either NaN, and rebuilding with NaN would re-poison the quat
      // every frame forever.
      const y = Number.isFinite(this.yaw) ? this.yaw : 0;
      const p = Number.isFinite(this.pitch) ? this.pitch : 0;
      this.camera.rotation.set(p, y, 0, 'YXZ');
      this._camQuatValid = false;
      return;
    }
    if (this._camQuatValid && this._spinoutCd <= 0 && !intentionalOrbit) {
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
    // setState rejects the WHOLE push on any non-finite field — a wire or
    // resync path that NaN'd yaw/pitch would veto pos/vel forever (silent
    // rubber-band to the last accepted state). Sanitize the pair instead;
    // the camera watchdog already warns on the poisoned pose.
    this.movement.setState({
      pos: this.pos, vel: this.vel,
      yaw: Number.isFinite(this.yaw) ? this.yaw : 0,
      pitch: Number.isFinite(this.pitch) ? this.pitch : 0,
      onGround: this.onGround,
    });
  }

  grantJetBoost(): void { imp.grantJetBoost(this); }
  heal(fraction: number): void { imp.heal(this, fraction); }
  applyKnockback(from: THREE.Vector3, force: number): void { imp.applyKnockback(this, from, force); }
  applyPull(to: THREE.Vector3, force: number, yank = false): void { imp.applyPull(this, to, force, yank); }

  getSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  getCameraDir(): THREE.Vector3 {
    return this.getAimDir();
  }
}
