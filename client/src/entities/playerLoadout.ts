import { settings } from '../core/settings.js';
import { SLOT_COUNT, weaponDef, widOf, LANCE_WID } from '../weapons.js';
import { WeaponType, getWeaponStats } from '../../../shared/weapons.js';
import { gunGameWeapon, igunChassis } from '../../../shared/gunGame.js';
import { SIDEARM_DRAW_TIME } from './ViewModel.js';
import type { MovementController } from './movement.js';
import type { PlayerInput } from './player/input.js';
import type { PerkId, PerkMods } from '../../../shared/perks.js';
import { CLASS_STATS, CLASS_MODEL_SCALE, HEAVY_ONLY_WEAPONS, MEDIUM_ONLY_WEAPONS, LIGHT_ONLY_WEAPONS, type ArmorClass } from '../../../shared/botClasses.js';
import { PlayerModel, type PlayerModelVariant } from './PlayerModel.js';
import { CLASS_BODY_MAT_REV, CLASS_BODY_VARIANT } from './playerClips.js';
import type * as THREE from 'three';
import type { BeltItem, SkillId } from './Player.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('PlayerLoadout');

/**
 * PlayerLoadout — the armory: class-tier banking, perk banking, weapon
 * slots, belt/sidearm/pack picks, and the hold-out secondary swap.
 * Persists every pick to settings; the host keeps the flat fields the
 * rest of the app reads (loadout, weaponIndex, appliedClass, ...).
 */

export interface LoadoutHost {
  perk: PerkId;
  appliedPerk: PerkId;
  /** perkMods(appliedPerk) — the sim-read modifiers, banked per life. */
  readonly mods: PerkMods;
  armorClass: ArmorClass;
  appliedClass: ArmorClass;
  loadout: number[];
  weaponIndex: number;
  beltItem: BeltItem;
  sidearm: SidearmId;
  packItem: DeployKind;
  skill: SkillId;
  fireTimer: number;
  weaponDrawT: number;
  model: PlayerModel | null;
  scene: THREE.Scene;
  movement: MovementController;
  input: PlayerInput;
  onWeaponSwitch: ((index: number) => void) | null;
}

export class PlayerLoadout {
  /** Tier-restricted ordnance — SLOT_DEFS wids derived from the `tier`
   *  markers on the shared stat rows (botClasses tier sets → widOf).
   *  Never a literal list: hardcoded wids go stale on the next append. */
  static readonly HEAVY_ONLY: readonly number[] = [...HEAVY_ONLY_WEAPONS].map(widOf).filter((w): boolean => w >= 0);
  /** Medium-only guns — lights trade them for speed, heavies for ordnance. */
  static readonly MEDIUM_ONLY: readonly number[] = [...MEDIUM_ONLY_WEAPONS].map(widOf).filter((w): boolean => w >= 0);
  /** Light-frame precision gear — heavier chassis can't shoulder them. */
  static readonly LIGHT_ONLY: readonly number[] = [...LIGHT_ONLY_WEAPONS].map(widOf).filter((w): boolean => w >= 0);
  static readonly LOADOUT_SLOTS = 4;
  /** Per-class kit memory — the four weapon slots are remembered per
   *  tier, so heavy's ordnance rig survives a stint on light. */
  static readonly CLASS_KEY = {
    light: 'fps-loadout-light', medium: 'fps-loadout-medium', heavy: 'fps-loadout-heavy',
  } as const;
  /** Gear picks ride the same per-tier memory as the weapon kit — belt,
   *  sidearm, pack, perk, skill all swap with the chassis. */
  static readonly GEAR_KEY = {
    light: 'fps-gear-light', medium: 'fps-gear-medium', heavy: 'fps-gear-heavy',
  } as const;

  /** The gear half of a kit — banked in pendingGear while a class swap
   *  is pending, live fields otherwise. Same picked-vs-applied split as
   *  the weapon kit: the belt/sidearm/pack/perk/skill you're BUILDING for
   *  the tier must not leak into the life you're still living. */
  private gearPick(): { beltItem: BeltItem; sidearm: SidearmId; packItem: DeployKind; perk: PerkId; skill: SkillId } {
    return this.pendingGear ?? this.h;
  }

  /** The picks the menu displays/edits — pending while a swap is banked. */
  menuGear(): { beltItem: BeltItem; sidearm: SidearmId; packItem: DeployKind; perk: PerkId; skill: SkillId } {
    return this.gearPick();
  }

