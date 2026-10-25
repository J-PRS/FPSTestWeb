import { describe, it, expect } from 'bun:test';
import { mkRoom } from './harness.ts';

// Rebalance flips bot teams to even the sides — a flipped flag-carrier
// would hold the enemy flag in 'carried' state FOREVER: tickCarried only
// scores while carrier.team !== flag.team, and the bot's new own-team
// can't grab or return it. The flip must drop the flag at their feet.
describe('scenario: a rebalanced flag carrier drops the flag', () => {
  it('flipping a carrier to the flag team frees the flag', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 4,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const players = [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
    // Rig the sides: 3 alpha, 1 bravo — delta 2 triggers a flip.
    const carrier = players[0]!;
    room.players.setTeam(carrier.id, 'alpha');
    room.players.setTeam(players[1]!.id, 'alpha');
    room.players.setTeam(players[2]!.id, 'alpha');
    room.players.setTeam(players[3]!.id, 'bravo');
    // An alpha bot carries bravo's flag.
    const bravoFlag = room.flags!.flags.get('bravo')!;
    carrier.position = { ...bravoFlag.pos };
    room.tickFlags(0.05);
    expect(bravoFlag.carrier).toBe(carrier.id);
    // Trigger the rebalance funnel directly (private — invoked by removal).
    (room as unknown as { balanceTeams: () => void }).balanceTeams();
    expect(carrier.team).toBe('bravo');
    expect(bravoFlag.state).toBe('dropped');
    expect(bravoFlag.carrier).toBeNull();
  });
});
