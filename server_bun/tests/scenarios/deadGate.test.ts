import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, freeze, twoPlayers, step } from './harness.ts';

describe('scenario: dead-sender gate', () => {
  it('shots, teleports, and input from a dead player are all dropped', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 60, y: 31, z: 60 });
    a.isDead = true;
    const hpB = b.health;
    const lastValid = { ...a.lastValidPosition! };

    room.messages.handleMessage(a.id, {
      type: 'shot', seq: 1,
      position: { x: b.position.x, y: b.position.y, z: b.position.z },
      velocity: { x: 0, y: 0, z: 0 },
      weaponType: 1, claimedWeaponIndex: 1,
    } as never);
    room.messages.handleMessage(a.id, { type: 'teleport', position: { x: 99, y: 31, z: 99 }, velocity: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 } });
    room.moveSim.track(a.id, a.position, 0, a.perk);
    room.messages.handleMessage(a.id, {
      type: 'inputMove', seq: 1,
      input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 4 },
    });
    step(room, 10);

    expect(b.health).toBe(hpB); // no ghost bullets
    expect(a.lastValidPosition).toEqual(lastValid); // no ghost warps
    expect(a.status & 4).toBe(0); // no ghost cloak either
    expect(a.skiing).toBe(0);
  });
});
