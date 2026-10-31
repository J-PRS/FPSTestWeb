import { describe, expect, it } from 'bun:test';
import { mkRoom, pin } from './harness.ts';
import { wallNow, type WallMs } from '../../src/wallClock.ts';
import { WIRE_E_SHOT } from '../../../shared/wire.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { Room } from '../../src/Room.ts';

// Arrival-time muzzle relay: stamped, cosmetic-path intents flash to
// observers when the claim LANDS, not when the next tick drains. The
// drain must skip its own re-emit (shotId dedupe) or observers see a
// double muzzle.

const countShotFrames = (room: Room): (() => number) => {
  let n = 0;
  const prev = room.connections.broadcastBinaryReliable.bind(room.connections);
  room.connections.broadcastBinaryReliable = (data: Uint8Array, ...rest: unknown[]) => {
    if (data[1] === WIRE_E_SHOT) {n++;}
    return (prev as (...a: unknown[]) => unknown)(data, ...rest) as never;
  };
  return () => n;
};

const setup = (): Room => {
  const room = mkRoom({}, 'dm');
  room.players.addPlayer('p1', 'alpha', 'none', 'medium');
  room.wireIds.set('p1', 7);
  pin(room, 'p1', { x: 0, y: 30, z: 0 });
  return room;
};

const dir = { x: 0, y: 0, z: 1 };

describe('early muzzle relay', () => {
  it('a stamped cosmetic shot flashes at arrival, once', () => {
    const room = setup();
    const shots = countShotFrames(room);
    room.earlyShotRelay('p1', { shotId: 's1', weaponType: WeaponType.Melee, dir });
    expect(shots()).toBe(1);
    // The drain must not re-emit: same shotId already flashed.
    room.commands.push({ playerId: 'p1', msg: { type: 'shotFired', weaponType: WeaponType.Melee, pos: { x: 0, y: 30, z: 0 }, dir, shotId: 's1', fireAt: wallNow() } as never, at: wallNow() as WallMs });
    room.drainCommands();
    expect(shots()).toBe(1);
  });

  it('an unstamped claim relays at drain, not arrival', () => {
    const room = setup();
    const shots = countShotFrames(room);
    room.earlyShotRelay('p1', { weaponType: WeaponType.Melee, dir });
    expect(shots()).toBe(0);
    room.commands.push({ playerId: 'p1', msg: { type: 'shotFired', weaponType: WeaponType.Melee, pos: { x: 0, y: 30, z: 0 }, dir, fireAt: wallNow() } as never, at: wallNow() as WallMs });
    room.drainCommands();
    expect(shots()).toBe(1);
  });

  it('a server-simmed weapon does not early flash — its shell is the relay', () => {
    const room = setup();
    const shots = countShotFrames(room);
    room.earlyShotRelay('p1', { shotId: 's2', weaponType: WeaponType.Disc, dir });
    expect(shots()).toBe(0);
  });

  it('a dead shooter does not early flash', () => {
    const room = setup();
    const shots = countShotFrames(room);
    room.players.getPlayer('p1')!.isDead = true;
    room.earlyShotRelay('p1', { shotId: 's3', weaponType: WeaponType.Melee, dir });
    expect(shots()).toBe(0);
  });
});
