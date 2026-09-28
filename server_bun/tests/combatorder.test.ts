import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

// Unordered transports (WT/RTC datagram lanes) can deliver a projectile's
// destroy before the aoeShot it pairs with. The spent tombstone must keep
// that reordered claim resolvable — deleting it was the "blast with no
// known projectile" storm in the Sep-28 logs.

function harness() {
  const players = new PlayerManager();
  const sentTo: { id: string; msg: ServerMessage }[] = [];
  const combat = new CombatHandler(
    players,
    () => {},
    (id, msg) => sentTo.push({ id, msg }),
  );
  return { players, combat, sentTo };
}

const rejections = (sentTo: { id: string; msg: ServerMessage }[], id: string) =>
  sentTo.filter((m) => m.id === id && m.msg.type === 'shotRejected');

// Miss-branch shot registers the projectile server-side (assigns proj_N).
function spawnRocket(combat: CombatHandler, players: PlayerManager, id: string): string {
  const p = players.getPlayer(id)!;
  p.protectedUntil = 0;
  // The spawn sanity check compares the claimed muzzle to the shooter's
  // server-side position — park them at the muzzle we claim below.
  p.position = { x: 0, y: 10, z: 0 };
  combat.handleShot(id, {
    type: 'shot',
    targetId: null,
    position: { x: 0, y: 10, z: 0 },
    velocity: { x: 0, y: 0, z: -60 },
    weaponType: WeaponType.Rocket,
  });
  return 'proj_1';
}

describe('projectile claim ordering', () => {
  it('aoeShot resolves after a reordered projectileDestroy', () => {
    const { players, combat, sentTo } = harness();
    players.addPlayer('p1');
    const projId = spawnRocket(combat, players, 'p1');

    combat.handleProjectileDestroy('p1', { type: 'projectileDestroy', projectileId: projId });
    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 8, z: -3 },
      weaponType: WeaponType.Rocket,
      projectileId: projId,
      airtime: 0.05,
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
  });

  it('shot claim resolves after a reordered projectileDestroy', () => {
    const { players, combat, sentTo } = harness();
    players.addPlayer('p1');
    const target = players.addPlayer('p2');
    target.position = { x: 0, y: 8.5, z: -3 };
    target.protectedUntil = 0;
    const projId = spawnRocket(combat, players, 'p1');

    combat.handleProjectileDestroy('p1', { type: 'projectileDestroy', projectileId: projId });
    combat.handleShot('p1', {
      type: 'shot',
      targetId: 'p2',
      position: { x: 0, y: 8.5, z: -3 },
      velocity: { x: 0, y: 0, z: -60 },
      weaponType: WeaponType.Rocket,
      projectileId: projId,
      airtime: 0.05,
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('both claims of a direct-hit rocket survive a mid-flight destroy', () => {
    const { players, combat, sentTo } = harness();
    players.addPlayer('p1');
    const target = players.addPlayer('p2');
    target.position = { x: 0, y: 8.5, z: -3 };
    target.protectedUntil = 0;
    const projId = spawnRocket(combat, players, 'p1');

    // Worst order: destroy lands first, then both claims.
    combat.handleProjectileDestroy('p1', { type: 'projectileDestroy', projectileId: projId });
    combat.handleShot('p1', {
      type: 'shot',
      targetId: 'p2',
      position: { x: 0, y: 8.5, z: -3 },
      velocity: { x: 0, y: 0, z: -60 },
      weaponType: WeaponType.Rocket,
      projectileId: projId,
      airtime: 0.05,
    });
    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 8, z: -3 },
      weaponType: WeaponType.Rocket,
      projectileId: projId,
      airtime: 0.05,
    });

    expect(rejections(sentTo, 'p1')).toEqual([]);
  });

  it('destroy still rejects for someone else\'s projectile', () => {
    const { players, combat, sentTo } = harness();
    players.addPlayer('p1');
    players.addPlayer('p2');
    const projId = spawnRocket(combat, players, 'p1');

    // p2 tries to tombstone p1's live projectile — must not consume it.
    combat.handleProjectileDestroy('p2', { type: 'projectileDestroy', projectileId: projId });
    combat.handleAOEShot('p1', {
      type: 'aoeShot',
      position: { x: 0, y: 8, z: -3 },
      weaponType: WeaponType.Rocket,
      projectileId: projId,
      airtime: 0.05,
    });
    // p1's later claim still resolves — the bogus destroy was refused.
    expect(rejections(sentTo, 'p1')).toEqual([]);
  });
});
