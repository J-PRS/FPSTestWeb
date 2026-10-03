import { settings } from '../core/settings.js';
import { SLOT_COUNT } from '../weapons.js';
import { SIDEARM_DRAW_TIME } from './ViewModel.js';
import type { PlayerModel } from './PlayerModel.js';
import type { MovementController } from './movement.js';
import type { PlayerInput } from './player/input.js';
import type { PerkId } from '../../../shared/perks.js';
import { CLASS_STATS, CLASS_MODEL_SCALE, type ArmorClass } from '../../../shared/botClasses.js';
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
  movement: MovementController;
  input: PlayerInput;
  onWeaponSwitch: ((index: number) => void) | null;
}

export class PlayerLoadout {
  /** Tier-restricted ordnance — the heavy's exclusive arsenal, same as
   *  TA where lights can't shoulder a mortar. Indexed SLOT_DEFS ids. */
  static readonly HEAVY_ONLY: readonly number[] = [3, 6, 11, 18]; // Mortar, PlasmaCannon, RocketLauncher, MRVLauncher
  static readonly LOADOUT_SLOTS = 4;
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
    if (c !== 'heavy') this.unshoulderHeavy();
    // One cast for all tiers — the class reads as a scale bump, not a
    // different model, so a tier swap is a rescale, not a rebuild.
    this.h.model?.setScale(CLASS_MODEL_SCALE[c]);
  }

  /** Unshoulder restricted ordnance — swap each gated slot for the
   *  chaingun so no slot ends up empty. Called when a tier drops below
   *  heavy (respawn bank) AND at construction, since the persisted
   *  loadout parses raw and can carry a stale heavy pick. */
  unshoulderHeavy(): void {
    for (let i = 0; i < this.h.loadout.length; i++) {
      if (PlayerLoadout.HEAVY_ONLY.includes(this.h.loadout[i])) this.setLoadoutSlot(i, 2);
    }
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
    if (h.appliedClass !== 'heavy' && PlayerLoadout.HEAVY_ONLY.includes(weaponId)) return;
    // Picking a weapon that's already equipped elsewhere swaps the slots
    // instead of duplicating it — standard loadout-menu behavior.
    const other = h.loadout.indexOf(weaponId);
    if (other >= 0 && other !== slot) h.loadout[other] = h.loadout[slot];
    h.loadout[slot] = weaponId;
    settings.set('fps-loadout', h.loadout.join(','));
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
