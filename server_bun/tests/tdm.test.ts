import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

function tdmRoom(sent: ServerMessage[]) {
  const room = new Room('t', null, '', resolveMapSpec({ mode: 'tdm', arena: { x: 0, z: 0, radius: 160 } }));
  room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
  return room;
}

const kill = (room: Room, shooter: string, victim: string) => {
  room.players.breakShield(victim);
  const combat = (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void } }).combat;
  for (let i = 0; i < 20 && !room.players.getPlayer(victim)!.isDead; i++) combat.botAttack(shooter, victim, 1);
};

describe('TDM kill-confirmed scoring', () => {
  it('a player frag scores the shooter team AND drops a tag at the corpse', () => {
    const sent: ServerMessage[] = [];
    const room = tdmRoom(sent);
    room.players.addPlayer('a'); room.players.addPlayer('b');
    const va = room.players.getPlayer('a')!, vb = room.players.getPlayer('b')!;
    va.team = 'alpha'; vb.team = 'bravo';
    vb.position = { x: 5, y: 0, z: 5 };
    kill(room, 'a', 'b');

    const ts = sent.find((m) => m.type === 'teamScore') as { scores: { alpha: number } } | undefined;
    expect(ts?.scores.alpha).toBe(1);
    const tag = sent.find((m) => m.type === 'pickupSpawn' && m.kind === 'tag') as { pos: { x: number; z: number } } | undefined;
    expect(tag).toBeTruthy();
    expect(tag!.pos.x).toBe(5);
  });

  it('a pickup touch by the OTHER team banks the tag point', () => {
    const sent: ServerMessage[] = [];
    const room = tdmRoom(sent);
    room.players.addPlayer('a'); room.players.addPlayer('b'); room.players.addPlayer('c');
    room.players.getPlayer('a')!.team = 'alpha';
    room.players.getPlayer('b')!.team = 'bravo';
    room.players.getPlayer('c')!.team = 'bravo';
    room.players.getPlayer('b')!.position = { x: 5, y: 0, z: 5 };
    kill(room, 'a', 'b');
    // bravo's 'c' walks onto the tag — denies nothing, but banks the point.
    room.players.getPlayer('c')!.position = { x: 5, y: 0, z: 5 };
    room.sims.forEach(s => s.tick(0.05));
    const scores = sent.filter(m => m.type === 'teamScore').map(m => (m as { scores: { alpha: number; bravo: number } }).scores);
    expect(scores.at(-1)!.bravo).toBe(1);
  });
});
