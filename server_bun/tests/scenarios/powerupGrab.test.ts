import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, watch, twoPlayers, firstPlayer } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { simNow } from '../../src/simClock.ts';

describe('scenario: powerup pickups', () => {
  it('grabbing a heal powerup restores health and buffs the collector privately', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    const p = room.players.getPlayer(a.id)!;
    p.health = 40;
    const toA: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === a.id) toA.push(m); else origSend(pid, m); };
    room.pickups!.spawn({ x: 1, y: 31, z: 0 }, 'heal');
    step(room, 3);
    expect(w.count('pickupGone')).toBe(1);
    expect(p.health).toBeGreaterThan(40);
    expect(toA.filter((m) => m.type === 'buff').length).toBe(1);
  });

  it('a regen pickup sets a server-owned regenUntil — clients can\'t claim it', () => {
    const room = mkRoom({ bots: 1 }, 'dm');
    const a = firstPlayer(room);
    freeze(room, a.id, { x: 0, y: 31, z: 0 });
    room.pickups!.spawn({ x: 1, y: 31, z: 0 }, 'regen');
    step(room, 3);
    expect(room.players.getPlayer(a.id)!.regenUntil).toBeGreaterThan(simNow()); // sim domain, not wall
  });
});
