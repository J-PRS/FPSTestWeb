import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES } from '../../shared/teams.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

// Map rotation: at the horn the room asks GameServer for the next spec
// (onRotate) and applies it through the same applySpec hot-swap an admin
// reload uses — mode stays the room's, layout/terrain/bots swap.

function endDmMatch(room: Room): void {
  const combat = (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void } }).combat;
  room.players.addPlayer('shooter');
  const frags = Math.ceil(MODES.dm.winAt / MODES.dm.ptsPlayerKill);
  for (let i = 0; i < frags; i++) {
    const vid = `v${i}`;
    room.players.addPlayer(vid);
    room.players.breakShield(vid);
    for (let j = 0; j < 20 && !room.players.getPlayer(vid)!.isDead; j++) combat.botAttack('shooter', vid, 1);
    room.players.getPlayer(vid)!.isDead = false;
  }
}

describe('Map rotation', () => {
  it('onRotate spec is applied at the horn with a mapUpdate broadcast', () => {
    const sent: ServerMessage[] = [];
    const room = new Room('t', null, '', resolveMapSpec({ mode: 'dm' }));
    room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
    const next = resolveMapSpec({ mode: 'dm', structures: [{ kind: 'wall', pos: { x: 1, y: 0, z: 1 }, size: { x: 4, y: 4, z: 1 } }] });
    room.onRotate = () => next;
    endDmMatch(room);
    expect(sent.some(m => m.type === 'ffaMatchEnd')).toBe(true);
    expect(sent.some(m => m.type === 'mapUpdate')).toBe(true);
    expect(room.spec.structures?.length).toBe(1);
  });

  it('no rotation (null) replays the same map — no mapUpdate', () => {
    const sent: ServerMessage[] = [];
    const room = new Room('t', null, '', resolveMapSpec({ mode: 'dm' }));
    room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
    room.onRotate = () => null;
    endDmMatch(room);
    expect(sent.some(m => m.type === 'ffaMatchEnd')).toBe(true);
    expect(sent.some(m => m.type === 'mapUpdate')).toBe(false);
  });
});
