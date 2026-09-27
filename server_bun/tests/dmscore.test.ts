import { describe, it, expect } from 'bun:test';
import { Room } from '../src/Room.ts';
import { resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES } from '../../shared/teams.ts';
import type { ServerMessage } from '../../shared/protocol.ts';

const DM_SPEC = resolveMapSpec({ mode: 'dm' });

function dmRoom(sent: ServerMessage[]) {
  const room = new Room('t', null, '', DM_SPEC);
  room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
  return room;
}

describe('Room DM scoring', () => {
  it('ffa rooms bank player frags into ffaScore', () => {
    const sent: ServerMessage[] = [];
    const room = dmRoom(sent);
    room.players.addPlayer('shooter');
    room.players.addPlayer('victim');
    // Drive a kill through the shared combat funnel.
    const combat = (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void } }).combat;
    // High damage guarantees the kill regardless of weapon stats.
    for (let i = 0; i < 20 && !room.players.getPlayer('victim')!.isDead; i++) combat.botAttack('shooter', 'victim', 1);

    expect(sent.some((m) => m.type === 'playerKill' && m.shooterId === 'shooter')).toBe(true);
    const fs = sent.filter((m) => m.type === 'ffaScore');
    expect(fs.length).toBe(1);
    expect((fs[0] as { scores: Record<string, number> }).scores.shooter).toBe(MODES.dm.ptsPlayerKill);
  });

  it('environment kills score nothing', () => {
    const sent: ServerMessage[] = [];
    const room = dmRoom(sent);
    room.players.addPlayer('victim');
    const combat = (room.messages as unknown as { combat: { handleEnvironmentDamage(p: string, m: { type: 'environmentDamage'; damage: number }): void } }).combat;
    combat.handleEnvironmentDamage('victim', { type: 'environmentDamage', damage: 500 });
    expect(sent.some((m) => m.type === 'ffaScore')).toBe(false);
  });

  it('team rooms ignore ffa scoring', () => {
    const sent: ServerMessage[] = [];
    const room = new Room('t', null, '', resolveMapSpec({ mode: 'ctf', bases: { alpha: { x: 0, y: 0, z: 0 }, bravo: { x: 10, y: 0, z: 0 } } }));
    room.connections.broadcast = (m) => { sent.push(m as ServerMessage); return 0; };
    room.players.addPlayer('a'); room.players.addPlayer('b');
    const combat = (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void } }).combat;
    for (let i = 0; i < 20 && !room.players.getPlayer('b')!.isDead; i++) combat.botAttack('a', 'b', 1);
    expect(sent.some((m) => m.type === 'ffaScore')).toBe(false);
  });

  it('creature kills bank ptsCreatureKill', () => {
    const sent: ServerMessage[] = [];
    const room = dmRoom(sent);
    room.players.addPlayer('hunter');
    room.ballSim.onKilled!('hunter', { x: 0, y: 0, z: 0 });
    const fs = sent.filter((m) => m.type === 'ffaScore');
    expect(fs.length).toBe(1);
    expect((fs[0] as { scores: Record<string, number> }).scores.hunter).toBe(MODES.dm.ptsCreatureKill);
    // Unknown/environment-ish killers score nothing
    sent.length = 0;
    room.ballSim.onKilled!('ghost', { x: 0, y: 0, z: 0 });
    expect(sent.some((m) => m.type === 'ffaScore')).toBe(false);
  });

  it('reaching winAt ends the match and resets the board', () => {
    const sent: ServerMessage[] = [];
    const room = dmRoom(sent);
    room.players.addPlayer('shooter');
    const combat = (room.messages as unknown as { combat: { botAttack(s: string, t: string, w: number): void } }).combat;
    const frags = Math.ceil(MODES.dm.winAt / MODES.dm.ptsPlayerKill);
    for (let i = 0; i < frags; i++) {
      const vid = `v${i}`;
      room.players.addPlayer(vid);
      for (let j = 0; j < 20 && !room.players.getPlayer(vid)!.isDead; j++) combat.botAttack('shooter', vid, 1);
      room.players.getPlayer(vid)!.isDead = false; // stand back up — respawn timer is async
    }
    expect(sent.some((m) => m.type === 'ffaMatchEnd' && m.winner === 'shooter')).toBe(true);
    expect(room.ffaScores.size).toBe(0);
    expect(sent.some((m) => m.type === 'matchStart')).toBe(true);
  });
});
