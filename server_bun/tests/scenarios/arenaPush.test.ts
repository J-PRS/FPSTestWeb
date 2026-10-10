import { describe, it, expect } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, step, pin } from './harness.ts';

describe('scenario: arena dome warns violators', () => {
  it('a player outside the radius eats a grace window then one warning — never a shove', () => {
    const room = mkRoom({ arena: { x: 0, z: 0, radius: 40 } });
    // Per-player sends bypass connections.broadcast — spy the pipe itself.
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { sent.push(m); orig(pid, m); };
    // A brainless player — bots think and would walk themselves back in.
    room.players.addPlayer('P1');
    room.moveSim.track('P1', { x: 80, y: 31, z: 0 }, 0);
    pin(room, 'P1', { x: 80, y: 31, z: 0 });
    // 1.5s grace at 50ms ticks — nothing before ~30 ticks.
    step(room, 10);
    expect(sent.filter((m) => m.type === 'serverWarn').length).toBe(0);
    step(room, 40);
    // The boundary is advisory: a banner once per excursion, and no
    // knockback — the pull-back shove was removed for feeling like an
    // invisible grab.
    expect(sent.filter((m) => m.type === 'serverWarn').length).toBe(1);
    step(room, 80);
    expect(sent.filter((m) => m.type === 'serverWarn').length).toBe(1);
    expect(sent.filter((m) => m.type === 'knockback').length).toBe(0);
  });
});
