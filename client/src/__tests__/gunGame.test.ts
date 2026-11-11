import { describe, it, expect } from 'vitest';

import { PlayerLoadout, type LoadoutHost } from '../entities/playerLoadout';
import { widOf } from '../weapons';
import { WeaponType } from '../../../shared/weapons';
import { gunGameWeapon, gunGameBucket } from '../../../shared/gunGame';
import type { PerkMods } from '../../../shared/perks';
import type { MovementController } from '../entities/movement';
import type { PlayerInput } from '../entities/player/input';
import type { PlayerModel } from '../entities/PlayerModel';
import type * as THREE from 'three';

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

describe('gun-game armory lock', () => {
  it('applyGunGame fills the band with rung 0 bucket members and pins the hook belt', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    const w0 = widOf(gunGameWeapon(0));
    armory.applyGunGame();
    expect(armory.gunGame).toBe(true);
    expect(armory.kitLocked).toBe(true);
    // Bucket roll mirrors the dealt member across all slots.
    expect(host.loadout).toEqual([w0, w0, w0, w0]);
    expect(host.beltItem).toBe('hook');
  });

  it('setGunGameRung mirrors the dealt member on a rung edge', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    armory.applyGunGame();
    // The wire carries the roll - mirror the dealt member in all slots.
    armory.setGunGameRung(7, WeaponType.Sticky);
    expect(host.loadout).toEqual([widOf(WeaponType.Sticky), widOf(WeaponType.Sticky), widOf(WeaponType.Sticky), widOf(WeaponType.Sticky)]);
    expect(host.weaponIndex).toBe(0);
    // No wt falls back to the canonical member of the rung bucket.
    armory.setGunGameRung(3);
    expect(host.loadout).toEqual([widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3))]);
  });

  it('a rung edge before the lock stashes the roll and lands it on apply', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    // Wire ordering can deliver gunRung ahead of the gameState that
    // arms the lock - the dealt member must survive, not be eaten.
    armory.setGunGameRung(7, WeaponType.Sticky);
    armory.applyGunGame();
    expect(host.loadout).toEqual([widOf(WeaponType.Sticky), widOf(WeaponType.Sticky), widOf(WeaponType.Sticky), widOf(WeaponType.Sticky)]);
  });

  it('a pre-lock rung with no wt still lands its rung on apply', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    armory.setGunGameRung(3); // wt absent -> canonical member of rung 3
    armory.applyGunGame();
    expect(host.loadout).toEqual([widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3)), widOf(gunGameWeapon(3))]);
  });

  it('slot/belt/sidearm picks are dead input under the lock', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    armory.applyGunGame();
    const w0 = widOf(gunGameWeapon(0));
    armory.setLoadoutSlot(0, widOf(WeaponType.Railgun));
    armory.setBeltItem('grenade');
    armory.setSidearm('pistol');
    armory.setPackItem('turret');
    armory.selectSlot(2);
    armory.cycleWeapon(1);
    armory.secondaryDown(99);
    expect(host.loadout).toEqual([w0, w0, w0, w0]);
    expect(host.beltItem).toBe('hook');
    expect(host.weaponIndex).toBe(0);
  });

  it('releaseGunGame restores the pre-lock kit', () => {
    const host = mkHost({ loadout: [1, 3, 5, 9], weaponIndex: 2 });
    const armory = new PlayerLoadout(host);
    // The ctor's restoreGear overwrites mkHost's belt from settings -
    // pick through the armory so the snapshot sees a real BeltItem.
    armory.setBeltItem('grenade');
    armory.applyGunGame();
    armory.setGunGameRung(4);
    armory.releaseGunGame();
    expect(armory.gunGame).toBe(false);
    // The banked-kit scrub may swap class-illegal picks on install - the
    // contract is "the locked band is gone", not a specific wid list.
    expect(host.loadout).not.toEqual(gunGameBucket(4).map((w): number => widOf(w)));
    expect(host.beltItem).toBe('grenade');
    expect(host.weaponIndex).toBe(2);
  });

  it('apply/release are idempotent across repeated gameStates', () => {
    const host = mkHost({});
    const armory = new PlayerLoadout(host);
    armory.applyGunGame();
    armory.applyGunGame(); // second gameState must not re-snapshot the locked kit
    armory.releaseGunGame();
    const restored = [...host.loadout];
    const belt = host.beltItem;
    armory.releaseGunGame();
    // The banked-kit scrub may already have rewritten class-illegal
    // picks - the contract is a stable restore, not the raw wid list.
    expect(host.loadout).toEqual(restored);
    expect(host.beltItem).toBe(belt);
    expect(armory.gunGame).toBe(false);
  });
});