  /** Banked gear — non-null while armorClass ≠ appliedClass. Installed by
   *  applyPendingClass alongside the weapon kit. */
  pendingGear: { beltItem: BeltItem; sidearm: SidearmId; packItem: DeployKind; perk: PerkId; skill: SkillId } | null = null;

  /** Pre-instagib kit snapshot - non-null while the room modifier owns
   *  the chassis. Live fields only: nothing here touches settings, so a
   *  normal-mode kit survives the instagib room untouched. */
  private instaPrev: { loadout: number[]; beltItem: BeltItem; armorClass: ArmorClass; skill: SkillId; perk: PerkId } | null = null;

  /** True while an instagib room's gameState holds the kit lock - the
   *  loadout menu reads this to hide locked cells (skill/perk stay live). */
  get instagib(): boolean { return this.instaPrev !== null; }

  /** Pre-gungame weapon kit - non-null while the ladder owns the loadout.
   *  Only the weapon band + belt snapshot: class/skill/perk stay live
   *  picks in a gun-game room (the modifier doesn't touch them). */
  private ggPrev: { loadout: number[]; beltItem: BeltItem; igun: boolean; armorClass: ArmorClass | null; weaponIndex: number } | null = null;

  /** Roll that arrived before the lock - stashed for applyGunGame. */
  private pendingGunRoll: { rung: number; wt?: number } | null = null;

  /** True while a gun-game room's gameState holds the weapon lock. */
  get gunGame(): boolean { return this.ggPrev !== null; }

  /** igun variant - the chassis follows the rung weapon's own tier
   *  (untiered = medium), swapping live on every rung edge. Class picks
   *  are dead either way. */
  get igun(): boolean { return this.ggPrev?.igun === true; }

  /** Any room modifier owning the kit - HUD/menu hide dead controls on
   *  either lock (instagib's chassis lock or the ladder's weapon lock). */
  get kitLocked(): boolean { return this.instagib || this.gunGame; }

  /** Gun-game kit lock: the rung's bucket members fill slots 1..N (the
   *  slot keys ARE the pick - any member fires), belt is the hook (the
   *  only belt item the ladder gate lets fire). The rung itself arrives
   *  on 'gunRung' edges - this only holds the shape. */
  applyGunGame(igun = false): void {
    if (this.ggPrev) {return;}
    this.ggPrev = { loadout: this.h.loadout, beltItem: this.h.beltItem, igun, armorClass: igun ? this.h.armorClass : null, weaponIndex: this.h.weaponIndex };
    this.pendingLoadout = null;
    this.pendingGear = null;
    // A gunRung edge can beat the gameState that applies this lock - the
    // stashed roll lands here instead of being eaten by the early-return.
    const roll = this.pendingGunRoll;
    this.pendingGunRoll = null;
    this.fillGunSlots(roll?.rung ?? 0, roll?.wt);
    this.h.beltItem = 'hook';
    if (igun) {this.h.armorClass = igunChassis(weaponDef(this.currentWid).weaponType);}
    this.applyPendingClass();
    this.emitWeaponSwitch(this.currentWid);
  }

  /** Bucket roll mirror: the dealt member fills every slot - the roll is
   *  luck, not a pick, so slot keys are dead input and mirroring is just
   *  bookkeeping. The server's roll rides 'gunRung.wt'; absent it the
   *  canonical member stands in. */
  private fillGunSlots(rung: number, wt?: number): void {
    const wid = widOf(wt ?? gunGameWeapon(rung, this.ggPrev?.igun === true));
    this.h.loadout = [wid, wid, wid, wid];
    this.h.weaponIndex = 0;
    this.pendingLoadout = null;
  }

  /** igun chassis from the held slot - a bucket pick or a rung edge can
   *  change the tier, so the body follows whatever's shouldered. */
  private igunSlotChassis(): void {
    if (!this.ggPrev?.igun) {return;}
    this.h.armorClass = igunChassis(weaponDef(this.currentWid).weaponType);
    this.applyPendingClass();
  }

