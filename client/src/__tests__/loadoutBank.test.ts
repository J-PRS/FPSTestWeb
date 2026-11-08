import { describe, it, expect } from 'vitest';

import { PlayerLoadout, type LoadoutHost } from '../entities/playerLoadout';
import { widOf } from '../weapons';
import { WeaponType } from '../../../shared/weapons';
import type { PerkMods } from '../../../shared/perks';
import type { MovementController } from '../entities/movement';
import type { PlayerInput } from '../entities/player/input';
import type { PlayerModel } from '../entities/PlayerModel';
import type * as THREE from 'three';

// applyPendingClass installs the banked kit BEFORE the appliedClass===c
// early return. When the respawn wire stomped armorClass back to the live
// tier (a dropped classUpdate), the banked kit was gated for a different
// class: without a scrub its locked weapons stay shouldered and every
// shot spam-rejects 'class-locked weapon' for the whole life.
function mkHost(over: Partial<LoadoutHost>): LoadoutHost {
  return {
    perk: 'none', appliedPerk: 'none',
    mods: { jumpstart: 0 } as PerkMods,
    armorClass: 'medium', appliedClass: 'medium',
    loadout: [0, 2, 6, 7], weaponIndex: 0,
    beltItem: 'disc', sidearm: 'pistol', packItem: 'turret', skill: 'dash',
    fireTimer: 0, weaponDrawT: 0,
    model: null as unknown as PlayerModel,
    scene: null as unknown as THREE.Scene,
    movement: { setSpeedScale() {}, setBody() {}, setJumpstart() {} } as unknown as MovementController,
    input: {} as unknown as PlayerInput,
    onWeaponSwitch: null,
    ...over,
  };
}

describe('banked kit install', () => {
  it('scrubs class-locked picks when the wire kept the live tier', () => {
    const lightningWid = widOf(WeaponType.Lightning);
    expect(PlayerLoadout.LIGHT_ONLY).toContain(lightningWid);
    const host = mkHost({ armorClass: 'medium', appliedClass: 'medium' });
    const armory = new PlayerLoadout(host);
    // Light-tier kit banked for a swap the server never saw: the respawn
    // wire reports medium, so armorClass was stomped before this call.
    armory.pendingLoadout = [lightningWid, 2, 6, 7];
    armory.applyPendingClass();
    expect(armory.pendingLoadout).toBeNull();
    expect(host.loadout).not.toContain(lightningWid);
    expect(host.appliedClass).toBe('medium');
  });

  it('keeps legal picks in the same install', () => {
    const host = mkHost({ armorClass: 'medium', appliedClass: 'medium' });
    const armory = new PlayerLoadout(host);
    // 0/1/2/4 are untiered, legal on every chassis.
    armory.pendingLoadout = [0, 2, 1, 4];
    armory.applyPendingClass();
    expect(host.loadout).toEqual([0, 2, 1, 4]);
  });
});

describe('unshoulderLiveSlot', () => {
  it('scrubs the LIVE kit even while a class swap is banked', () => {
    // A shotRejected class-locked must heal the gun in hand - routing the
    // write through setLoadoutSlot lands it on pendingLoadout and the live
    // slot rejects every pull forever (the prod Gonne/Lightning spam).
    const lightningWid = widOf(WeaponType.Lightning);
    const host = mkHost({ armorClass: 'heavy', appliedClass: 'light', loadout: [0, 2, 6, lightningWid] });
    const armory = new PlayerLoadout(host);
    armory.pendingLoadout = [0, 2, 6, 9];
    armory.unshoulderLiveSlot(3);
    expect(host.loadout[3]).not.toBe(lightningWid);
    expect(PlayerLoadout.lockedForClass('light', host.loadout[3]!)).toBe(false);
    expect(armory.pendingLoadout).toEqual([0, 2, 6, 9]); // banked kit untouched
  });
});
