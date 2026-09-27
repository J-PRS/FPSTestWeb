import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { FLAG_RESET_S } from '../../shared/teams.ts';

const CTF_SPEC = resolveMapSpec({
  mode: 'ctf',
  bases: { alpha: { x: -70, y: 0, z: 0 }, bravo: { x: 70, y: 0, z: 0 } },
});

function ctfRoom() {
  return new Room('t', null, '', CTF_SPEC); // no field — spec y stands
}

function addAt(room: Room, id: string, team: 'alpha' | 'bravo', x: number, z = 0) {
  const p = room.players.addPlayer(id);
  p.team = team;
  p.position = { x, y: 0, z };
  return p;
}

describe('RoomFlags', () => {
  it('only exists when mode has flags AND map has bases', () => {
    expect(ctfRoom().flags).not.toBeNull();
    expect(new Room('n', null, '', resolveMapSpec({ mode: 'nuggets' })).flags).toBeNull();
    expect(new Room('m', null, '', resolveMapSpec({ mode: 'ctf' })).flags).toBeNull();
  });

  it('enemy touching a home flag picks it up', () => {
    const room = ctfRoom();
    addAt(room, 'p1', 'alpha', 70, 0); // on bravo's flag
    room.tickFlags(0.05);
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('carried');
    expect(bravo.carrier).toBe('p1');
  });

  it('carrier reaching own base captures and scores', () => {
    const room = ctfRoom();
    const p = addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05); // grab
    p.position = { x: -70, y: 0, z: 0 }; // home ring
    room.tickFlags(0.05);
    expect(room.scores.alpha).toBe(1);
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('home');
  });

  it('death drops the flag where the carrier fell', () => {
    const room = ctfRoom();
    const p = addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05);
    p.position = { x: 30, y: 0, z: 0 };
    room.flagCarrierDied('p1');
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('dropped');
    expect(bravo.pos.x).toBe(30);
    expect(bravo.carrier).toBeNull();
  });

  it('carrier leaving the room drops the flag', () => {
    const room = ctfRoom();
    addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05);
    room.removePlayerCompletely('p1', 'test', () => {});
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('dropped');
    expect(bravo.carrier).toBeNull();
  });

  it('own team touching a dropped flag returns it home', () => {
    const room = ctfRoom();
    const carrier = addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05);
    carrier.position = { x: 30, y: 0, z: 0 }; // ran the flag to mid-field
    carrier.isDead = true;               // corpse doesn't re-grab
    room.flagCarrierDied('p1');          // bravo's flag drops at x=30
    addAt(room, 'p2', 'bravo', 30, 0);   // bravo defender walks over it
    room.tickFlags(0.05);
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('home');
    expect(bravo.pos.x).toBe(70);
  });

  it('dropped flag walks home after FLAG_RESET_S', () => {
    const room = ctfRoom();
    const carrier = addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05);
    carrier.isDead = true;
    room.flagCarrierDied('p1');
    carrier.position = { x: -60, y: 0, z: 0 }; // away from the drop
    // tick past the reset window (dt must survive whole-second steps)
    for (let t = 0; t < FLAG_RESET_S + 1; t += 0.5) room.flags!.tick(0.5);
    const bravo = room.flags!.snapshot().find((f) => f.team === 'bravo')!;
    expect(bravo.state).toBe('home');
  });

  it('resets both flags on match restart', () => {
    const room = ctfRoom();
    const p = addAt(room, 'p1', 'alpha', 70, 0);
    room.tickFlags(0.05);
    room.flags!.reset();
    for (const f of room.flags!.snapshot()) {
      expect(f.state).toBe('home');
      expect(f.carrier).toBeNull();
    }
    void p;
  });
});
