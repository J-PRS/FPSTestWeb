import { describe, it, expect } from 'bun:test';
import { mkRoom, step, freeze, pin, twoPlayers, replica } from './harness.ts';
import { WeaponType } from '../../../shared/weapons.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

describe('scenario: blast knockback', () => {
  it('a blast beside a player shoves their shadow away from the center', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, p] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    // y=32: stand height on this terrain is ~31.9 (terrain 29.4 + eye
    // ~2.5) — pinning at 31 leaves the body marginally buried, and
    // unburyTick re-seats the shadow every 0.5s, erasing the shove.
    freeze(room, p.id, { x: 5, y: 32, z: 0 });
    const before = { ...room.moveSim.simPos(p.id)! }; // live ref — copy it

    // Knockback is private feedback to the victim — tap their channel.
    const toVictim: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) {toVictim.push(m);} else {origSend(pid, m);} };

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
    // ~2.3m out: the T1 impulse curve peaks at minbox+1 — a chest-pop
    // sits in its designed point-blank dead zone (d clamps to 1m) and
    // only ever nudges, so staging there measures a weak blast, not
    // whether the victim's shadow receives the impulse at all.
    freeze(room, p.id, { x: 2.3, y: 32, z: 0 });
    const hp0 = room.players.getPlayer(p.id)!.health;
    const before = { ...room.moveSim.simPos(p.id)! };

    const toVictim: ServerMessage[] = [];
    const origSend = room.connections.sendToPlayer.bind(room.connections);
    room.connections.sendToPlayer = (pid, m) => { if (pid === p.id) {toVictim.push(m);} else {origSend(pid, m);} };

    room.messages.serverBlast(shooter.id, { x: 0, y: 31, z: 0 }, WeaponType.BoltLauncher, p.id);
    expect(toVictim.filter((m) => m.type === 'knockback').length).toBe(1);
    // Splash damage must not double-pay on top of the direct hit.
    expect(room.players.getPlayer(p.id)!.health).toBe(hp0);
    // A chest-pop shoves mostly UP — measure the arc mid-flight, not the
    // landing spot (by 20 ticks they settle back near the pin).
    step(room, 6);
    const mid = room.moveSim.simPos(p.id)!;
    expect(Math.hypot(mid.x - before.x, mid.y - before.y, mid.z - before.z)).toBeGreaterThan(0.5);
  });

  // Observers (not the victim) learn the shove ONLY through the position
  // stream — knockback messages are private to the victim's channel.
  // shove() sets forceSendUntil so a suppressed remote still rides the
  // full-rate records for 900ms; the replica replica eats the same
  // binary frames a client would and must show the launch within ticks.
  it('a shoved remote reaches the observer wire within ticks, not seconds', () => {
    const room = mkRoom({ bots: 2 }, 'dm');
    const [shooter, p] = twoPlayers(room);
    freeze(room, shooter.id, { x: -40, y: 31, z: 0 });
    // pin, NOT freeze: a quiet bot skips the drive block entirely, so its
    // shadow flies but p.position (the wire field) never gets the
    // write-back — staging the failure, not measuring it.
    pin(room, p.id, { x: 5, y: 32, z: 0 });
    const obs = replica(room);
    try {
      step(room, 2); // settle the replica roster/records before the blast
      const before = { ...(obs.players.get(p.id) ?? { x: 5, y: 32, z: 0 }) };
      room.messages.serverBlast(shooter.id, { x: 0, y: 31, z: 0 }, WeaponType.BoltLauncher, null);
      // ~4 ticks of fanout (~200ms sim) — the prediction window a client
      // used to bridge. If the launch isn't on the wire by now, observers
      // see the drift-late replay the disable-remote-prediction change
      // left behind.
      step(room, 4);
      const mid = obs.players.get(p.id)!;
      expect(Math.hypot(mid.x - before.x, mid.y - before.y, mid.z - before.z)).toBeGreaterThan(0.5);
    } finally {
      obs.detach();
    }
  });
});
