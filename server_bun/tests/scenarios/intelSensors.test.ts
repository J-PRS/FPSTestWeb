import { describe, expect, it } from 'bun:test';
import { mkRoom, pin, step } from './harness.ts';
import { STATUS } from '../../../shared/status.ts';
import type { Room } from '../../src/Room.ts';

// Deployable intel gear: the motion sensor reads MOVEMENT (no LOS, sees
// through cloak - a still body is dark), the jammer bubble hides its
// side from the pulse mast only. Both feed/assert through the shared
// intel table, so "detected" means a teammate's IFF actually carries it.

const has = (room: Room, viewer: string, target: string) =>
  room.intel.contactsFor(viewer).some((c) => c.id === target);

describe('scenario: motion sensor', () => {
  it('marks a moving hostile through a wall and cloak - stillness is dark', () => {
    // Wall x in [9,11] blocks every personal-LOS line to the foe; only
    // the motion sensor (which needs no LOS) can light him up.
    const room = mkRoom({
      structures: [{ kind: 'box', pos: { x: 10, y: 25, z: 0 }, size: { x: 2, y: 30, z: 40 } }],
    }, 'tdm');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    room.players.addPlayer('mate', 'alpha', 'none', 'medium');
    room.players.addPlayer('foe', 'bravo', 'none', 'medium');
    pin(room, 'engi', { x: 0, y: 30, z: 0 });
    pin(room, 'mate', { x: 0, y: 30, z: 10 });
    room.moveSim.track('foe', { x: 20, y: 30, z: 0 }, 0, 'none', 'bravo');
    pin(room, 'foe', { x: 20, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'motion', { x: 5, y: 30, z: 3 })).toBe(true);
    step(room, 60); // arm + two scans - foe stands still the whole time
    expect(has(room, 'mate', 'foe')).toBe(false);
    // Walking = detected, wall and all. The scan cadence is 1.5s - step
    // far enough to cross the next sweep, not just a few ticks.
    room.moveSim.setInput('foe', { forward: 1 });
    step(room, 45);
    expect(has(room, 'mate', 'foe')).toBe(true);
    // Cloaked but moving - motion reads movement, not light.
    room.players.getPlayer('foe')!.status |= STATUS.CLOAK;
    step(room, 45);
    expect(has(room, 'mate', 'foe')).toBe(true);
  });
});

describe('scenario: jammer', () => {
  it('bubble hides its side from the pulse mast - eyeballs unaffected', () => {
    const room = mkRoom({}, 'tdm');
    // Bravo observer parked past SIGHT_M so only the mast feed can mark
    // alpha players for him.
    room.players.addPlayer('eye', 'bravo', 'none', 'medium');
    room.players.addPlayer('engi', 'alpha', 'none', 'medium');
    room.players.addPlayer('jam', 'alpha', 'none', 'medium');
    room.players.addPlayer('free', 'alpha', 'none', 'medium');
    pin(room, 'eye', { x: 400, y: 30, z: 0 });
    pin(room, 'engi', { x: 0, y: 30, z: -8 });
    pin(room, 'jam', { x: 10, y: 30, z: 0 });
    pin(room, 'free', { x: 40, y: 30, z: 0 });
    room.players.getPlayer('engi')!.beltCharges = 10;
    expect(room.deployables.handleDeploy('engi', 'jammer', { x: 10, y: 30, z: -2 })).toBe(true);
    step(room, 30); // jammer armed before the mast ever scans
    // Fabricated base mast - cap-0 kinds can't be player-planted. It
    // joins AFTER the arm window so its first sweep already reads live.
    (room.deployables.items as Map<number, unknown>).set(999, {
      id: 999, owner: 'eye', kind: 'sensor',
      pos: { x: 0, y: 30, z: 0 }, ttl: 0, fireCd: 0, base: true,
      hp: 120, armor: 0, respawnT: 0, team: 'bravo',
    });
    step(room, 60); // mast scans
    expect(has(room, 'eye', 'free')).toBe(true);   // outside the bubble - marked
    expect(has(room, 'eye', 'jam')).toBe(false);   // inside - pulse can't see him
    expect(has(room, 'eye', 'engi')).toBe(false);  // planter inside his own bubble too
  });
});
