import { describe, it, expect } from 'bun:test';
import {
  BOT_LOADOUTS, botClassForLoadout, pickBotWeapon, pickBotWeaponSafe,
  type BotLoadout,
} from '../../shared/botLoadouts.ts';
import { classCanFire } from '../../shared/botClasses.ts';
import { WeaponType, getWeaponStats } from '../../shared/weapons.ts';
import { SELF_SPLASH_MAX } from '../../shared/combat.ts';

// The loadout table is shipped data: a row whose kit doesn't fit the
// class the resolver assigns produces a bot that spawns holding a gun
// the server then refuses to fire — silent dry pulls, forever. The
// table-wide check below pins every row against the same classCanFire
// gate the room uses.

const lo = (over: Partial<BotLoadout> = {}): BotLoadout => ({
  perk: 'vitality', near: WeaponType.Chaingun, mid: WeaponType.Disc,
  far: WeaponType.BoltLauncher, belt: WeaponType.Grenade,
  side: WeaponType.Pistol, ...over,
});

describe('botLoadouts', () => {
  it('every shipped kit is fireable by the class its resolver assigns', () => {
    for (const kit of BOT_LOADOUTS) {
      const cls = botClassForLoadout(kit);
      for (const w of [kit.near, kit.mid, kit.far, kit.belt, kit.side]) {
        expect(classCanFire(cls, w), `${kit.perk} kit: ${WeaponType[w]} on ${cls}`).toBe(true);
      }
    }
  });

  it('class resolution: ordnance > lock sets > perk > default medium', () => {
    expect(botClassForLoadout(lo({ far: WeaponType.Mortar }))).toBe('heavy');   // heavy-only far
    expect(botClassForLoadout(lo({ belt: WeaponType.MRVLauncher }))).toBe('heavy'); // heavy-only ordnance belt
    expect(botClassForLoadout(lo({ perk: 'plated' }))).toBe('heavy');
    expect(botClassForLoadout(lo({ perk: 'featherjets' }))).toBe('light');
    // featherjets carrying medium-locked ordnance can't shoulder it on a
    // light frame — the class gate outranks the perk's silhouette.
    expect(botClassForLoadout(lo({ perk: 'featherjets', near: WeaponType.Flak }))).toBe('medium');
    // light-locked guns pick the body outright, over any ordnance
    expect(botClassForLoadout(lo({ perk: 'plated', far: WeaponType.Railgun, belt: WeaponType.Javelin }))).toBe('light');
    expect(botClassForLoadout(lo())).toBe('medium');
  });

  it('range bands: melee < 4.5, sidearm < 8, near < 15, mid to 40, far beyond', () => {
    const kit = lo();
    expect(pickBotWeapon(kit, 2, 2)).toBe(WeaponType.Melee);
    expect(pickBotWeapon(kit, 6, 6)).toBe(kit.side);
    expect(pickBotWeapon(kit, 12, 12)).toBe(kit.near);
    expect(pickBotWeapon(kit, 25, 25)).toBe(kit.mid);
    expect(pickBotWeapon(kit, 60, 60)).toBe(kit.far);
  });

  it('HealBeam is never drawn against an enemy — beltOut substitutes mid', () => {
    const kit = lo({ side: WeaponType.HealBeam, near: WeaponType.HealBeam });
    expect(pickBotWeapon(kit, 6, 6)).toBe(kit.mid);   // side slot
    expect(pickBotWeapon(kit, 12, 12)).toBe(kit.mid); // near slot
    const skilled = pickBotWeapon(kit, 12, 12, () => 1);
    expect(skilled).not.toBe(WeaponType.HealBeam);
  });

  it('nonAoeOnly never hands back a launcher — falls to the first safe gun', () => {
    const kit = lo({ near: WeaponType.Disc, mid: WeaponType.Disc, far: WeaponType.Mortar });
    const w = pickBotWeapon(kit, 12, 12, () => 1, 0.5, true);
    expect(getWeaponStats(w).aoeRadius).toBeLessThanOrEqual(0);
  });

  it('an enemy inside self-blast range discounts aoe for the cautious, not the bold', () => {
    const kit = lo({ near: WeaponType.Disc }); // aoe launcher in the near band
    // dist 6 sits inside the disc's 10m blast — the cautious draw the
    // splash-free sidearm while a disc specialist with nerve keeps it.
    const skill = (w: number) => w === WeaponType.Disc ? 1 : 0.3;
    const cautious = pickBotWeapon(kit, 6, 6, skill, 0.0);
    const bold = pickBotWeapon(kit, 6, 6, skill, 1.0);
    expect(getWeaponStats(cautious).aoeRadius).toBeLessThanOrEqual(0);
    expect(bold).toBe(WeaponType.Disc);
  });

  it('wounded gate: low hp holsters aoe only where the blast can still reach back', () => {
    const kit = lo({ mid: WeaponType.Disc, far: WeaponType.Mortar });
    const hp = SELF_SPLASH_MAX * 0.5; // below one self-blast's price
    const close = pickBotWeaponSafe(kit, 20, 20, hp, () => 1, 0.5);
    expect(getWeaponStats(close).aoeRadius).toBeLessThanOrEqual(0);
    // A shell landing 60m+ can't splash the shooter — standoff keeps the
    // launcher instead of spamming a sidearm at enemies it can't touch.
    const far = pickBotWeaponSafe(kit, 100, 100, hp, () => 1, 0.5);
    expect(far).toBe(WeaponType.Mortar);
  });
});
