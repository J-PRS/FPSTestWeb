import { describe, it, expect } from 'bun:test';
import { mkRoom, freeze, watch, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: class-locked ordnance', () => {
  it('a medium claiming a mortar shot is refused; the same claim as heavy goes through', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };

    const p = room.players.getPlayer(a.id)!;
    p.armorClass = 'medium';
    room.messages.handleMessage(a.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      pos: { x: 1, y: 32, z: 0 },
      weaponType: WeaponType.Mortar,
    } as never);
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(1);
    expect(w.count('projectileCreated')).toBe(0);

    p.armorClass = 'heavy';
    room.messages.handleMessage(a.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      pos: { x: 1, y: 32, z: 0 },
      weaponType: WeaponType.Mortar,
    } as never);
    expect(w.count('projectileCreated')).toBe(1);
  });

  it('medium-tier guns refuse on light AND heavy — exact-tier lock', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };

    const p = room.players.getPlayer(a.id)!;
    p.armorClass = 'light';
    for (const weaponType of [WeaponType.PlasmaGun, WeaponType.Flak]) {
      room.messages.handleMessage(a.id, {
        type: 'shotFired', dir: { x: 0, y: 0.3, z: 1 }, pos: { x: 1, y: 32, z: 0 }, weaponType,
      } as never);
    }
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(2);
    expect(w.count('projectileCreated')).toBe(0);

    // Exact-tier: the heavy doesn't get to shoulder the mid punch either.
    p.armorClass = 'heavy';
    for (const weaponType of [WeaponType.PlasmaGun, WeaponType.Flak]) {
      room.messages.handleMessage(a.id, {
        type: 'shotFired', dir: { x: 0, y: 0.3, z: 1 }, pos: { x: 1, y: 32, z: 0 }, weaponType,
      } as never);
    }
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(4);
    expect(w.count('projectileCreated')).toBe(0);

    p.armorClass = 'medium';
    for (const weaponType of [WeaponType.PlasmaGun, WeaponType.Flak]) {
      room.messages.handleMessage(a.id, {
        type: 'shotFired', dir: { x: 0, y: 0.3, z: 1 }, pos: { x: 1, y: 32, z: 0 }, weaponType,
      } as never);
    }
    // Flak is a burst fan — one intent spawns a pellet spread, so assert
    // per-weapon creation instead of a flat count of 2.
    for (const weaponType of [WeaponType.PlasmaGun, WeaponType.Flak]) {
      expect(w.msgs.filter((m) => m.type === 'projectileCreated' && (m as { weaponType?: number }).weaponType === weaponType).length).toBeGreaterThan(0);
    }
  });

  it('light-frame guns refuse on medium and heavy but fire on a light', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };
    const rejects = () => toA.filter((m) => m.type === 'shotRejected').length;

    const p = room.players.getPlayer(a.id)!;
    for (const cls of ['medium', 'heavy'] as const) {
      p.armorClass = cls;
      room.messages.handleMessage(a.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      pos: { x: 1, y: 32, z: 0 },
      weaponType: WeaponType.Railgun,
    } as never);
      // The LG beam intent hits the same class lock — refused either way.
      room.messages.handleMessage(a.id, {
        type: 'shotFired',
        dir: { x: 0, y: 0.3, z: 1 },
        weaponType: WeaponType.Lightning,
      });
    }
    expect(rejects()).toBe(4);
    expect(w.count('projectileCreated')).toBe(0);

    p.armorClass = 'light';
    room.messages.handleMessage(a.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      pos: { x: 1, y: 32, z: 0 },
      weaponType: WeaponType.Railgun,
    } as never);
    expect(rejects()).toBe(4);
    expect(w.count('projectileCreated')).toBe(1);
    room.messages.handleMessage(a.id, {
      type: 'shotFired',
      dir: { x: 0, y: 0.3, z: 1 },
      weaponType: WeaponType.Lightning,
    });
    expect(rejects()).toBe(4);
  });
});
