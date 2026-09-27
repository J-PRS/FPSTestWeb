import { describe, expect, test } from 'bun:test';
import { Room } from '../src/Room';
import { resolveMapSpec } from '../../shared/mapSpec';

const noop = () => {};

const TEAM_SPEC = resolveMapSpec({ mode: 'nuggets' });
const FFA_SPEC = resolveMapSpec({ mode: 'dm' });

describe('team rebalance', () => {
  test('no-op in non-team modes', () => {
    const room = new Room('ffa', null, '', FFA_SPEC);
    room.players.addPlayer('a');
    room.players.addPlayer('b');
    room.removePlayerCompletely('a', 'test', noop);
    expect(room.players.getPlayer('b')?.team).toBeUndefined();
  });

  test('leaver skew → bots from the big side flip until diff < 2', () => {
    const room = new Room('rb', null, '', TEAM_SPEC);
    room.players.addPlayer('h1', 'alpha');
    room.players.addPlayer('bot1', 'alpha');
    room.players.addPlayer('bot2', 'alpha');
    room.players.addPlayer('bot3', 'bravo');
    room.removePlayerCompletely('bot3', 'test', noop);
    // 3 alpha vs 0 bravo → one bot flips: 2 vs 1, diff 1 → stop
    const counts = room.players.teamCounts();
    expect(counts.alpha).toBe(2);
    expect(counts.bravo).toBe(1);
  });

  test('humans never move', () => {
    const room = new Room('rb2', null, '', TEAM_SPEC);
    room.players.addPlayer('h1', 'alpha');
    room.players.addPlayer('h2', 'alpha');
    room.players.addPlayer('h3', 'alpha');
    room.players.addPlayer('h4', 'bravo');
    room.removePlayerCompletely('h4', 'test', noop);
    expect(room.players.teamCounts().alpha).toBe(3);
    expect(room.players.teamCounts().bravo).toBe(0);
  });

  test('delta < 2 → no flips', () => {
    const room = new Room('rb3', null, '', TEAM_SPEC);
    room.players.addPlayer('bot1', 'alpha');
    room.players.addPlayer('bot2', 'alpha');
    room.players.addPlayer('b1', 'bravo');
    // removing a non-player or small skew shouldn't flip 2v1
    room.removePlayerCompletely('nobody', 'test', noop);
    expect(room.players.teamCounts().alpha).toBe(2);
    expect(room.players.teamCounts().bravo).toBe(1);
  });
});
