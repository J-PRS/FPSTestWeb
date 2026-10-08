import { wallMs } from '../../src/wallClock.ts';
import { describe, expect, it } from 'bun:test';
import { TickLoop } from '../../src/TickLoop.ts';
import { mkRoom } from './harness.ts';

// Fault containment: a room that throws every tick must not take the
// process or its neighbors down — 10 consecutive failures quarantine it,
// its humans are ejected through the normal removal funnel, and the name
// frees for a fresh instance.
describe('room quarantine', () => {
  const ops = () => ({ tickLagMsMax: 0, tickLagMsSum: 0, tickLagSamples: 0, lastTickAt: 0 });

  it('a room whose sim throws every tick drains at 10 and frees its name', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('victim');
    // A sim that detonates each tick — the realistic shape of a room
    // gone bad (spec data, corrupt state), not a one-off exception.
    room.sims.push({ name: 'bang', tick() { throw new Error('boom'); } });
    const removed: string[] = [];
    const rooms = new Map([['t', room]]);
    const loop = new TickLoop(rooms, ops(), (_room, id, reason) => { removed.push(`${id}:${reason}`); });

    for (let i = 0; i < 9; i++) loop.tickRoomGuarded(room, wallMs(Date.now() + i * 50));
    expect(rooms.has('t')).toBe(true);   // streak below threshold: still hosted
    expect(removed.length).toBe(0);

    loop.tickRoomGuarded(room, wallMs(Date.now() + 500)); // the 10th consecutive failure
    expect(loop.quarantinedRooms()).toContain('t');
    expect(removed).toContain('victim:quarantine');
    expect(rooms.has('t')).toBe(false);   // name freed for a live instance
  });

  it('a healthy neighbor keeps ticking while the sick room burns', () => {
    const sick = mkRoom({ bots: 0 });
    sick.players.addPlayer('victim');
    sick.sims.push({ name: 'bang', tick() { throw new Error('boom'); } });
    const well = mkRoom({ bots: 0 });
    well.players.addPlayer('tenant');
    // mkRoom names every room 't'; the streak map is name-keyed, so a
    // same-named healthy neighbor would erase the sick one's streak on
    // every good tick (prod can't collide — the map key IS the name).
    (well as { name: string }).name = 'well';
    const rooms = new Map([['t', sick], ['well', well]]);
    const loop = new TickLoop(rooms, ops(), () => {});
    for (let i = 0; i < 12; i++) {
      loop.tickRoomGuarded(sick, wallMs(Date.now() + i * 50));
      loop.tickRoomGuarded(well, wallMs(Date.now() + i * 50));
    }
    expect(rooms.has('t')).toBe(false);
    expect(rooms.get('well')).toBe(well); // untouched, still simulating
    expect(well.players.getPlayer('tenant')).toBeTruthy();
  });

  it('a transient failure resets the streak — 9 throws then a good tick survives', () => {
    const room = mkRoom({ bots: 0 });
    room.players.addPlayer('victim');
    let armed = true;
    room.sims.push({ name: 'bang', tick() { if (armed) throw new Error('boom'); } });
    const rooms = new Map([['t', room]]);
    const loop = new TickLoop(rooms, ops(), () => {});
    for (let i = 0; i < 9; i++) loop.tickRoomGuarded(room, wallMs(Date.now() + i * 50));
    armed = false; // root cause clears — the room should live on
    for (let i = 9; i < 20; i++) loop.tickRoomGuarded(room, wallMs(Date.now() + i * 50));
    expect(loop.quarantinedRooms().length).toBe(0);
    expect(rooms.has('t')).toBe(true);
  });
});