  /** Ladder edge: the rung deals one member (wt rides the wire, absent =
   *  canonical) - the band mirrors it, slot keys stay dead. igun swaps
   *  the chassis to the dealt weapon's tier, live. */
  setGunGameRung(rung: number, wt?: number): void {
    if (!this.ggPrev) {this.pendingGunRoll = { rung, wt }; return;}
    this.fillGunSlots(rung, wt);
    this.igunSlotChassis();
    // Fresh gun, fresh cadence - the old weapon's cooldown (a Missile
    // Launcher's 2s beat) must not lock the dealt gun.
    this.refundWeaponCooldown();
    this.emitWeaponSwitch(this.currentWid);
  }

  /** Leaving a gun-game room: hand the pre-lock weapon band + belt back. */
  releaseGunGame(): void {
    const prev = this.ggPrev;
    if (!prev) {return;}
    this.ggPrev = null;
    this.h.loadout = prev.loadout;
    this.h.beltItem = prev.beltItem;
    this.h.weaponIndex = prev.weaponIndex;
    if (prev.igun && prev.armorClass) {this.h.armorClass = prev.armorClass;}
    // A class swap banked mid-match edited the LADDER kit - it can't
    // install over the restored normal kit at the next respawn.
    this.pendingLoadout = null;
    this.applyPendingClass();
    this.emitWeaponSwitch(this.h.loadout[this.h.weaponIndex] ?? 0);
  }

  /** Room-modifier kit lock: every slot railgun, belt hook, light chassis.
   *  Idempotent per room entry; the server re-derives the same truth, this
   *  only keeps prediction/UI from diverging. Perk and skill picks are
   *  untouched - the modifier leaves both selectable. */
  applyInstagib(): void {
    if (this.instaPrev) {return;}
    const rail = widOf(WeaponType.Railgun);
    this.instaPrev = { loadout: this.h.loadout, beltItem: this.h.beltItem, armorClass: this.h.armorClass, skill: this.h.skill, perk: this.h.perk };
    // Server seat() defaults an undeclared skill to blink and floors perk
    // at jumpstart - mirror both locally so prediction names the same
    // picks the authority shadows. settings untouched: these were never
    // explicit picks, normal mode keeps its own defaults.
    if (!settings.has('fps-skill')) {this.h.skill = 'blink';}
    if (this.h.perk === 'none') {this.h.perk = 'jumpstart';}
    // A banked normal-mode swap must not install over the forced kit at
    // the next respawn - the modifier owns this life's whole loadout.
    this.pendingLoadout = null;
    this.pendingGear = null;
    this.h.loadout = [rail, rail, rail, rail];
    this.h.beltItem = 'hook';
    this.h.armorClass = 'light';
    this.applyPendingClass();
    this.emitWeaponSwitch(this.h.loadout[this.h.weaponIndex] ?? rail);
  }

  /** Leaving an instagib room (or its gameState echo flipping off):
   *  hand the pre-lock kit back through the normal respawn path. */
  releaseInstagib(): void {
    const prev = this.instaPrev;
    if (!prev) {return;}
    this.instaPrev = null;
    this.h.loadout = prev.loadout;
    this.h.beltItem = prev.beltItem;
    this.h.armorClass = prev.armorClass;
    // Same explicit-pick test as apply: a skill chosen inside instagib
    // (has() flipped) is the player's own pick and survives the release.
    if (!settings.has('fps-skill')) {this.h.skill = prev.skill;}
    // Undo only the 'none' floor we applied - a perk re-picked inside
    // instagib (perkUpdate reached the server) must survive the release.
    if (prev.perk === 'none' && this.h.perk === 'jumpstart') {this.h.perk = 'none';}
    this.applyPendingClass();
    this.emitWeaponSwitch(this.h.loadout[this.h.weaponIndex] ?? 0);
  }

  private gearBundle(): string {
    const g = this.gearPick();
    return [g.beltItem, g.sidearm, g.packItem, g.perk, g.skill].join(',');
  }

  private saveGear(): void {
    settings.set(PlayerLoadout.GEAR_KEY[this.h.armorClass], this.gearBundle());
  }

  private parseGear(c: ArmorClass): { beltItem: BeltItem; sidearm: SidearmId; packItem: DeployKind; perk: PerkId; skill: SkillId } {
    const saved = settings.get(PlayerLoadout.GEAR_KEY[c]);
    const [belt, side, pack, perk, skill] = (saved || ',,,,').split(',');
    const {h} = this;
    return {
      beltItem: (belt || h.beltItem) as BeltItem,
      sidearm: (side || h.sidearm) as SidearmId,
      packItem: (pack || h.packItem) as DeployKind,
      perk: (perk || h.perk) as PerkId,
      skill: (skill || h.skill) as SkillId,
    };
  }

