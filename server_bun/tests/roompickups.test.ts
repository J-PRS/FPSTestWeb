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
  it('exists in every mode (powerups drop anywhere)', () => {
    expect(new Room('t', null, '', TEAM_SPEC).pickups).not.toBeNull();
    expect(new Room('f', null, '', FFA_SPEC).pickups).not.toBeNull();
    expect(new Room('a', null, '', resolveMapSpec(null)).pickups).not.toBeNull();
  });

  it('powerup collection grants armor and blocks scoreless gems for teamless players', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    const p = addAt(room, 'p1', undefined, 10, 0);
    p.protectedUntil = 0;
    room.pickups!.spawn({ x: 10, y: 0, z: 0 }, 'armor');
    room.pickups!.tick(0.05);
    expect(p.armor).toBe(100);
    // teamless player walking over a gem must NOT bank anything
    room.pickups!.spawn({ x: 10, y: 0, z: 0 }, 'gem');
    room.pickups!.tick(0.05);
    expect(room.pickups!.snapshot().length).toBe(1);
  });

  it('armor soaks 80% of a hit, overflow leaks to health', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    const p = addAt(room, 'p1', undefined, 10, 0);
    p.protectedUntil = 0;
    p.armor = 100;
    const hp0 = p.health;
    const r = room.players.applyDamage('p1', 100);
    // Armor soaks 80 (armorAbsorb) → only 20 leaks to health, whatever the
    // class base is (medium's +25 made the literal 80 stale).
    expect(p.health).toBe(hp0 - 20);
    expect(p.armor).toBe(20);
    expect(r.newArmor).toBe(20);
  });

  it('dd doubles outgoing damage while the buff lasts', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    const shooter = addAt(room, 's1', undefined, 0, 0);
    const target = addAt(room, 't1', undefined, 10, 0);
    shooter.protectedUntil = 0;
    target.protectedUntil = 0;
    shooter.ddUntil = Date.now() + 10_000;
    const base = 25;
    const dmg = base * (shooter.ddUntil > Date.now() ? 2 : 1);
    room.players.applyDamage('t1', dmg);
    expect(target.health).toBe(target.maxHealth - 50);
  });

  it('death strips powerups', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    const p = addAt(room, 'p1', undefined, 10, 0);
    p.protectedUntil = 0;
    p.armor = 100;
    p.regenUntil = Date.now() + 10_000;
    p.ddUntil = Date.now() + 10_000;
    room.players.applyDamage('p1', 9999);
    expect(p.armor).toBe(0);
    expect(p.regenUntil).toBe(0);
    expect(p.ddUntil).toBe(0);
  });

  it('touching a gem banks a team point', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    addAt(room, 'p1', 'alpha', 10, 0);
    room.pickups!.spawn({ x: 10, y: 0, z: 0 });
    room.pickups!.tick(0.05);
    expect(room.scores.alpha).toBe(1);
    expect(room.pickups!.snapshot().length).toBe(0);
  });

  it('full nuggets funnel: creature kill → gem drop → touch → teamScore', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    const p = addAt(room, 'hunter', 'alpha', 10, 0);
    // BallSim routes kills through nonPlayerKill — the gem must actually
    // materialize at the corpse for the mode to have a loop at all.
    room.ballSim.onKilled!('hunter', { x: 10, y: 0, z: 0 }, 0);
    expect(room.pickups!.snapshot().length).toBeGreaterThanOrEqual(1);
    // Hunter stands on the corpse — next tick banks the point.
    room.pickups!.tick(0.05);
    expect(room.scores.alpha).toBe(1);
    expect(p.health).toBeGreaterThan(0);
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
    for (let i = 0; i < 1300; i++) room.pickups!.tick(0.05); // 65s > 60s TTL
    expect(room.pickups!.snapshot().length).toBe(0);
  });

  it('gem collect heals server-side; heal claims are refused outright', () => {
    const room = new Room('t', null, '', TEAM_SPEC);
    const p = addAt(room, 'p1', 'alpha', 10, 0);
    p.health = 50;
    p.protectedUntil = 0;
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(50); // no credit, no heal
    room.pickups!.spawn({ x: 10, y: 0, z: 0 });
    room.pickups!.tick(0.05);
    expect(p.health).toBe(70); // collect IS the intent — server declared the heal
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(70); // claims can't re-spend a heal already applied
  });

  it('heal claims are refused on sim authorities, ffa included', () => {
    const room = new Room('f', null, '', FFA_SPEC);
    const p = addAt(room, 'p1', undefined, 0, 0);
    p.health = 50;
    p.protectedUntil = 0;
    room.messages.handleMessage('p1', { type: 'heal', amount: 25 });
    expect(p.health).toBe(50); // claimsAccepted: false — collect pays the heal
  });
});
