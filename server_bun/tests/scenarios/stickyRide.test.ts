import { describe, it, expect } from 'bun:test';
import { mkRoom, freeze, watch, twoPlayers, step } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Belt-sticky combo (Painkiller stake+nade): lob the belt sticky, then
// shoot a shell THROUGH it — the sticky is swallowed dead-center, rides
// the host, and pops at the host's contact point. The wire edge is
// 'projRide'; replicas parent the same pair.
describe('scenario: belt sticky rides a shell', () => {
  it('a same-owner shell catches the lobbed sticky and both pop at contact', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a, b] = twoPlayers(room);
    // Flat ground at y=60; victim stands 30m out, capsule center ~61.1.
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    freeze(room, b.id, { x: 30, y: 60, z: 0 });
    const pb = room.players.getPlayer(b.id)!;
    const pa = room.players.getPlayer(a.id)!;
    const hp0 = pb.health;
    const belt0 = pa.beltCharges;

    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 60, z: 0 },
      weaponType: WeaponType.BeltSticky,
    } as never);
    // Belt toss pays its nugget — the shared-Sticky type used to make
    // throws unchargeable server-side.
    expect(pa.beltCharges).toBe(belt0 - 1);

    step(room, 2); // sticky ~0.5m out, still hanging
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 60, z: 0 },
      weaponType: WeaponType.Disc,
    } as never);

    step(room, 40); // catch ~0.15s in; contact on the victim shortly after
    expect(w.count('projRide')).toBe(1);
    const gones = w.msgs.filter((m): m is Extract<ServerMessage, { type: 'projectileDestroyed' }> => m.type === 'projectileDestroyed');
    expect(gones.length).toBeGreaterThanOrEqual(2);
    // Rider pops AT the host's contact point — the gone edges share a spot.
    const [g1, g2] = gones.slice(-2);
    if (g1.position && g2.position) {
      const d = Math.hypot(g1.position.x - g2.position.x, g1.position.y - g2.position.y, g1.position.z - g2.position.z);
      expect(d).toBeLessThan(1);
    }
    // The victim eats disc direct + the riding sticky's blast — more
    // than a bare disc could pay.
    expect(hp0 - pb.health).toBeGreaterThan(50);
  });

  it('an uncaught sticky just sticks — no phantom rides', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    const pa = room.players.getPlayer(a.id)!;
    const belt0 = pa.beltCharges;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0.3, z: 0 }, pos: { x: 0, y: 60, z: 0 },
      weaponType: WeaponType.BeltSticky,
    } as never);
    step(room, 40); // lands, glues, fuse burns
    expect(w.count('projRide')).toBe(0);
    // Belt toss pays its nugget — the type split is what makes the
    // charge enforceable.
    expect(pa.beltCharges).toBe(belt0 - 1);
  });

  it('a chaingun slug can NOT host — too fast, too weak', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 60, z: 0 });
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 60, z: 0 },
      weaponType: WeaponType.BeltSticky,
    } as never);
    step(room, 2);
    room.messages.handleMessage(a.id, {
      type: 'shotFired', dir: { x: 1, y: 0, z: 0 }, pos: { x: 0, y: 60, z: 0 },
      weaponType: WeaponType.Chaingun,
    } as never);
    step(room, 20);
    // 250 m/s slug sweeps the hanging lob every step — if cadence/damage
    // didn't gate, it would catch on the first tick.
    expect(w.count('projRide')).toBe(0);
  });
});