  private restoreGear(c: ArmorClass): void {
    const g = this.parseGear(c);
    this.h.beltItem = g.beltItem;
    this.h.sidearm = g.sidearm;
    this.h.packItem = g.packItem;
    this.h.perk = g.perk;
    this.h.skill = g.skill;
  }
  // wid derives from SLOT_DEFS by weaponType — hardcoded indices went
  // stale the moment HealBeam appended after Blaster (blaster was
  // wrongly 23 → equipped the heal beam; it's 21).
  static readonly SIDEARM = {
    pistol:   { wid: widOf(WeaponType.Pistol),      label: 'Pistol' },
    revolver: { wid: widOf(WeaponType.Revolver),    label: 'Revolver' },
    shotgun:  { wid: widOf(WeaponType.Shotgun),     label: 'Shotgun' },
    repair:   { wid: widOf(WeaponType.Repair),      label: 'Repair Tool' },
    lance:    { wid: LANCE_WID,                     label: 'Lance' },
    blaster:  { wid: widOf(WeaponType.Blaster),     label: 'Blaster' },
  } as const;
  /** wid lookup per id — kept as SIDEARM_WIDS for existing callers. */
  static readonly SIDEARM_WIDS = Object.fromEntries(
    Object.entries(PlayerLoadout.SIDEARM).map(([k, v]): [string, number] => [k, v.wid])) as Record<SidearmId, number>;

  // Hold-out secondaries: while the bind is held the weapon swaps in and
  // auto-fires at its own cadence; release snaps back to the loadout slot.
  // wids are slot-space indices into SLOT_DEFS.
  secondaryWid: number | null = null;
  // Draw delay — the hold-out key swaps the model in instantly but firing
  // waits for the raise, so the gun isn't shooting through its own holster.
  secondaryDrawT = 0;

  // Banked kit — non-null while armorClass ≠ appliedClass: the loadout
  // you're building for the tier you'll respawn as. Live fire always
  // reads h.loadout; the menu and setLoadoutSlot edit THIS, and respawn
  // installs it. Without it a class pick would rewrite the live array
  // and silently change the gun in your hand mid-life.
  pendingLoadout: number[] | null = null;

  /** The kit the menu should display/edit — pending while a class swap
   *  is banked, live otherwise. */
  menuKit(): readonly number[] { return this.pendingLoadout ?? this.h.loadout; }

  constructor(private h: LoadoutHost) {
    // Per-class gear memory wins at boot too — same rule as the loadout
    // keys above. Without this a fresh session reads the SHARED fps-*
    // defaults until the first class switch, so the tier kit never lands.
    this.restoreGear(this.h.armorClass);
  }

  static parseLoadout(raw: string): number[] {
    const ids = raw.split(',').map(Number).filter((n): boolean => Number.isInteger(n) && n >= 0 && n < SLOT_COUNT);
    return ids.length === PlayerLoadout.LOADOUT_SLOTS ? ids : [0, 2, 6, 7];
  }

  setPerk(p: PerkId): void {
    const g = this.gearPick();
    g.perk = p;
    if (!this.pendingGear) {settings.set('fps-perk', p);}
    this.saveGear();
  }

  /** Menu pick — records the intent; the swap lands at respawn via
   *  applyPendingClass (the server banks the same pick through
   *  classUpdate so both ends flip together). */
  setArmorClass(c: ArmorClass): void {
    if (this.igun) {return;}
    if (this.instagib && c !== 'light') {return;}
    if (c !== this.h.armorClass) {
      // Stash the kit under the tier being left — the PENDING kit if one
      // was being built, live otherwise — then recall the target tier's
      // remembered kit into the pending slot. Nothing here may touch
      // h.loadout or emit a switch: the class banks at respawn, and the
      // gun in your hand belongs to this life.
      const leaving = this.pendingLoadout ?? this.h.loadout;
      settings.set(PlayerLoadout.CLASS_KEY[this.h.armorClass], leaving.join(','));
      this.saveGear();
      if (c === this.h.appliedClass) {
        this.pendingLoadout = null; // back to the tier you're wearing — live edits again
        this.pendingGear = null;
      } else {
        const saved = settings.get(PlayerLoadout.CLASS_KEY[c]);
        // Gear banks with the kit — restore into pendingGear, not the
        // live fields (a mid-life perk/pack swap is a free buff).
        this.pendingGear = this.parseGear(c);
        // First visit to a tier carries the current kit as a starting
        // point — unshoulderLocked scrubs the illegal picks at respawn.
        this.pendingLoadout = saved ? PlayerLoadout.parseLoadout(saved) : [...this.h.loadout];
      }
    }
    this.h.armorClass = c;
    settings.set('fps-class', c);
  }

