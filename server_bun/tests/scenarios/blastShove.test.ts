import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: blast knockback', () => {
  it('a blast beside a player shoves their shadow away from the center', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, p] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    freeze(room, p.id, { x: 5, y: 31, z: 0 });
    const before = { ...room.moveSim.simPos(p.id)! }; // live ref — copy it

    // Knockback is private feedback to the victim — tap their channel.
    const toVictim: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) toVictim.push(m); else origSend(pid, m); };

    // Rocket blast at the origin — player 5m east gets pushed east.
    // (Owner is exempt from the sweep, so the shot must come from someone else.)
    room.messages.serverBlast(shooter.id, { x: 0, y: 31, z: 0 }, WeaponType.Rocket, null);
    expect(toVictim.filter((m) => m.type === 'knockback').length).toBe(1);
    step(room, 20);
    const after = room.moveSim.simPos(p.id)!;
    expect(after.x - before.x).toBeGreaterThan(0.5);
  });
});
