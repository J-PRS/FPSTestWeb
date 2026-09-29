import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

describe('scenario: flag return on touch', () => {
  it('own team touching a dropped flag walks it home', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const players = [...room.players.getAllPlayers().values()];
    players[0]!.team = 'alpha';
    players[1]!.team = 'bravo';

    // Drop bravo's flag at midfield — the bravo defender touching it
    // returns it home without a carrier having to score anything.
    const flag = room.flags!.flags.get('bravo')!;
    flag.state = 'dropped';
    flag.pos = { x: 0, y: 60, z: 0 };
    flag.dropT = 30;
    flag.droppedAt = Date.now();

    // Keep the alpha bot far away — nearestTouching picks the closest
    // player, and an alpha in range would grab instead of return.
    players[0]!.position = { x: -100, y: 60, z: -100 };
    players[1]!.position = { x: 0, y: 60, z: 0 };
    room.tickFlags(0.05);
    expect(flag.state as string).toBe('home');
    expect(flag.pos).toEqual(flag.home);
    expect(flag.carrier).toBeNull();
  });

  it('a dropped flag times out and walks itself home untouched', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const flag = room.flags!.flags.get('bravo')!;
    flag.state = 'dropped';
    flag.pos = { x: 0, y: 60, z: 0 };
    flag.dropT = 0.05;
    room.tickFlags(0.1);
    expect(flag.state as string).toBe('home');
  });
});