  /** Respawn-time tier application: speed scale, HP pool (via the
   *  maxHealth getter), ordnance unshoulder, and the body model swap
   *  when the silhouette tier flips. */
  applyPendingClass(): void {
    const c = this.h.armorClass;
    // Install the banked kit FIRST — even when the tier didn't change,
    // a pending loadout is a respawn pick waiting to land.
    if (this.pendingLoadout) {
      this.h.loadout = this.pendingLoadout;
      this.pendingLoadout = null;
      settings.set('fps-loadout', this.h.loadout.join(','));
    }
    // Gear banks with the kit — belt/sidearm/pack/perk/skill install on
    // the same life boundary. fps-* mirrors track the LIVE picks.
    if (this.pendingGear) {
      const g = this.pendingGear;
      this.pendingGear = null;
      this.h.beltItem = g.beltItem;
      this.h.sidearm = g.sidearm;
      this.h.packItem = g.packItem;
      this.h.perk = g.perk;
      this.h.skill = g.skill;
      settings.set('fps-belt', g.beltItem);
      settings.set('fps-sidearm', g.sidearm);
      settings.set('fps-pack', g.packItem);
      settings.set('fps-perk', g.perk);
      settings.set('fps-skill', g.skill);
    }
    if (this.h.appliedClass === c) {
      // A just-installed banked kit was gated for the tier it was BUILT
      // for: a wire-stomped armorClass (dropped classUpdate) can leave
      // picks the live tier can't shoulder. Scrub or they reject all life.
      this.unshoulderLocked();
      return;
    }
    this.h.appliedClass = c;
    this.h.movement.setSpeedScale(CLASS_STATS[c].speedScale);
    this.h.movement.setBody(CLASS_STATS[c].mass, CLASS_STATS[c].eyeHeight, CLASS_STATS[c].radius);
    this.h.movement.setJumpstart(this.h.mods.jumpstart);
    // Every tier has locked guns now — heavy ordnance, medium's mid punch,
    // and light-frame precision gear all unshoulder on the wrong chassis.
    this.unshoulderLocked();
    // The class IS the body — same GLB remotes see on this player. A
    // tier swap rebuilds the whole model, not a rescale; the hidden /
    // gizmo-off local state reasserts once the new GLB lands.
    const want = CLASS_BODY_VARIANT[c] ?? 'vexa';
    const rev = CLASS_BODY_MAT_REV.has(c);
    if (this.h.model && (this.h.model.variant !== want || this.h.model.mannRev !== rev)) {
      const old = this.h.model;
      const m = new PlayerModel(this.h.scene, want as PlayerModelVariant, rev);
      this.h.model = m;
      m.load().then((): void => {
        m.setScale(CLASS_MODEL_SCALE[c]);
        m.setVisible(false);
        m.setColliderVisible(false);
        old.dispose();
      return; }).catch((error): void => {
        // load() rejects after 4 retries — revert to the still-alive old
        // model instead of leaving h.model on a corpse that never loads.
        this.h.model = old;
        m.dispose();
        logger.warn('Class model swap gave up', { class: c, error: String(error) });
      });
    }
  }

  /** Unshoulder restricted ordnance — swap each gated slot for the
   *  chaingun so no slot ends up empty. Called when a tier drops below
   *  heavy (respawn bank) AND at construction, since the persisted
   *  loadout parses raw and can carry a stale locked pick. */
  unshoulderLocked(): void {
    for (let i = 0; i < this.h.loadout.length; i += 1) {
      if (this.lockedFor(this.h.appliedClass, this.h.loadout[i])) {
        this.setLoadoutSlot(i, PlayerLoadout.fallbackWid(this.h.appliedClass, this.h.loadout));
      }
    }
  }

