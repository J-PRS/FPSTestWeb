import { describe, it, expect } from 'bun:test';
import { mkRoom, watch, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// The simmed-intent flood gate (CombatHandler.simmedFireTimes): a rolling
// 1s window admits 20 intents; a macro firing past it rejects instead of
// spawning shells. This stands between "paused-tab input bunch" and a
// real fire-rate macro — the claim path's cadence law, rebuilt on the
// only evidence left: arrival rate at the intent endpoint.

const GUN = 3; // Chaingun — simmed, open to every class

function spyRejects(room: ReturnType<typeof mkRoom>, pid: string): ServerMessage[] {
  const out: ServerMessage[] = [];
  const orig = room.connections.sendToPlayer.bind(room.connections);
  room.connections.sendToPlayer = (id, m) => { if (id === pid) out.push(m); else orig(id, m); };
  return out;
}

function fire(room: ReturnType<typeof mkRoom>, pid: string): void {
  room.messages.handleMessage(pid, {
    type: 'shotFired', weaponType: GUN,
    dir: { x: 1, y: 0, z: 0 },
    pos: { x: 1, y: 32, z: 0 },
  } as never);
}

describe('scenario: intent flood gate', () => {
  it('legal cadence admits every intent', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    for (let i = 0; i < 10; i++) fire(room, a.id);
    expect(w.count('projectileCreated')).toBe(10);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(0);
  });

  it('a rolling-second swarm past 20 intents rejects, no shells spawn', () => {
    const room = mkRoom({ bots: 2 }, 'tdm');
    const w = watch(room);
    const [a] = twoPlayers(room);
    const rejects = spyRejects(room, a.id);
    for (let i = 0; i < 25; i++) fire(room, a.id);
    expect(w.count('projectileCreated')).toBe(20);
    expect(rejects.filter((m) => m.type === 'shotRejected')).toHaveLength(5);
  });
});
