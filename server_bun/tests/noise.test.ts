import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

// Combat noise feeds the brains' hearing sense: broadcasts that carry a
// firing position (projectileCreated) and sim detonations land in the
// room's short-lived noise ring; bots query noisesNear from their tick.

const mkRoom = (): Room => {
  const room = new Room('n', null, '', resolveMapSpec({ mode: 'dm' }));
  room.connections.broadcast = () => 0;
  return room;
};

describe('Combat noise ring', () => {
  it('projectileCreated broadcasts leave a noise at the muzzle', () => {
    const room = mkRoom();
    room.broadcast({ type: 'projectileCreated', position: { x: 10, y: 1, z: -5 } } as ServerMessage);
    expect(room.noisesNear({ x: 12, y: 0, z: -5 }, 10).length).toBe(1);
    expect(room.noisesNear({ x: 100, y: 0, z: 0 }, 10).length).toBe(0);
  });

  it('playerShot relays (hitscan fire) leave noise at the stamped muzzle', () => {
    const room = mkRoom();
    room.broadcast({ type: 'playerShot', id: 'p1', pos: { x: 0, y: 1, z: 20 } } as ServerMessage);
    expect(room.noisesNear({ x: 0, y: 0, z: 25 }, 10).length).toBe(1);
  });

  it('non-position broadcasts make no noise', () => {
    const room = mkRoom();
    room.broadcast({ type: 'matchNotice', text: 'x' } as ServerMessage);
    expect(room.noisesNear({ x: 0, y: 0, z: 0 }, 999).length).toBe(0);
  });

  it('pushNoise (sim detonations) is audible the same way', () => {
    const room = mkRoom();
    room.pushNoise({ x: 0, y: 0, z: 30 });
    expect(room.noisesNear({ x: 0, y: 0, z: 25 }, 10).length).toBe(1);
  });
});
