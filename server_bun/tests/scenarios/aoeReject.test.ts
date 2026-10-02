import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: aoeShot validation', () => {
  it('a blast claim naming no real projectile is refused — no splash, no damage', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };
    const hpBefore = room.players.getPlayer(b.id)!.health;

    // A never fired — but claims a rocket detonated right at B's feet.
    // The claim first defers (its spawn could be in flight on an
    // unordered transport); each new claim flushes retries, and with no
    // spawn ever registering it exhausts into a reject.
    const forged = {
      type: 'aoeShot',
      position: { x: 30, y: 31, z: 0 },
      weaponType: WeaponType.BoltLauncher,
      projectileId: null,
      airtime: 0.5,
    } as Extract<ClientMessage, { type: 'aoeShot' }>;
    for (let i = 0; i < 6; i++) room.messages.handleMessage(a.id, forged);
    step(room, 5);
    expect(w.count('playerHit')).toBe(0);
    expect(room.players.getPlayer(b.id)!.health).toBe(hpBefore);
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBeGreaterThanOrEqual(1);
  });

  it('a blast claim that beats its spawn registration resolves on flush — the unordered-transport reorder case', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    freeze(room, b.id, { x: 30, y: 31, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };
    const hpBefore = room.players.getPlayer(b.id)!.health;

    // Reordered pair: the detonation claim lands BEFORE the spawn claim
    // (datagram lanes guarantee neither order nor pairing). The blast is
    // deferred, not refused — the spawn registers it a moment later.
    room.messages.handleMessage(a.id, {
      type: 'aoeShot',
      position: { x: 30, y: 31, z: 0 },
      weaponType: WeaponType.BoltLauncher,
      projectileId: null,
      shotId: 's1',
      airtime: 0.34,
    } as Extract<ClientMessage, { type: 'aoeShot' }>);
    expect(w.count('playerHit')).toBe(0);

    room.messages.handleMessage(a.id, {
      type: 'shot', targetId: null, weaponType: WeaponType.BoltLauncher,
      position: { x: 0, y: 32.6, z: 0 }, velocity: { x: 90, y: 0, z: 0 },
      shotId: 's1',
    } as never);

    expect(w.count('playerHit')).toBe(1);
    expect(room.players.getPlayer(b.id)!.health).toBeLessThan(hpBefore);
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(0);
  });
});
