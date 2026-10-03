import { settings } from '../core/settings.js';
import { SLOT_COUNT } from '../weapons.js';
import { SIDEARM_DRAW_TIME } from './ViewModel.js';
import type { MovementController } from './movement.js';
import type { PlayerInput } from './player/input.js';
import type { PerkId } from '../../../shared/perks.js';
import { CLASS_STATS, CLASS_MODEL_SCALE, type ArmorClass } from '../../../shared/botClasses.js';
import { PlayerModel, type PlayerModelVariant } from './PlayerModel.js';
import { CLASS_BODY_VARIANT } from './playerClips.js';
import type * as THREE from 'three';
import type { BeltItem } from './Player.js';
import type { DeployKind } from '../../../shared/deployables.js';

/**
 * PlayerLoadout — the armory: class-tier banking, perk banking, weapon
 * slots, belt/sidearm/pack picks, and the hold-out secondary swap.
 * Persists every pick to settings; the host keeps the flat fields the
 * rest of the app reads (loadout, weaponIndex, appliedClass, ...).
 */

export interface LoadoutHost {
  perk: PerkId;
  appliedPerk: PerkId;
  armorClass: ArmorClass;
  appliedClass: ArmorClass;
  loadout: number[];
  weaponIndex: number;
  beltItem: BeltItem;
  sidearm: 'pistol' | 'revolver' | 'shotgun' | 'repair';
  packItem: DeployKind;
  fireTimer: number;
  model: PlayerModel | null;
  scene: THREE.Scene;
  movement: MovementController;
  input: PlayerInput;
  onWeaponSwitch: ((index: number) => void) | null;
}

export class PlayerLoadout {
  /** Tier-restricted ordnance — the heavy's exclusive arsenal, same as
   *  TA where lights can't shoulder a mortar. Indexed SLOT_DEFS ids. */
  static readonly HEAVY_ONLY: readonly number[] = [3, 6, 11, 18]; // Mortar, PlasmaCannon, RocketLauncher, MRVLauncher
  /** Medium-only guns — lights trade them for speed, heavies for ordnance. */
  static readonly MEDIUM_ONLY: readonly number[] = [5, 15]; // Flak, PlasmaGun
  /** Light-frame precision gear — heavier chassis can't shoulder them. */
  static readonly LIGHT_ONLY: readonly number[] = [7, 8]; // Railgun, Lightning
  static readonly LOADOUT_SLOTS = 4;
  /** Per-class kit memory — the four weapon slots are remembered per
   *  tier, so heavy's ordnance rig survives a stint on light. */
  static readonly CLASS_KEY = {
    light: 'fps-loadout-light', medium: 'fps-loadout-medium', heavy: 'fps-loadout-heavy',
  } as const;
  // wid is slot-space (SLOT_DEFS index): pistol 12, revolver 13, shotgun 9,
  // repair 17. (sticky launcher sits at wid 14 — primary, not a hold-out.)
  static readonly SIDEARM_WIDS = { pistol: 12, revolver: 13, shotgun: 9, repair: 17 } as const;

  // Hold-out secondaries: while the bind is held the weapon swaps in and
  // auto-fires at its own cadence; release snaps back to the loadout slot.
  // wids are slot-space indices into SLOT_DEFS.
  secondaryWid: number | null = null;
  // Draw delay — the hold-out key swaps the model in instantly but firing
  // waits for the raise, so the gun isn't shooting through its own holster.
  secondaryDrawT = 0;

  constructor(private h: LoadoutHost) {}

