import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, twoPlayers, watch } from './harness.ts';

// Melee rides the intent path: shotFired carries only aim, the server
// derives the arc point from the rewound origin — no position is
// claimed, so none can be forged.
describe('scenario: melee intent', () => {
  it('a shotFired swing damages a target inside the arc', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 2, y: 31, z: 0 });
    const w = watch(room);
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.health).toBeLessThan(hp);
    expect(w.count('playerHit')).toBeGreaterThan(0);
  });

  it('aiming away from the target whiffs — no damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: -2, y: 31, z: 0 });
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.health).toBeGreaterThanOrEqual(hp);
  });

  it('a target beyond fist reach whiffs — no damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 8, y: 31, z: 0 });
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: 10 /* Melee */, dir: { x: 1, y: 0, z: 0 },
    } as never);
    expect(b.health).toBeGreaterThanOrEqual(hp);
  });
});
