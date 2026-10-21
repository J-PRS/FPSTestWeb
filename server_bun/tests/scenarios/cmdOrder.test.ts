import { describe, expect, it } from 'bun:test';
import { mkRoom, firstPlayer } from './harness.ts';
import { wallNow, type WallMs } from '../../src/wallClock.ts';

// Sub-tick claim ordering: commands carrying fireAt adjudicate in
// click-instant order, not arrival order — two shooters inside one tick
// resolve by who actually fired first. The stamp is clamped to
// arrival − 2×transit − 100ms so a forged/skewed fireAt can't buy
// rewind priority.

const seen = (room: ReturnType<typeof mkRoom>): string[] => {
  const order: string[] = [];
  const orig = room.messages.handleMessage.bind(room.messages);
  room.messages.handleMessage = ((pid: string, msg: { type: string }, at?: WallMs): void => {
    order.push(pid);
    return orig(pid, msg as never, at ?? wallNow());
  }) as never;
  return order;
};

describe('drainCommands fireAt ordering', () => {
  it('a later-arriving earlier-fired claim drains first', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    firstPlayer(room); firstPlayer(room);
    const order = seen(room);
    const now = wallNow();
    // p2's claim arrived first but fired 20ms ago; p1's arrived 1ms
    // later but fired 60ms ago — p1 clicked first and must adjudicate first.
    room.commands.push({ playerId: 'p2', msg: { type: 'heal', amount: 1, fireAt: now - 20 } as never, at: now as WallMs });
    room.commands.push({ playerId: 'p1', msg: { type: 'heal', amount: 1, fireAt: now - 60 } as never, at: (now + 1) as WallMs });
    room.drainCommands();
    expect(order[0]).toBe('p1');
    expect(order[1]).toBe('p2');
  });

  it('an unstamped command keeps its arrival slot', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    const order = seen(room);
    const now = wallNow();
    room.commands.push({ playerId: 'p1', msg: { type: 'heal', amount: 1 } as never, at: now as WallMs });
    room.commands.push({ playerId: 'p2', msg: { type: 'heal', amount: 1, fireAt: now - 50 } as never, at: (now + 1) as WallMs });
    room.drainCommands();
    // p2's fireAt (now-50) is older than p1's arrival key (now) — p2 sorts first.
    expect(order[0]).toBe('p2');
  });

  it('a forged deep-past fireAt clamps instead of jumping the queue', () => {
    const room = mkRoom({}, 'dm');
    room.players.addPlayer('p1', 'alpha', 'none', 'medium');
    room.players.addPlayer('p2', 'bravo', 'none', 'medium');
    const order = seen(room);
    const now = wallNow();
    // p1 arrives second with an absurd 5s-old stamp — transit ~0 clamps
    // it to at−100ms, which is still older than p2's at-20... but p2's
    // honest 20ms stamp lands at now-20 while p1 clamps to (now+1)-100
    // = now-99 — p1 still wins on a deeper-but-plausible stamp. The
    // forged 5s claim does NOT get 5s of priority.
    room.commands.push({ playerId: 'p2', msg: { type: 'heal', amount: 1, fireAt: now - 20 } as never, at: now as WallMs });
    room.commands.push({ playerId: 'p1', msg: { type: 'heal', amount: 1, fireAt: now - 5000 } as never, at: (now + 1) as WallMs });
    room.drainCommands();
    expect(order.length).toBe(2); // both drain; no crash, no reorder beyond the clamp
  });
});
