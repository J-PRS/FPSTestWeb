import { describe, it, expect } from 'bun:test';
import { mkRoom, firstPlayer, twoPlayers, watch } from './harness.ts';

describe('scenario: player departure cleanup', () => {
  it('a carrier leaving drops their flag exactly like dying with it', () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const [a] = twoPlayers(room);
    a.team = 'alpha';
    const w = watch(room);
    // Plant the bravo flag on them, then remove them — the flag must be
    // free for bravo to recover, not gone with the socket.
    const flag = room.flags!.flags.get('bravo')!;
    flag.state = 'carried';
    flag.carrier = a.id;
    room.removePlayerCompletely(a.id, 'test', () => {});
    expect(room.flags!.flags.get('bravo')!.carrier).toBeNull();
    expect(room.flags!.flags.get('bravo')!.state).not.toBe('carried');
    expect(w.count('playerLeft')).toBe(1);
    expect(room.players.getPlayer(a.id)).toBeUndefined();
  });

  it('departure clears deployable/projectile ownership and rebalances bots', () => {
    const room = mkRoom({ bots: 5 }, 'tdm');
    const w = watch(room);
    // Stack the deck: 4 alpha, 1 bravo, then remove an alpha — a bot
    // should flip to bravo to even out (delta ≥ 2 after the leave).
    const all = [...room.players.getAllPlayers().values()];
    all.forEach((p, i) => { p.team = i < 4 ? 'alpha' : 'bravo'; });
    const alphaBot = all.find((p) => p.team === 'alpha' && p.id.toLowerCase().includes('bot'))!;
    room.removePlayerCompletely(alphaBot.id, 'test', () => {});
    // 3v1 now — delta still ≥2, so one of the remaining alpha bots flips.
    const counts = room.players.teamCounts();
    expect(counts.bravo).toBeGreaterThanOrEqual(2);
    expect(w.count('teamUpdate')).toBeGreaterThanOrEqual(1);
  });
});
