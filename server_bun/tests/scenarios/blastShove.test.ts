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
    room.messages.serverBlast(shooter.id, { x: 0, y: 31, z: 0 }, WeaponType.BoltLauncher, null);
    expect(toVictim.filter((m) => m.type === 'knockback').length).toBe(1);
    step(room, 20);
    const after = room.moveSim.simPos(p.id)!;
    expect(after.x - before.x).toBeGreaterThan(0.5);
  });

  // The bug: every client predicts knockback on everyone in radius —
  // the direct-hit victim included — but the splash sweep excluded them,
  // so a hit bot's shadow never got the impulse and the predicted arc
  // snapped back. Victim gets the shove, not the splash damage.
  it('the direct-hit victim is shoved by the blast but takes no splash damage', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, p] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    freeze(room, p.id, { x: 0.5, y: 31, z: 0 }); // shell pops on their chest
    const hp0 = room.players.getPlayer(p.id)!.health;
    const before = { ...room.moveSim.simPos(p.id)! };

    const toVictim: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) toVictim.push(m); else origSend(pid, m); };

    room.messages.serverBlast(shooter.id, { x: 0, y: 31, z: 0 }, WeaponType.BoltLauncher, p.id);
    expect(toVictim.filter((m) => m.type === 'knockback').length).toBe(1);
    // Splash damage must not double-pay on top of the direct hit.
    expect(room.players.getPlayer(p.id)!.health).toBe(hp0);
    step(room, 20);
    const after = room.moveSim.simPos(p.id)!;
    expect(after.x - before.x).toBeGreaterThan(0.5);
  });
});
