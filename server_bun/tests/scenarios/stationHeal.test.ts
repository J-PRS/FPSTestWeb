import { describe, it, expect } from 'bun:test';
import { mkRoom, step, pin, firstPlayer } from './harness.ts';

describe('scenario: resupply station heals', () => {
  it('a wounded teammate standing in the field regenerates', () => {
    const room = mkRoom({ mode: 'tdm', bots: 1 });
    const a = firstPlayer(room);
    // A non-bot patient — bot brains self-MEND, which would fake the result.
    room.players.addPlayer('P1');
    const b = room.players.getPlayer('P1')!;
    b.team = a.team;
    pin(room, a.id, { x: 40, y: 31, z: 0 });
    room.deployables.handleDeploy(a.id, 'station', { x: 42, y: 31, z: 0 });
    b.health = 40;
    b.maxHealth = 100;
    for (let i = 0; i < 200; i++) {
      pin(room, b.id, { x: 43, y: 31, z: 0 });
      step(room, 1);
    }
    expect(b.health).toBeGreaterThan(40);
  });
});