  /** Unshoulder target for a class-locked slot: the chaingun (every
   *  tier shoulders it) unless it's already equipped — then the first
   *  legal, not-always-carried wid so two slots never hold the same gun. */
  static fallbackWid(cls: ArmorClass, loadout: readonly number[]): number {
    if (!loadout.includes(2)) {return 2;}
    for (let w = 0; w < SLOT_COUNT; w += 1) {
      if (!loadout.includes(w) && !PlayerLoadout.lockedForClass(cls, w)) {return w;}
    }
    return 2;
  }

  /** Slot-space tier gate — the menu gate and unshoulder share it. */
  /** Slot-space tier gate — the menu gate, unshoulder, and the dropup
   *  disabled-flag all read this one truth. */
  static lockedForClass(cls: ArmorClass, wid: number): boolean {
    return (cls !== 'heavy' && PlayerLoadout.HEAVY_ONLY.includes(wid)) ||
           (cls !== 'medium' && PlayerLoadout.MEDIUM_ONLY.includes(wid)) ||
           (cls !== 'light' && PlayerLoadout.LIGHT_ONLY.includes(wid));
  }
  private lockedFor(cls: ArmorClass, wid: number): boolean {
    return PlayerLoadout.lockedForClass(cls, wid);
  }

  /** Respawn-time perk application — the picked perk banks here so its
   *  HP/energy/speed mods never flip mid-life under the server's nose. */
  applyPendingPerk(): void {
    if (this.h.appliedPerk !== this.h.perk) {
      this.h.appliedPerk = this.h.perk;
      this.h.movement.setJumpstart(this.h.mods.jumpstart);
    }
  }

  /** Kill-refund (railgun): ready instantly, but requires a fresh click —
   *  without needsRelease the still-held trigger would re-fire same-frame. */
  refundWeaponCooldown(): void {
    this.h.fireTimer = 0;
    this.h.input.needsRelease = true;
  }

  setLoadoutSlot(slot: number, weaponId: number): void {
    const {h} = this;
    // Instagib: the modifier owns every slot - a stray pick (console,
    // stale menu) can't diversify the kit the server would reject anyway.
    if (this.instagib && weaponId !== widOf(WeaponType.Railgun)) {return;}
    // Gun-game: the ladder owns every slot - a stray pick can't diversify
    // the kit the rung gate would reject anyway.
    if (this.gunGame) {return;}
    // Heavy-only ordnance bounces off lighter armor — the menu filters it
    // out, this is the belt line for stale loadouts/console picks. Gates on
    // appliedClass (the tier the server enforces), not armorClass — a mid-
    // life heavy pick banks until respawn; letting it shoulder now would
    // spam class-locked rejections for the rest of the life.
    //
    // While a class swap is banked the edit lands on the PENDING kit —
    // gated by the tier being built (armorClass), so banking heavy and
    // picking a mortar is legal; it shoulders at respawn. Live edits
    // still gate on appliedClass, the tier the server enforces.
    const kit = this.pendingLoadout ?? h.loadout;
    const gate = this.pendingLoadout ? h.armorClass : h.appliedClass;
    if (this.lockedFor(gate, weaponId)) {return;}
    // Picking a weapon that's already equipped elsewhere swaps the slots
    // instead of duplicating it — standard loadout-menu behavior.
    const other = kit.indexOf(weaponId);
    if (other !== -1 && other !== slot) {kit[other] = kit[slot]!;}
    kit[slot] = weaponId;
    // Persist under the tier the kit belongs to; 'fps-loadout' mirrors
    // the LIVE kit only — it's the construction-time default.
    settings.set(PlayerLoadout.CLASS_KEY[h.armorClass], kit.join(','));
    if (this.pendingLoadout) {return;} // banked kit — nothing re-draws now
    settings.set('fps-loadout', kit.join(','));
    if (h.weaponIndex === slot || h.weaponIndex === other) {
      this.emitWeaponSwitch(kit[h.weaponIndex]!);
    }
  }

