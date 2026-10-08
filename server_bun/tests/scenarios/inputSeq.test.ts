import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, firstPlayer } from './harness.ts';

describe('scenario: inputMove seq gate', () => {
  it('stale input seqs never touch skiing or status', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);

    // seq=10 commits: ski flag + claimed status channel latch on.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 10,
      input: { forward: 1, right: 0, jump: 0, ski: 1, jet: 0, status: 4 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(1);
    expect(p.status & 4).toBe(4);

    // seq=5 is stale (reordered datagram): the sim drops it AND the status/
    // ski commit is skipped — a replayed old packet must not resurrect
    // flags the client already turned off.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 5,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(1);
    expect(p.status & 4).toBe(4);

    // seq=11 is fresh — commits normally.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 11,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });
    expect(p.skiing).toBe(0);
    expect(p.status & 4).toBe(0);
  });

  it('a piggybacked prev edge heals a lost packet in order', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);

    const applied: number[] = [];
    const q = room.moveSim.queueInput.bind(room.moveSim);
    room.moveSim.queueInput = (pid: string, input: Partial<{ forward: number }>, status = 0, seq?: number) => {
      const ok = q(pid, input, status, seq);
      if (seq !== undefined && ok !== false) applied.push(seq);
      return ok;
    };

    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 1,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });

    // The seq=2 packet died in flight; seq=3 carries it as prev — the
    // shadow must consume 2 before 3, exactly once each.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 3,
      input: { forward: 1, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
      prev: { seq: 2, input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 } },
    });
    expect(applied).toEqual([1, 2, 3]);

    // Happy path: the same prev arriving again after seq=2 already
    // landed is a seq-gate no-op — redundancy never double-applies.
    applied.length = 0;
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 4,
      input: { forward: 0, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
      prev: { seq: 3, input: { forward: 1, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 } },
    });
    expect(applied).toEqual([4]);
  });

  it('held input on the volatile position stream applies newest-first only', () => {
    const room = mkRoom({ bots: 1 });
    const p = firstPlayer(room);
    pin(room, p.id, { x: 0, y: 31, z: 0 });
    room.moveSim.track(p.id, p.position, 0, p.perk);

    const held: ({ f: number } | undefined)[] = [];
    const q = room.moveSim.queueInput.bind(room.moveSim);
    room.moveSim.queueInput = (pid: string, input: Partial<{ forward: number }>, status = 0, seq?: number) => {
      held.push(seq === undefined ? { f: input.forward ?? -99 } : undefined);
      return q(pid, input, status, seq);
    };

    const report = (seq: number, inputSeq: number, f: number) => room.messages.handleMessage(p.id, {
      type: 'position',
      position: { x: 0, y: 31, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 },
      seq, inputSeq, input: { forward: f, right: 0, jump: 0, ski: 0, jet: 0 },
    });

    // Newest frame carrying held state — applies (once per new seq).
    report(1, 0, 1);
    report(2, 0, 0.5);
    // An unordered OLDER position frame must not rewind the input.
    report(1, 0, -1);
    // A frame encoded before inputMove edge 5 (below) rewinds nothing.
    room.messages.handleMessage(p.id, {
      type: 'inputMove', seq: 5,
      input: { forward: -1, right: 0, jump: 0, ski: 0, jet: 0, status: 0 }, rotation: { yaw: 0, pitch: 0 },
    });
    report(3, 3, 1); // inputSeq=3 < consumed 5 → stale held state
    // A frame stamped at edge 6 — state 6 reaches us even though the
    // inputMove for 6 never arrived: instant heal, no watchdog wait.
    report(4, 6, -1);
    expect(held.filter((x): x is { f: number } => x !== undefined).map((x) => x.f))
      .toEqual([1, 0.5, -1]);
  });
});
