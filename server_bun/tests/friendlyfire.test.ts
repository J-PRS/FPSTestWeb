import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { WeaponType } from '../../shared/weapons.ts';
import { CONFIG } from '../src/config.ts';

const TEAM_SPEC = resolveMapSpec({ mode: 'nuggets' });
const FFA_SPEC = resolveMapSpec({ mode: 'dm' });

function addAt(room: Room, id: string, team: 'alpha' | 'bravo' | undefined, x: number) {
  const p = room.players.addPlayer(id, team);
  p.position = { x, y: 0, z: 0 };
  p.protectedUntil = 0; // spawn protection would mask the damage we're testing
  return p;
}

// botFire(hit=true) routes straight into CombatHandler.botAttack — the same
// damage funnel shot/aoeShot claims end in, without needing a projectile.
const hit = (room: Room, shooter: string, target: string) =>
  room.messages.botFire(shooter, target, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, WeaponType.Bolt, true);

describe('friendly fire', () => {
  it('team rooms block damage between teammates', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    addAt(room, 'a1', 'alpha', 0);
    const mate = addAt(room, 'a2', 'alpha', 5);
    hit(room, 'a1', 'a2');
    expect(mate.health).toBe(CONFIG.playerMaxHealth);
  });

  it('team rooms still damage enemies', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    addAt(room, 'a1', 'alpha', 0);
    const foe = addAt(room, 'b1', 'bravo', 5);
    hit(room, 'a1', 'b1');
    expect(foe.health).toBeLessThan(CONFIG.playerMaxHealth);
  });

  it('ffa rooms have no friendly-fire gate', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    addAt(room, 'p1', undefined, 0);
    const p2 = addAt(room, 'p2', undefined, 5);
    hit(room, 'p1', 'p2');
    expect(p2.health).toBeLessThan(CONFIG.playerMaxHealth);
  });

  it('self-splash stays legal in team rooms (rocket jumps)', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    const p = addAt(room, 'a1', 'alpha', 0);
    hit(room, 'a1', 'a1');
    expect(p.health).toBeLessThan(CONFIG.playerMaxHealth);
  });
});
