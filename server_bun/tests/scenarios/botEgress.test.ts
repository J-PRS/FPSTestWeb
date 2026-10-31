import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, seat } from './harness.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';

// Regression: fanout used to encode and count a tick frame for every
// player, including server bots with no socket. In a 1-human/11-bot room
// that made /metrics report ~12x the real egress (and burned the same
// encode CPU for frames that went nowhere). Only live sockets get frames.
describe('scenario: tick egress counts live recipients only', () => {
  it('a bot-filled room sends one frame to the human, not one per bot', () => {
    const room = mkRoom({ bots: 3 });
    const human = room.players.addPlayer('HUMAN', 'alpha', 'none', 'medium');
    pin(room, human.id, { x: 0, y: 31, z: 0 });
    human.hasReceivedPosition = true;
    human.lastSeen = wallNow();
    seat(room, human.id);

    const metrics: FanoutMetrics = {
      recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0,
    };
    const fanout = new TickFanout(metrics,
      (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
    const sent: Array<{ id: string; bytes: number }> = [];
    room.connections.sendBinaryToPlayer = (id: string, data: Uint8Array) => {
      sent.push({ id, bytes: data.byteLength });
      return 'sent';
    };

    const players = room.players.getAllPlayers();
    expect(players.size).toBe(4); // 3 bots + 1 live human
    room.tickSeq++;
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));

    // Exactly one wire frame: the human's. The bots are records in that
    // frame, not recipients of their own.
    expect(sent.map((s) => s.id)).toEqual([human.id]);
    expect(metrics.bytesSent).toBe(sent[0]!.bytes);
    expect(metrics.recordsSent).toBeGreaterThan(0);
  });
});
