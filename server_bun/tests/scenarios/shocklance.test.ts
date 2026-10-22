import { describe, it, expect } from 'bun:test';
import { WeaponType, LANCE_RANGE, getWeaponStats } from '../../../shared/weapons.ts';
import { mkRoom, pin, twoPlayers, watch } from './harness.ts';

// Shocklance rides the beam intent path like Lightning: shotFired
// carries only aim, the room's honest ray names the contact, the flat
// lance damage pays once per cadence-gated cycle.
const LANCE = WeaponType.Shocklance;
type Room = ReturnType<typeof mkRoom>;
type Player = ReturnType<typeof twoPlayers>[number];

/** One zap — aim at the capsule's axis midpoint (position.y is the TOP,
 *  a flat ray sails over the head). */
function zap(room: Room, shooter: Player, victim: Player): void {
  const eye = { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z };
  const dir = {
    x: victim.position.x - eye.x,
    y: (victim.position.y - 0.9) - eye.y,
    z: victim.position.z - eye.z,
  };
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  room.messages.handleMessage(shooter.id, {
    type: 'shotFired', weaponType: LANCE,
    dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
  } as never);
}

describe('scenario: shocklance intent', () => {
  it('a zap inside lance reach pays the flat bolt damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 10, y: 31, z: 0 }); // well inside LANCE_RANGE
    const w = watch(room);
    const hp = b.health;
    zap(room, a, b);
    expect(b.health).toBeLessThanOrEqual(hp - getWeaponStats(LANCE).directDamage);
    expect(w.count('playerHit')).toBeGreaterThan(0);
  });

  it('a target beyond lance reach whiffs — no damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: LANCE_RANGE + 10, y: 31, z: 0 });
    const hp = b.health;
    zap(room, a, b);
    expect(b.health).toBeGreaterThanOrEqual(hp);
  });

  it('aiming away whiffs — no damage', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: -10, y: 31, z: 0 });
    const hp = b.health;
    room.messages.handleMessage(a.id, {
      type: 'shotFired', weaponType: LANCE, dir: { x: 1, y: 0, z: 0 }, // +x — victim sits at -x
    } as never);
    expect(b.health).toBeGreaterThanOrEqual(hp);
  });

  it('the cadence gate refuses a second zap inside the cycle window', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 10, y: 31, z: 0 });
    zap(room, a, b);
    const afterFirst = b.health;
    zap(room, a, b); // instant second press — held/echoed
    expect(b.health).toBe(afterFirst);
  });
});
