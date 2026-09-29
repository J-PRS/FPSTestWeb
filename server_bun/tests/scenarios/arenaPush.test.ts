import { describe, it, expect } from 'bun:test';
import type { ServerMessage } from '../../../shared/protocol.ts';
import { mkRoom, step, pin } from './harness.ts';

describe('scenario: arena dome pushes violators back', () => {
  it('a player outside the radius eats a grace window then a pull inward', () => {
    const room = mkRoom({ arena: { x: 0, z: 0, radius: 40 } });
    // Per-player sends bypass connections.broadcast — spy the pipe itself.
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { sent.push(m); orig(pid, m); };
    // A brainless player — bots think and would walk themselves back in.
    // addPlayer skips moveSim.track (join/spawn does it), so seed the
    // shadow by hand or applyImpulse has nothing to push.
    room.players.addPlayer('P1');
    room.moveSim.track('P1', { x: 80, y: 31, z: 0 }, 0);
    pin(room, 'P1', { x: 80, y: 31, z: 0 });
    // 1.5s grace at 50ms ticks — nothing before ~30 ticks.
    step(room, 10);
    expect(sent.filter((m) => m.type === 'knockback').length).toBe(0);
    step(room, 40);
    const kb = sent.find((m) => m.type === 'knockback')!;
    expect(kb).toBeTruthy();
    // Let the impulse carry them — no more pinning. In shadow mode the
    // client keeps position truth (the knockback msg does the real pull
    // there); the honest server-side evidence is the shadow's simPos
    // walking back toward the dome.
    step(room, 60);
    const sim = room.moveSim.simPos('P1')!;
    const d = Math.hypot(sim.x, sim.z);
    expect(d).toBeLessThan(80);
  });
});
