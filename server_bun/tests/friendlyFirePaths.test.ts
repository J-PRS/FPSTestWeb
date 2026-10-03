import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

/** AOE claims only resolve against a live projectile — spawn the rocket
 *  first (miss-branch shot registers proj_N server-side). */
function spawnProj(combat: CombatHandler, id: string): void {
  combat.handleShot(id, {
    type: 'shot', targetId: null,
    position: { x: 0, y: 10, z: 0 }, velocity: { x: 0, y: 0, z: -60 },
    weaponType: WeaponType.BoltLauncher,
  });
}

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
  shooter.protectedUntil = 0;
  const target = players.addPlayer('a2', 'alpha');
  target.position = { x: 0, y: 10, z: -3 };
  target.protectedUntil = 0;
  return { players, combat, sentTo, target };
}

describe('friendly fire — damage paths', () => {
  it('hitscan shot claim on a teammate', () => {
    const { combat, target } = harness();
    spawnProj(combat, 'a1'); // hit claims pair with a live projectile
    combat.handleShot('a1', {
      type: 'shot', targetId: 'a2',
      position: { x: 0, y: 10, z: -3 }, velocity: { x: 0, y: 0, z: -60 },
      weaponType: WeaponType.Chaingun, projectileId: 'proj_1', airtime: 0.05,
    });
    expect(target.health).toBe(target.maxHealth);
  });

  it('aoe splash at a teammate\'s feet', () => {
    const { combat, target } = harness();
    spawnProj(combat, 'a1');
    combat.handleAOEShot('a1', {
      type: 'aoeShot',
      position: { x: 0, y: 9.5, z: -3 }, // inside the victim's capsule
      weaponType: WeaponType.BoltLauncher,
      projectileId: 'proj_1',
      airtime: 0.05,
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
  it('hitscan + aoe + mine all damage teammates when enabled', () => {
    const { combat, target } = harness(true);
    spawnProj(combat, 'a1');
    combat.handleShot('a1', {
      type: 'shot', targetId: 'a2',
      position: { x: 0, y: 10, z: -3 }, velocity: { x: 0, y: 0, z: -60 },
      weaponType: WeaponType.Chaingun, projectileId: 'proj_1', airtime: 0.05,
    });
    expect(target.health).toBeLessThan(target.maxHealth);

    const after1 = target.health;
    spawnProj(combat, 'a1');
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9.5, z: -3 },
      weaponType: WeaponType.BoltLauncher, projectileId: 'proj_1', airtime: 0.05,
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
    spawnProj(combat, 'a1');
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9, z: 0 },
      weaponType: WeaponType.BoltLauncher, projectileId: 'proj_1', airtime: 0.05,
    });
    expect(self.health).toBeLessThan(self.maxHealth);
  });
});
