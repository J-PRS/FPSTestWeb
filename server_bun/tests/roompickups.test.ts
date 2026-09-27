import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';

const TEAM_SPEC = resolveMapSpec({ mode: 'nuggets' });
const FFA_SPEC = resolveMapSpec({ mode: 'dm' });

function addAt(room: Room, id: string, team: 'alpha' | 'bravo' | undefined, x: number, z = 0) {
  const p = room.players.addPlayer(id, team);
  p.position = { x, y: 0, z };
  return p;
}

describe('RoomPickups', () => {
  it('exists only in team modes', () => {
    expect(new Room('t', null, '', TEAM_SPEC).pickups).not.toBeNull();
    expect(new Room('f', null, '', FFA_SPEC).pickups).toBeNull();
    expect(new Room('a', null, '', resolveMapSpec(null)).pickups).toBeNull();
  });

  it('touching a gem banks a team point', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    addAt(room, 'p1', 'alpha', 10, 0);
    room.pickups!.spawn({ x: 10, y: 0, z: 0 });
    room.pickups!.tick(0.05);
    expect(room.scores.alpha).toBe(1);
    expect(room.pickups!.snapshot().length).toBe(0);
  });

  it('a teamless or dead player cannot collect', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    addAt(room, 'ghost', undefined, 10, 0);
    const dead = addAt(room, 'deadguy', 'alpha', 10, 0);
    dead.isDead = true;
    room.pickups!.spawn({ x: 10, y: 0, z: 0 });
    room.pickups!.tick(0.05);
    expect(room.pickups!.snapshot().length).toBe(1);
  });

  it('expired gems despawn', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    room.pickups!.spawn({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 700; i++) room.pickups!.tick(0.05); // 35s > 30s TTL
    expect(room.pickups!.snapshot().length).toBe(0);
  });
});
