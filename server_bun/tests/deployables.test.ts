import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { simMs } from '../src/simClock.ts';

const SPEC = resolveMapSpec(null);

function addAt(room: Room, id: string, x: number, z = 0) {
  const p = room.players.addPlayer(id, undefined);
  p.position = { x, y: 0, z };
  return p;
}

describe('RoomDeployables', () => {
  it('a deploy claim registers and broadcasts the plant', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'turret', position: { x: 3, y: 0, z: 0 } });
    const snap = room.deployables.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]!.kind).toBe('turret');
    expect(snap[0]!.owner).toBe('p1');
  });

  it('plants far from the planter are rejected', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'mine', position: { x: 200, y: 0, z: 0 } });
    expect(room.deployables.snapshot().length).toBe(0);
  });

  it('per-player cap recycles the oldest of a kind', () => {
    const room = new Room('t', null, '', SPEC);
    const p = addAt(room, 'p1', 0, 0);
    p.beltCharges = 99; // turrets cost 5 — the cap test isn't about the wallet
    for (let i = 0; i < 5; i++) {
      room.messages.handleMessage('p1', { type: 'deploy', kind: 'turret', position: { x: i + 1, y: 0, z: 0 } });
    }
    const snap = room.deployables.snapshot();
    expect(snap.length).toBe(2); // MAX_PER_PLAYER.turret
  });

  it('owner death and leave clear their field', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'mine', position: { x: 1, y: 0, z: 0 } });
    expect(room.deployables.snapshot().length).toBe(1);
    room.deployables.clearOwner('p1');
    expect(room.deployables.snapshot().length).toBe(0);
  });

  it('TTL expires unattended plants', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'drone', position: { x: 1, y: 0, z: 0 } });
    for (let i = 0; i < 1900; i++) {room.deployables.tick(0.05);} // 95s > 90s drone TTL
    expect(room.deployables.snapshot().length).toBe(0);
  });

  it('mortar lobs at the mid band, ignores the point-blank dead zone', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'mortar', position: { x: 2, y: 0, z: 0 } });
    const foe = addAt(room, 'p2', 40, 0); // inside [20, 95]
    foe.team = 'bravo'; room.players.getPlayer('p1')!.team = 'alpha';
    foe.protectedUntil = simMs(0);
    // Arm delay 1.2s → first shot around tick 25; the bolt is still in
    // flight (≈0.7s arc) when we check at 1.5s.
    for (let i = 0; i < 30; i++) {room.deployables.tick(0.05);}
    expect(room.deployables.bolts.length).toBe(1);
    // Point-blank target inside minRange: first bolt lands, none re-fire.
    foe.position.x = 8;
    for (let i = 0; i < 100; i++) {room.deployables.tick(0.05);}
    expect(room.deployables.bolts.length).toBe(0);
  });

  it('chaingun turret shreds a hostile in envelope, pays through the funnel', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'cgturret', position: { x: 2, y: 0, z: 0 } });
    const foe = addAt(room, 'p2', 20, 0);
    foe.team = 'bravo'; room.players.getPlayer('p1')!.team = 'alpha';
    foe.protectedUntil = simMs(0);
    const hp0 = foe.health;
    for (let i = 0; i < 60; i++) {room.deployables.tick(0.05);} // 3s — arm + ~4 pulses
    expect(foe.health).toBeLessThan(hp0);
    // Out of envelope → silent.
    foe.position.x = 80; foe.health = foe.maxHealth;
    for (let i = 0; i < 60; i++) {room.deployables.tick(0.05);}
    expect(foe.health).toBe(foe.maxHealth);
  });

  it('AOE blast damages and destroys deployables; out-of-range untouched', () => {
    const room = new Room('t', null, '', SPEC);
    const p = addAt(room, 'p1', 0, 0);
    p.beltCharges = 99; // turret costs 5 — both plants need a deep belt
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'turret', position: { x: 1, y: 0, z: 0 } });
    room.messages.handleMessage('p1', { type: 'deploy', kind: 'mine', position: { x: 30, y: 0, z: 0 } });
    // A 50-damage 8m blast centered on the turret: two hits > 60hp turret,
    // the mine at 30m sits outside the envelope entirely.
    room.deployables.applyBlast({ x: 1, y: 0, z: 0 }, 50, 8, 'p2');
    expect(room.deployables.snapshot().length).toBe(2);
    room.deployables.applyBlast({ x: 1, y: 0, z: 0 }, 50, 8, 'p2');
    const snap = room.deployables.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0]!.kind).toBe('mine');
  });
});
