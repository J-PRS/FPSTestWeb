import { describe, it, expect } from 'bun:test';
import { mkRoom, freeze, watch, twoPlayers, step } from './harness.ts';
import { WeaponType, WEAPONS } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Bombard — the heavy's non-explosive siege slug. The contract that makes
// it NOT just a fat rocket: body contact pays the biggest direct line in
// the game, while ANY other contact crumbles into real shrapnel — a
// radial shard sweep bounded far under the direct hit (no dome, no
// mortar-style blast).
describe('scenario: bombard', () => {
  it('a medium cannot shoulder it; a heavy can', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 62, z: 0 });
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };

    const p = room.players.getPlayer(a.id)!;
    p.armorClass = 'medium';
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 62, z: 0 },
      weaponType: WeaponType.Bombard,
    } as never);
    expect(toA.filter((m) => m.type === 'shotRejected').length).toBe(1);
    expect(w.count('projectileCreated')).toBe(0);

    p.armorClass = 'heavy';
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 62, z: 0 },
      weaponType: WeaponType.Bombard,
    } as never);
    expect(w.count('projectileCreated')).toBe(1);
  });

  it('direct hit pays the biggest gun-fired damage line in the game', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    const pb = room.players.getPlayer(b.id)!;
    // Stand the target on flat ground (heightfield is 60) and shoot
    // through the capsule axis — medium body, eye at 62, center ~61.1.
    freeze(room, a.id, { x: 0, y: 61.1, z: 0 });
    freeze(room, b.id, { x: 10, y: 62, z: 0 });
    room.players.getPlayer(a.id)!.armorClass = 'heavy';
    // Seed a pool deep enough to expose the whole line — a stock light's
    // 125hp floor would clip the delta at the pool, not the damage.
    pb.maxHealth = pb.health = 200;
    const hp0 = pb.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 61.1, z: 0 },
      weaponType: WeaponType.Bombard,
    } as never);
    step(room, 30); // ~1.4s of flight at 100 m/s over 10m — contact lands fast
    expect(w.count('projectileCreated')).toBe(1);
    // 140 is above a light's whole pool — dead or near-dead either way,
    // but the ledger must show the FULL line (a clipped/flat payout is a bug).
    expect(hp0 - pb.health).toBeGreaterThanOrEqual(WEAPONS[WeaponType.Bombard]!.directDamage - 0.001);
  });

  it('terrain contact crumbles into shrapnel — bounded splash, no dome', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    const pb = room.players.getPlayer(b.id)!;
    // The slug carries ~95m before dirt contact — firing from x=-80 puts
    // the crumble point next to a bystander standing just off the line,
    // inside the shard sweep but far from any direct contact.
    freeze(room, a.id, { x: -80, y: 62, z: 0 });
    freeze(room, b.id, { x: 18, y: 29, z: 3 });
    room.players.getPlayer(a.id)!.armorClass = 'heavy';
    const hp0 = pb.health;
    // knockback rides sendToPlayer, not broadcast — intercept like the
    // class-lock test above.
    const toB: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === b.id) toB.push(m); else origSend(pid, m); };
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: -0.2, z: 0 }, pos: { x: -80, y: 62, z: 0 },
      weaponType: WeaponType.Bombard,
    } as never);
    step(room, 60); // the shell arcs down ~15m and dies on dirt
    expect(w.count('projectileCreated')).toBe(1);
    expect(w.count('projectileDestroyed')).toBeGreaterThanOrEqual(1); // the 'gone' edge fired
    // Shrapnel: paid something, bounded by the direct line — eating every
    // shard can at most equal ball-meets-body, never exceed it.
    const dealt = hp0 - pb.health;
    expect(dealt).toBeGreaterThan(0);
    expect(dealt).toBeLessThanOrEqual(WEAPONS[WeaponType.Bombard]!.directDamage + 0.001);
    expect(toB.filter((m) => m.type === 'knockback').length).toBeGreaterThanOrEqual(1);
  });
});
