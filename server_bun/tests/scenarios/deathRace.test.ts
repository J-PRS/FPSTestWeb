import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, freeze } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import { wallNow } from '../../src/wallClock.ts';

/** The death race: a trigger pull fired BEFORE the death write must
 *  rule in (Tribes in-flight rule) - the reject only stands for pulls
 *  genuinely after death. fireAt rides the synced server clock. */
describe('shooter death race', () => {
  const setup = () => {
    const room = mkRoom({ bots: 2 });
    const w = watch(room);
    // Rejects ride sendToPlayer, not broadcast - spy the direct lane.
    const direct: { type: string }[] = [];
    const prev = room.connections.sendToPlayer?.bind(room.connections);
    room.connections.sendToPlayer = ((pid: string, m: { type: string }) => {
      direct.push(m);
      prev?.(pid, m as never);
    }) as never;
    const bots = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    const shooter = bots[0]!;
    freeze(room, shooter.id, { x: 0, y: 32, z: 0 });
    shooter.protectedUntil = 0 as never;
    return { room, w, shooter, direct };
  };

  it('a pull stamped before the death write spawns its shell', () => {
    const { room, w, shooter } = setup();
    const fireAt = wallNow();
    // Die AFTER the pull - the claim arrives post-death like the live race.
    room.players.applyDamage(shooter.id, 99999, 'environment');
    expect(shooter.isDead).toBe(true);
    room.messages.handleMessage(shooter.id, {
      type: 'shotFired', weaponType: WeaponType.Disc, dir: { x: 1, y: 0, z: 0 }, shotId: 'race-in', fireAt,
    } as never);
    expect(w.msgs.filter((m) => m.type === 'projectileCreated').length).toBeGreaterThan(0);
    expect(w.msgs.filter((m) => m.type === 'shotRejected').length).toBe(0);
  });

  it('a pull stamped after the death write is still rejected', () => {
    const { room, w, shooter, direct } = setup();
    room.players.applyDamage(shooter.id, 99999, 'environment');
    const fireAt = wallNow() + 50; // post-death pull - the breach the reject exists for
    room.messages.handleMessage(shooter.id, {
      type: 'shotFired', weaponType: WeaponType.Disc, dir: { x: 1, y: 0, z: 0 }, shotId: 'race-out', fireAt,
    } as never);
    expect(direct.filter((m) => m.type === 'shotRejected').length).toBeGreaterThan(0);
    expect(w.msgs.filter((m) => m.type === 'projectileCreated').length).toBe(0);
  });

  it('a missing fireAt on a dead shooter stays rejected', () => {
    const { room, w, shooter, direct } = setup();
    room.players.applyDamage(shooter.id, 99999, 'environment');
    room.messages.handleMessage(shooter.id, {
      type: 'shotFired', weaponType: WeaponType.Disc, dir: { x: 1, y: 0, z: 0 }, shotId: 'race-none',
    } as never);
    expect(direct.filter((m) => m.type === 'shotRejected').length).toBeGreaterThan(0);
  });
});
