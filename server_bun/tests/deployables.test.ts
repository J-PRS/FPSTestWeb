import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';

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
    addAt(room, 'p1', 0, 0);
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
    for (let i = 0; i < 1900; i++) room.deployables.tick(0.05); // 95s > 90s drone TTL
    expect(room.deployables.snapshot().length).toBe(0);
  });

  it('AOE blast damages and destroys deployables; out-of-range untouched', () => {
    const room = new Room('t', null, '', SPEC);
    addAt(room, 'p1', 0, 0);
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
