import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, pin } from './harness.ts';
import { hmHeight } from '../../../shared/heightfield.ts';

describe('scenario: dropped flag is a physical loose object', () => {
  function mkCarrierSetup() {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const w = watch(room);
    const carrier = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    const flag = room.flags!.flags.get('bravo')!;
    carrier.position = { ...flag.pos };
    room.tickFlags(0.05);
    expect(flag.carrier).toBe(carrier.id);
    return { room, w, carrier, flag };
  }

  it('a carrier killed mid-air drops the flag, which falls and rests on the ground', () => {
    const { room, carrier, flag } = mkCarrierSetup();
    pin(room, carrier.id, { x: 0, y: 45, z: 0 });
    carrier.velocity = { x: 10, y: 0, z: 0 };
    room.players.applyDamage(carrier.id, 500);
    room.flagCarrierDied(carrier.id);
    expect(flag.state).toBe('dropped');
    expect(flag.vel.y).toBeGreaterThan(0); // fumble pop, not a teleport
    for (let i = 0; i < 200 && (flag.vel.x || flag.vel.y || flag.vel.z); i++) room.tickFlags(0.05);
    expect(flag.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(flag.pos.y).toBeCloseTo(hmHeight(room.field!, flag.pos.x, flag.pos.z) + 0.5, 3);
    expect(flag.pos.y).toBeLessThan(40); // fell from the corpse height
  });

  it('a blast near a resting dropped flag punts it to a new rest spot', () => {
    const { room, w, carrier, flag } = mkCarrierSetup();
    pin(room, carrier.id, { x: 0, y: 31, z: 0 });
    room.players.applyDamage(carrier.id, 500);
    room.flagCarrierDied(carrier.id);
    for (let i = 0; i < 200 && (flag.vel.x || flag.vel.y || flag.vel.z); i++) room.tickFlags(0.05);
    const atRest = { ...flag.pos };
    const updatesBefore = w.count('flagUpdate');
    room.flags!.knock({ x: flag.pos.x + 1, y: flag.pos.y, z: flag.pos.z }, 8, 40);
    expect(flag.vel.x).toBeLessThan(0); // pushed away from the blast
    for (let i = 0; i < 200 && (flag.vel.x || flag.vel.y || flag.vel.z); i++) room.tickFlags(0.05);
    expect(flag.state).toBe('dropped');
    expect(Math.hypot(flag.pos.x - atRest.x, flag.pos.z - atRest.z)).toBeGreaterThan(0.5);
    expect(w.count('flagUpdate')).toBeGreaterThan(updatesBefore); // flight streamed
  });
});
