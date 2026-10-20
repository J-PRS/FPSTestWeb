import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, twoPlayers } from './harness.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: rope dart', () => {
  // Terrain anchor: the dart sticks in a wall and reels the THROWER in —
  // one impulse, then the sim carries them toward the contact.
  it('a terrain connect yanks the thrower toward the anchor', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 32, z: 0 });
    const before = { ...room.moveSim.simPos(shooter.id)! };

    const toShooter: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === shooter.id) {toShooter.push(m);} else {origSend(pid, m);} };

    room.messages.grapple(shooter.id, { x: -30, y: 40, z: 0 }, null);
    expect(toShooter.filter((m) => m.type === 'knockback').length).toBe(1);
    step(room, 10);
    const after = room.moveSim.simPos(shooter.id)!;
    expect(after.x - before.x).toBeGreaterThan(0.5); // east = toward anchor
  });

  // Body connect: the dart caught a player — the VICTIM is reeled toward
  // the shooter, not the other way around.
  it('a body connect yanks the victim toward the shooter', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, p] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 32, z: 0 });
    freeze(room, p.id, { x: 5, y: 32, z: 0 });
    const before = { ...room.moveSim.simPos(p.id)! };

    const toVictim: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) {toVictim.push(m);} else {origSend(pid, m);} };

    room.messages.grapple(shooter.id, room.players.getPlayer(p.id)!.position, p.id);
    expect(toVictim.filter((m) => m.type === 'knockback').length).toBe(1);
    // The dart is a reel, not a bullet — no blood changes hands.
    expect(room.players.getPlayer(p.id)!.health).toBe(room.players.getPlayer(p.id)!.maxHealth);
    step(room, 10);
    const after = room.moveSim.simPos(p.id)!;
    expect(before.x - after.x).toBeGreaterThan(0.5); // west = toward shooter
  });
});
