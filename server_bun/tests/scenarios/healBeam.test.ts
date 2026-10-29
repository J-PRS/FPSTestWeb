import { describe, it, expect } from 'bun:test';
import { WeaponType, HEALBEAM_PER_TICK, HEALBEAM_ENERGY, HEALBEAM_RANGE } from '../../../shared/weapons.ts';
import { mkRoom, pin, twoPlayers } from './harness.ts';

// Heal beam rides the beam intent path like Lightning/Repair: shotFired
// carries only aim, the room's honest ray names the contact, and when
// it's a teammate healPool pays the tick — the shooter's jet tank is
// the ammo. Enemies and non-contacts pay nothing.
const HB = WeaponType.HealBeam;
type Room = ReturnType<typeof mkRoom>;
type Player = ReturnType<typeof twoPlayers>[number];

function zap(room: Room, shooter: Player, victim: Player): void {
  const eye = { x: shooter.position.x, y: shooter.position.y, z: shooter.position.z };
  const dir = {
    x: victim.position.x - eye.x,
    y: (victim.position.y - 0.9) - eye.y,
    z: victim.position.z - eye.z,
  };
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  room.messages.handleMessage(shooter.id, {
    type: 'shotFired', weaponType: HB,
    dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len },
  } as never);
}

describe('scenario: heal beam intent', () => {
  it('a teammate in reach heals + the shooter pays jet energy', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const [a, b] = twoPlayers(room);
    a.team = 'alpha'; b.team = 'alpha'; // split-roster default — pin same side
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 10, y: 31, z: 0 }); // well inside HEALBEAM_RANGE
    b.health = 40;
    const tank = room.moveSim.energyOf(a.id) ?? 0;
    zap(room, a, b);
    expect(b.health).toBe(40 + HEALBEAM_PER_TICK);
    expect(room.moveSim.energyOf(a.id) ?? 0).toBe(tank - HEALBEAM_ENERGY);
  });

  it('an enemy contact pays nothing — the beam stops on the body it pinned', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const [a, b] = twoPlayers(room);
    a.team = 'alpha'; b.team = 'bravo';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 10, y: 31, z: 0 });
    b.health = 40;
    zap(room, a, b);
    expect(b.health).toBe(40);
  });

  it('a patient out of reach heals nothing', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const [a, b] = twoPlayers(room);
    a.team = 'alpha'; b.team = 'alpha';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: HEALBEAM_RANGE + 10, y: 31, z: 0 });
    b.health = 40;
    zap(room, a, b);
    expect(b.health).toBe(40);
  });

  it('a dry tank refuses the tick — no energy, no heal', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const [a, b] = twoPlayers(room);
    a.team = 'alpha'; b.team = 'alpha';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 10, y: 31, z: 0 });
    b.health = 40;
    room.moveSim.drainEnergy(a.id, 1e9); // burn the whole tank
    zap(room, a, b);
    expect(b.health).toBe(40);
  });
});
