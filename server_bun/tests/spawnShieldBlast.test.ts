import { simMs, simNow } from '../src/simClock.ts';
import { describe, it, expect } from 'bun:test';
import { CombatHandler } from '../src/CombatHandler.ts';
import { PlayerManager } from '../src/PlayerManager.ts';
import { WeaponType } from '../../shared/weapons.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { SPAWN_PROTECT_MS } from '../../shared/constants.ts';

/** Spawn shield vs blast: protection already dropped the damage, but the
 *  shove still launched the victim — an "invulnerable" player flying with
 *  zero feedback read as phantom wind. Shielded targets now take the hit
 *  (playerHit still broadcasts) without the impulse. */

function harness() {
  const players = new PlayerManager();
  const sentTo: { id: string; msg: ServerMessage }[] = [];
  const broadcast: ServerMessage[] = [];
  const combat = new CombatHandler(
    players,
    (msg) => broadcast.push(msg),
    (id, msg) => sentTo.push({ id, msg }),
    { teams: false },
  );
  const shooter = players.addPlayer('a1');
  shooter.position = { x: 0, y: 10, z: 0 };
  shooter.protectedUntil = simMs(0);
  const target = players.addPlayer('a2');
  target.position = { x: 0, y: 10, z: -3 };
  return { players, combat, sentTo, broadcast, target };
}

const speed = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('spawn shield — blast knockback', () => {
  it('protected victim is not shoved by an enemy slam', () => {
    const { combat, target } = harness();
    target.protectedUntil = simMs(simNow() + SPAWN_PROTECT_MS);
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9.5, z: -3 },
      weaponType: WeaponType.Slam,
    });
    expect(speed(target.velocity)).toBe(0);
    expect(target.health).toBe(target.maxHealth);
  });

  it('unprotected victim is shoved (guard does not suppress normal play)', () => {
    const { combat, target } = harness();
    target.protectedUntil = simMs(0);
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9.5, z: -3 },
      weaponType: WeaponType.Slam,
    });
    expect(speed(target.velocity)).toBeGreaterThan(0);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('the hit still registers for the shooter (playerHit broadcast)', () => {
    const { combat, sentTo, broadcast, target } = harness();
    target.protectedUntil = simMs(simNow() + SPAWN_PROTECT_MS);
    combat.handleAOEShot('a1', {
      type: 'aoeShot', position: { x: 0, y: 9.5, z: -3 },
      weaponType: WeaponType.Slam,
    });
    const msgs = [...broadcast, ...sentTo.map((m) => m.msg)];
    expect(msgs.some((m) => m.type === 'playerHit')).toBe(true);
  });

  it('mine blast under a protected victim: no launch', () => {
    const { combat, target } = harness();
    target.protectedUntil = simMs(simNow() + SPAWN_PROTECT_MS);
    combat.mineBlast('a1', { x: 0, y: 10, z: -3 }, 80, 8, 20);
    expect(speed(target.velocity)).toBe(0);
    expect(target.health).toBe(target.maxHealth);
  });
});
