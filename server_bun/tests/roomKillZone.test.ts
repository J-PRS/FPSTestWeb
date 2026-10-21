import { describe, expect, test } from 'bun:test';
import { Room } from '../src/Room';
import { resolveMapSpec } from '../../shared/mapSpec';
import type { Heightfield } from '../../shared/heightfield.ts';

const flat: Heightfield = { size: 2, data: new Uint8Array(4), stride: 1 };

describe('room kill zone', () => {
  test('applySpec moves the player kill plane with the swapped spec', () => {
    // Start with a plane below the ground: nothing dies.
    const room = new Room('kz', flat, '', resolveMapSpec({ killY: -100 }));
    let kills = 0;
    room.moveSim.onKillZone = (): void => { kills += 1; };
    room.players.addPlayer('p1');
    // Airborne: the kill check runs in the integrator branch, and a body
    // resting on the ground is parked (see the resting gate in tick).
    room.moveSim.track('p1', { x: 0, y: 50, z: 0 }, 0);
    for (let i = 0; i < 10; i++) {room.moveSim.tick(0.05);}
    expect(kills).toBe(0);

    // Swap the spec to a plane above the body: the same body must now die.
    // Before the fix applySpec never touched the move sim, so a room swapped
    // into a sky arena kept no kill plane at all.
    room.applySpec(resolveMapSpec({ killY: 999 }));
    for (let i = 0; i < 10; i++) {room.moveSim.tick(0.05);}
    expect(kills).toBeGreaterThan(0);
  });
});
