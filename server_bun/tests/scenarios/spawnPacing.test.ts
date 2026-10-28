import { describe, expect, test } from 'bun:test';
import { freeze, mkRoom, seat } from './harness.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { MessageHandler } from '../../src/MessageHandler.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { Room } from '../../src/Room.ts';

/** Spawn pacing: a joiner's world admits K seats per tick, not the whole
 *  roster in gameState. Seats never double-announce, mid-window leavers
 *  drop silently, and unadmitted seats' records stay gated. */
describe('spawn pacing', () => {
  const mkFanout = (): TickFanout => new TickFanout(
    { recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0,
      tickFramesDropped: 0, tickFramesHeld: 0 } as FanoutMetrics,
    (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));

  const roster = (room: Room, n: number): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `p${i}`;
      const p = room.players.addPlayer(id);
      p.hasReceivedPosition = true;
      freeze(room, id, { x: (i - n / 2) * 80, y: 60, z: (i % 3) * 90 - 90 });
      ids.push(id);
    }
    return ids;
  };

  const drain = (room: Room, fanout: TickFanout): void => {
    const players = room.players.getAllPlayers();
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
  };

  test('gameState ships only the inline seats; the rest admit per tick', () => {
    const room = mkRoom({}, 'dm');
    const ids = roster(room, 10); // joiner + 9 remotes > JOIN_INLINE_SEATS
    const joiner = ids[0]!;
    const sent: ServerMessage[] = [];
    const orig = room.connections.sendToPlayer;
    room.connections.sendToPlayer = (pid, m): void => { if (pid === joiner) {sent.push(m);} else {orig(pid, m);} };
    seat(room, joiner);

    room.messages.sendWorldState(joiner);
    const gs = sent.find((m): boolean => m.type === 'gameState') as unknown as { players: { id: string }[] };
    expect(gs.players.length).toBe(MessageHandler.JOIN_INLINE_SEATS);
    expect(room.admitPending.get(joiner)?.size).toBe(ids.length - 1 - MessageHandler.JOIN_INLINE_SEATS);

    // Drive the drain directly — each tick admits ≤ADMIT_PER_TICK seats
    // via a direct playerJoined (the paced admit rides an ordinary edge).
    const fanout = mkFanout();
    const announces = (): ServerMessage[] => sent.filter((m): boolean => m.type === 'playerJoined');
    for (let t = 0; t < 3 && room.admitPending.has(joiner); t++) {drain(room, fanout);}
    expect(room.admitPending.has(joiner)).toBe(false);
    expect(new Set(announces().map((m): string => (m as { playerId: string }).playerId)).size)
      .toBe(ids.length - 1 - MessageHandler.JOIN_INLINE_SEATS);
  });

  test('ADMIT_PER_TICK caps the drain — a 5-seat backlog admits 4 then 1', () => {
    const room = mkRoom({}, 'dm');
    const ids = roster(room, 6);
    const joiner = ids[0]!;
    const backlog = ids.slice(1);
    seat(room, joiner);
    room.admitPending.set(joiner, new Set(backlog));

    const joined: string[] = [];
    room.connections.sendToPlayer = (pid, m): void => {
      if (pid === joiner && m.type === 'playerJoined') {joined.push((m as { playerId: string }).playerId);}
    };

    const fanout = mkFanout();
    drain(room, fanout);
    expect(joined.length).toBe(4);
    expect(room.admitPending.get(joiner)?.size).toBe(backlog.length - 4);
    drain(room, fanout);
    expect(joined.length).toBe(backlog.length);
    expect(room.admitPending.has(joiner)).toBe(false);
  });
});