  /** Authority-forced scrub: the server just refused this slot's weapon
   *  as class-locked, so the LIVE kit must drop it now. setLoadoutSlot
   *  can't do this job - while a class swap is banked it edits
   *  pendingLoadout and the live gun keeps rejecting every pull. */
  unshoulderLiveSlot(slot: number): void {
    const {h} = this;
    const wid = PlayerLoadout.fallbackWid(h.appliedClass, h.loadout);
    const other = h.loadout.indexOf(wid);
    if (other !== -1 && other !== slot) {h.loadout[other] = h.loadout[slot]!;}
    h.loadout[slot] = wid;
    settings.set('fps-loadout', h.loadout.join(','));
    settings.set(PlayerLoadout.CLASS_KEY[h.appliedClass], h.loadout.join(','));
    if (h.weaponIndex === slot || h.weaponIndex === other) {
      this.emitWeaponSwitch(h.loadout[h.weaponIndex]!);
    }
  }

  /** Weapon changed: viewmodel/audio hook + the third-person body's
   *  lower→raise swap dip; the hand prop becomes the real weapon. */
  emitWeaponSwitch(wid: number): void {
    // Fire lock for the full swap cycle - a pull-out isn't shootable
    // until the gun is back up (same window SIDEARM_DRAW_TIME paints).
    this.h.weaponDrawT = SIDEARM_DRAW_TIME;
    this.h.onWeaponSwitch?.(wid);
    // The model's hand prop keys on the WIRE weaponType (remote fires feed
    // it enums) — a raw wid would look the slot index up as an enum and
    // draw the wrong gun (plasma slot 6 → enum 6 = flak).
    this.h.model?.setWeapon(weaponDef(wid).weaponType);
    this.h.model?.weaponSwap();
  }

  setBeltItem(item: BeltItem): void {
    if (this.instagib && item !== 'hook') {return;}
    if (this.gunGame && item !== 'hook') {return;} // only the grapple survives the ladder gate
    this.gearPick().beltItem = item;
    if (!this.pendingGear) {settings.set('fps-belt', item);}
    this.saveGear();
  }
  setSidearm(s: SidearmId): void {
    if (this.instagib || this.gunGame) {return;} // no sidearm under a kit lock
    this.gearPick().sidearm = s;
    if (!this.pendingGear) {settings.set('fps-sidearm', s);}
    this.saveGear();
  }
  setPackItem(p: DeployKind): void {
    if (this.instagib || this.gunGame) {return;} // no pack under a kit lock
    this.gearPick().packItem = p;
    if (!this.pendingGear) {settings.set('fps-pack', p);}
    this.saveGear();
  }
  setSkill(s: SkillId): void {
    this.gearPick().skill = s;
    if (!this.pendingGear) {settings.set('fps-skill', s);}
    this.saveGear();
  }

  get sidearmWid(): number { return (PlayerLoadout.SIDEARM as Record<string, { wid: number }>)[this.h.sidearm]!.wid; }
  get currentWid(): number { return this.h.loadout[this.h.weaponIndex]; }

  /** Hold-out key down — swap the sidearm in and arm its draw timer. */
  secondaryDown(wid: number): void {
    if (this.kitLocked) {return;} // no sidearm under a kit lock
    if (wid !== this.secondaryWid) {
      this.secondaryWid = wid;
      this.secondaryDrawT = SIDEARM_DRAW_TIME;
      this.emitWeaponSwitch(wid);
    }
  }

  /** Hold-out key released — snap back to the loadout slot. */
  secondaryUp(): void {
    if (this.secondaryWid !== null) {
      this.secondaryWid = null;
      this.emitWeaponSwitch(this.currentWid);
    }
  }

  selectSlot(i: number): void {
    const {h} = this;
    // Kit locks field one gun - slot keys are dead input, not a swap.
    if (this.kitLocked) {return;}
    // Draw is always legal: prepping a groundedOnly weapon for touchdown
    // is the play - fire.ts refuses the trigger, not the shoulder.
    if (i !== h.weaponIndex) {
      h.weaponIndex = i;
      this.igunSlotChassis();
      this.emitWeaponSwitch(h.loadout[i]);
    }
  }

  cycleWeapon(step: number): void {
    const {h} = this;
    if (this.kitLocked) {return;}
    const n = h.loadout.length;
    const idx = (h.weaponIndex + step + n) % n;
    if (idx !== h.weaponIndex) {
      h.weaponIndex = idx;
      this.igunSlotChassis();
      this.emitWeaponSwitch(h.loadout[idx]);
    }
  }
}
export type SidearmId = keyof typeof PlayerLoadout.SIDEARM;  