  static parseLoadout(raw: string): number[] {
    const ids = raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < SLOT_COUNT);
    return ids.length === PlayerLoadout.LOADOUT_SLOTS ? ids : [0, 2, 6, 7];
  }

  setPerk(p: PerkId): void {
    this.h.perk = p;
    settings.set('fps-perk', p);
  }

  /** Menu pick — records the intent; the swap lands at respawn via
   *  applyPendingClass (the server banks the same pick through
   *  classUpdate so both ends flip together). */
  setArmorClass(c: ArmorClass): void {
    if (c !== this.h.armorClass) {
      // Stash the kit under the tier being left, then recall the target
      // tier's remembered kit. First visit keeps the carried loadout —
      // unshoulderLocked scrubs anything illegal at respawn anyway.
      settings.set(PlayerLoadout.CLASS_KEY[this.h.armorClass], this.h.loadout.join(','));
      const saved = settings.get(PlayerLoadout.CLASS_KEY[c]);
      if (saved) {
        this.h.loadout = PlayerLoadout.parseLoadout(saved);
        settings.set('fps-loadout', this.h.loadout.join(','));
        this.emitWeaponSwitch(this.h.loadout[this.h.weaponIndex]);
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
    if (this.h.appliedClass === c) return;
    this.h.appliedClass = c;
    this.h.movement.setSpeedScale(CLASS_STATS[c].speedScale);
    this.h.movement.setBody(CLASS_STATS[c].mass, CLASS_STATS[c].eyeHeight, CLASS_STATS[c].radius);
    // Every tier has locked guns now — heavy ordnance, medium's mid punch,
    // and light-frame precision gear all unshoulder on the wrong chassis.
    this.unshoulderLocked();
    // The class IS the body — same GLB remotes see on this player. A
    // tier swap rebuilds the whole model, not a rescale; the hidden /
    // gizmo-off local state reasserts once the new GLB lands.
    const want = CLASS_BODY_VARIANT[c] ?? 'vexa';
    if (this.h.model && this.h.model.variant !== want) {
      const old = this.h.model;
      const m = new PlayerModel(this.h.scene, want as PlayerModelVariant);
      this.h.model = m;
      void m.load().then(() => {
        m.setScale(CLASS_MODEL_SCALE[c]);
        m.setVisible(false);
        m.setColliderVisible(false);
        old.dispose();
      });
    }
  }

  /** Unshoulder restricted ordnance — swap each gated slot for the
   *  chaingun so no slot ends up empty. Called when a tier drops below
   *  heavy (respawn bank) AND at construction, since the persisted
   *  loadout parses raw and can carry a stale locked pick. */
  unshoulderLocked(): void {
    for (let i = 0; i < this.h.loadout.length; i++) {
      if (this.lockedFor(this.h.appliedClass, this.h.loadout[i])) {
        this.setLoadoutSlot(i, PlayerLoadout.fallbackWid(this.h.appliedClass, this.h.loadout));
      }
    }
  }

  /** Unshoulder target for a class-locked slot: the chaingun (every
   *  tier shoulders it) unless it's already equipped — then the first
   *  legal, not-always-carried wid so two slots never hold the same gun. */
  static fallbackWid(cls: ArmorClass, loadout: readonly number[]): number {
    if (!loadout.includes(2)) return 2;
    for (let w = 0; w < SLOT_COUNT; w++) {
      if (!loadout.includes(w) && !PlayerLoadout.lockedForClass(cls, w)) return w;
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
    if (this.h.appliedPerk !== this.h.perk) this.h.appliedPerk = this.h.perk;
  }

  /** Kill-refund (railgun): ready instantly, but requires a fresh click —
   *  without needsRelease the still-held trigger would re-fire same-frame. */
  refundWeaponCooldown(): void {
    this.h.fireTimer = 0;
    this.h.input.needsRelease = true;
  }

  setLoadoutSlot(slot: number, weaponId: number): void {
    const h = this.h;
    // Heavy-only ordnance bounces off lighter armor — the menu filters it
    // out, this is the belt line for stale loadouts/console picks. Gates on
    // appliedClass (the tier the server enforces), not armorClass — a mid-
    // life heavy pick banks until respawn; letting it shoulder now would
    // spam class-locked rejections for the rest of the life.
    if (this.lockedFor(h.appliedClass, weaponId)) return;
    // Picking a weapon that's already equipped elsewhere swaps the slots
    // instead of duplicating it — standard loadout-menu behavior.
    const other = h.loadout.indexOf(weaponId);
    if (other >= 0 && other !== slot) h.loadout[other] = h.loadout[slot];
    h.loadout[slot] = weaponId;
    settings.set('fps-loadout', h.loadout.join(','));
    // Edits belong to the picked tier — persist under it too so a
    // loadout tweak isn't lost if the session ends before a class hop.
    settings.set(PlayerLoadout.CLASS_KEY[h.armorClass], h.loadout.join(','));
    if (h.weaponIndex === slot || h.weaponIndex === other) {
      this.emitWeaponSwitch(h.loadout[h.weaponIndex]);
    }
  }

  /** Weapon changed: viewmodel/audio hook + the third-person body's
   *  lower→raise swap dip on the held prop gun. */
  emitWeaponSwitch(wid: number): void {
    this.h.onWeaponSwitch?.(wid);
    this.h.model?.weaponSwap();
  }

  setBeltItem(item: BeltItem): void {
    this.h.beltItem = item;
    settings.set('fps-belt', item);
  }
  setSidearm(s: 'pistol' | 'revolver' | 'shotgun' | 'repair'): void {
    this.h.sidearm = s;
    settings.set('fps-sidearm', s);
  }
  setPackItem(p: DeployKind): void {
    this.h.packItem = p;
    settings.set('fps-pack', p);
  }

  get sidearmWid(): number { return (PlayerLoadout.SIDEARM_WIDS as Record<string, number>)[this.h.sidearm]!; }
  get currentWid(): number { return this.h.loadout[this.h.weaponIndex]; }

  /** Hold-out key down — swap the sidearm in and arm its draw timer. */
  secondaryDown(wid: number): void {
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
    const h = this.h;
    if (i !== h.weaponIndex) {
      h.weaponIndex = i;
      this.emitWeaponSwitch(h.loadout[i]);
    }
  }

  cycleWeapon(step: number): void {
    const h = this.h;
    const n = h.loadout.length;
    const idx = (h.weaponIndex + step + n) % n;
    if (idx !== h.weaponIndex) {
      h.weaponIndex = idx;
      this.emitWeaponSwitch(h.loadout[idx]);
    }
  }
}
