import { describe, expect, it } from 'bun:test';
import { mkRoom, freeze, step } from './harness.ts';

// A silenced (quiet) bot skips the think pipeline — but the respawn
// reseat used to sit BELOW that skip, so a quiet bot that died and
// respawned kept its shadow at the corpse spot (every later tick
// diverged) and its sheep meter never reset.
describe('quiet bot respawn upkeep', () => {
  it('a quiet bot respawning reseats the shadow and clears the meter', () => {
    const room = mkRoom({ bots: 1 });
    const id = 'BOT-t1';
    freeze(room, id, { x: 0, y: 60, z: 0 });
    room.bots.debugSetSheep(id, 55);
    const p = room.players.getPlayer(id)!;
    p.isDead = true;
    step(room, 1); // deadSet records the corpse
    p.isDead = false; // respawn teleports the body
    p.position = { x: 50, y: 60, z: 0 };
    step(room, 1);
    // Shadow follows the respawn spot, not the corpse.
    const sh = room.moveSim.simState(id);
    expect(sh?.pos.x).toBeCloseTo(50, 0);
    // Fresh leash on the meter too.
    expect(room.bots.sheepOf(id)).toBe(0);
  });
});
