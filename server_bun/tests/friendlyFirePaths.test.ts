import { simMs } from '../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

/** Skill claims need no projectile — melee/slam/lightning validate on
 *  reach and occlusion, so these paths don't spawn a shell first. */

// Friendly-fire sweep — every damage path between two 'alpha' teammates
// must stay dry with the option off and wet with it on. The room-level
// projectile gate has its own scenario test; this covers the claim-level
// paths: hitscan, AOE splash, melee, the LG beam tick, bot shots, and
// server-owned deployables (mine blast).

function harness(friendlyFire = false) {
  const players = new PlayerManager();
  const sentTo: { id: string; msg: ServerMessage }[] = [];
  const combat = new CombatHandler(
    players,
    () => {},
    (id, msg) => sentTo.push({ id, msg }),
    { teams: true, friendlyFire },
  );
  // Shooter + victim on the same team, parked at claim-plausible spots.
  const shooter = players.addPlayer('a1', 'alpha');
  shooter.position = { x: 0, y: 10, z: 0 };
  shooter.armorClass = 'light'; // Lightning is light-tier — the class-lock gate otherwise refuses the tick
  shooter.protectedUntil = simMs(0);
  const target = players.addPlayer('a2', 'alpha');
  target.position = { x: 0, y: 10, z: -3 };
  target.protectedUntil = simMs(0);
  return { players, combat, sentTo, target };
}

describe('friendly fire — damage paths', () => {
  it('melee intent swing on a teammate', () => {
    const { players, combat, target } = harness();
    players.getPlayer('a1')!.position = { x: 0, y: 8.8, z: -1 }; // rewind pos ≈ swing origin
    combat.handleShotFired('a1', {
      type: 'shotFired', weaponType: WeaponType.Melee, dir: { x: 0, y: 0, z: -1 },
    });
    expect(target.health).toBe(target.maxHealth);
  });

  it('aoe splash at a teammate\'s feet', () => {
    const { combat, target } = harness();
    combat.handleAOEShot('a1', {
      type: 'aoeShot',
      position: { x: 0, y: 9.5, z: -3 }, // inside the victim's capsule
      weaponType: WeaponType.Slam,
    });
    expect(target.health).toBe(target.maxHealth);
  });

  it('melee cone on a teammate', () => {
    const { combat, target } = harness();
    combat.handleAOEShot('a1', {
      type: 'aoeShot',
      position: { x: 0, y: 10, z: -3 },
      weaponType: WeaponType.Melee,
    });
    expect(target.health).toBe(target.maxHealth);
  });

  it('lightning beam tick on a teammate', () => {
    const { combat, target } = harness();
    combat.handleAOEShot('a1', {
      type: 'aoeShot',
      position: { x: 0, y: 10, z: -3 },
      weaponType: WeaponType.Lightning,
      excludeTargetId: 'a2',
    });
    expect(target.health).toBe(target.maxHealth);
  });

  it('bot shot on a teammate (server-authored)', () => {
    const { combat, target } = harness();
    combat.botAttack('a1', 'a2', WeaponType.Chaingun);
    expect(target.health).toBe(target.maxHealth);
  });

  it('mine blast under a teammate (server-authored)', () => {
    const { combat, target } = harness();
    combat.mineBlast('a1', { x: 0, y: 10, z: -3 }, 80, 8, 20);
    expect(target.health).toBe(target.maxHealth);
  });
});

describe('friendly fire — option on (FPS_FRIENDLY_FIRE)', () => {
  it('beam tick + aoe + mine all damage teammates when enabled', () => {
    const { combat, target } = harness(true);
    combat.handleAOEShot('a1', {
      type: 'aoeShot',
      position: { x: 0, y: 10.8, z: -3 },
      weaponType: WeaponType.Lightning,
      excludeTargetId: 'a2',
    });
    expect(target.health).toBeLessThan(target.maxHealth);

    const after1 = target.health;
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9.5, z: -3 },
      weaponType: WeaponType.Slam,
    });
    expect(target.health).toBeLessThan(after1);

    const after2 = target.health;
    combat.mineBlast('a1', { x: 0, y: 10, z: -3 }, 80, 8, 20);
    expect(target.health).toBeLessThan(after2);
  });

  it('self-splash pays blood (rocket jumps cost health)', () => {
    const { players, combat } = harness();
    const self = players.getPlayer('a1')!;
    // Self-propulsion pays blood on server truth for humans too — a
    // feet blast costs up to SELF_SPLASH_MAX (the client self-predicts
    // the rocket-jump impulse; server only owns the damage).
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9, z: 0 },
      weaponType: WeaponType.Slam,
    });
    expect(self.health).toBeLessThan(self.maxHealth);
  });
});
