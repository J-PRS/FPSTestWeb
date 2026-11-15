import { describe, it, expect } from 'bun:test';
import { WeaponType, BELT_MAX, beltThrowCost } from '../../../shared/weapons.ts';
import { hmHeight } from '../../../shared/heightfield.ts';
import { mkRoom, pin, twoPlayers, flat } from './harness.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

// Spear reclaim (stats.plants): a terrain/wall contact leaves a
// reclaimable corpse; the owner brushing the shaft pockets the belt
// charge back. The sweep is capsule-vs-shaft - walking ONTO the buried
// tip always reaches it.
const JAV = WeaponType.Javelin;
const COST = beltThrowCost(JAV);
const FLOOR = hmHeight(flat, 0, 0);

function planted(room: Room): Map<string, { pos: { x: number; y: number; z: number } }> {
  return (room.projectiles as unknown as { planted: Map<string, { pos: { x: number; y: number; z: number } }> }).planted;
}

function arm(): [Room, PlayerState] {
  const room = mkRoom({ bots: 2 }, 'tdm');
  const [a] = twoPlayers(room);
  pin(room, a.id, { x: 0, y: FLOOR + 2, z: 0 });
  a.beltCharges = 2;
  return [room, a];
}

describe('scenario: planted javelin reclaim', () => {
  it('a dirt hit plants the corpse instead of despawning it', () => {
    const [room, a] = arm();
    room.projectiles.spawn(a.id, JAV,
      { x: 5, y: FLOOR + 6, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) {room.projectiles.tick(0.05);}
    expect(planted(room).size).toBe(1);
  });

  it('walking onto the shaft refunds the belt charge', () => {
    const [room, a] = arm();
    room.projectiles.spawn(a.id, JAV,
      { x: 5, y: FLOOR + 6, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) {room.projectiles.tick(0.05);}
    const belt = a.beltCharges;
    // Stand on the buried tip - capsule overlaps the planted shaft.
    const p = [...planted(room).values()][0]!.pos;
    a.position = { x: p.x, y: p.y + 1.8, z: p.z };
    room.projectiles.tick(0.05);
    expect(planted(room).size).toBe(0);
    expect(a.beltCharges).toBe(Math.min(BELT_MAX, belt + COST));
  });

  it('a corpse past pickup reach does not refund', () => {
    const [room, a] = arm();
    room.projectiles.spawn(a.id, JAV,
      { x: 5, y: FLOOR + 6, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 20; i++) {room.projectiles.tick(0.05);}
    const belt = a.beltCharges;
    a.position = { x: 50, y: FLOOR + 2, z: 50 }; // across the arena
    room.projectiles.tick(0.05);
    expect(planted(room).size).toBe(1);
    expect(a.beltCharges).toBe(belt);
  });
});
