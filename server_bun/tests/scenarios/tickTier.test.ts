import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, seat, twoPlayers } from './harness.ts';
import { decodeTickFrame, type WireTickPlayer, type TickDecodePool } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { ConnectionManager } from '../../src/ConnectionManager.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Interest-tier hysteresis: a target orbiting a tier boundary must hold
// its send cadence, not flip update rate tick-to-tick — the receiver's
// arrival-interval EMA oscillates instead of settling. Stepping OUT to a
// slower tier requires 15% past the boundary; stepping IN is instant.
describe('scenario: interest tier hysteresis', () => {
  it('a target orbiting 150m keeps tier-1 cadence; real departures still tier out', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    seat(room, a.id);
    seat(room, b.id);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 140, y: 31, z: 0 });

    const roster = new Map<number, string>();
    const pool: TickDecodePool = { slots: [] as WireTickPlayer[], byId: new Map(), resolveId: (w) => roster.get(w) };
    const metrics: FanoutMetrics = {
      recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0,
    };
    const fanout = new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
    const prevBroadcast = room.connections.broadcast;
    room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
      if (m.type === 'wireIds') {
        const w = m as { add?: Record<number, string> };
        for (const [wid, id] of Object.entries(w.add ?? {})) {roster.set(Number(wid), id);}
      }
      return prevBroadcast.call(room.connections, m, exclude);
    };
    let aSeesB = false;
    room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
      const f = decodeTickFrame(data, pool);
      if (f && pid === a.id) {aSeesB = [...f.updates].slice(0, f.count).some((u) => u.playerId === b.id);}
      return 'sent';
    };

    const players = room.players.getAllPlayers();
    const tickOnce = (bx: number): void => {
      // A small z wobble keeps B out of the suppression window — a perfectly
      // still target emits nothing and reads as "skipped" for the wrong reason.
      b.position.x = bx;
      b.position.z = (room.tickSeq % 2) * 2;
      room.tickSeq++;
      aSeesB = false;
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    };

    // Seat B at 140m (tier 1), then orbit the 150m boundary: 140 ↔ 160m.
    // 160m is inside the 15% band (172.5m), so the tier must not step out.
    tickOnce(140);
    for (let i = 0; i < 10; i += 1) {
      tickOnce(i % 2 === 0 ? 160 : 140);
      expect(aSeesB).toBe(true);
    }
    // A real departure (200m > 172.5m) steps out — odd ticks then skip B.
    // Past the intro window first: tickSeq-introSeq<20 forces every
    // record full (bypassing tier skips) so a joiner heals masked
    // deltas fast — that grace is doing its job, not flapping.
    room.introSeq = room.tickSeq - 25;
    tickOnce(200);
    let skipped = 0;
    for (let i = 0; i < 12; i += 1) { tickOnce(200); if (!aSeesB) {skipped += 1;} }
    expect(skipped).toBeGreaterThanOrEqual(3);
    // Closing again applies instantly — first tick back at 140m carries B.
    tickOnce(140);
    expect(aSeesB).toBe(true);

    room.connections.broadcast = prevBroadcast;
  });

  it('per-recipient intro: a fresh seat gets every-tick fulls for the window head, then tiered cadence', () => {
    const room = mkRoom({ bots: 2 });
    const [a, b] = twoPlayers(room);
    seat(room, a.id);
    seat(room, b.id);
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 700, y: 31, z: 0 }); // tier 8 for the room
    // The joiner — seated via introPlayers, not the room-wide introSeq.
    const c = room.players.addPlayer('JOINER', 'alpha', 'none', 'medium');
    seat(room, c.id);
    pin(room, c.id, { x: 0, y: 31, z: 0 });
    room.markIntro(c.id);
    room.introSeq = room.tickSeq - 25; // prove the room window is closed

    const roster = new Map<number, string>();
    const pool: TickDecodePool = { slots: [] as WireTickPlayer[], byId: new Map(), resolveId: (w) => roster.get(w) };
    const metrics: FanoutMetrics = {
      recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0,
    };
    const fanout = new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
    const prevBroadcast = room.connections.broadcast;
    room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
      if (m.type === 'wireIds') {
        const w = m as { add?: Record<number, string> };
        for (const [wid, id] of Object.entries(w.add ?? {})) {roster.set(Number(wid), id);}
      }
      return prevBroadcast.call(room.connections, m, exclude);
    };
    let aSaw = 0, cSaw = 0;
    room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
      const f = decodeTickFrame(data, pool);
      if (f && [...f.updates].slice(0, f.count).some((u) => u.playerId === b.id)) {
        if (pid === a.id) {aSaw += 1;}
        if (pid === c.id) {cSaw += 1;}
      }
      return 'sent';
    };

    const players = room.players.getAllPlayers();
    // Head of the window (INTRO_CADENCE_TICKS): every tick — the decode
    // baseline must punch through loss fast.
    for (let i = 0; i < 5; i += 1) {
      b.position.z = (i % 2) * 2; // keep B out of the suppression window
      room.tickSeq++;
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    }
    expect(cSaw).toBe(5);
    // Tail of the window: the joiner drops to the same tier-8 cadence
    // as everyone else (~2 of 11 ticks) — a stacked join burst no
    // longer pays full cadence for a whole second per seat.
    const cTail0 = cSaw;
    for (let i = 0; i < 11; i += 1) {
      b.position.z = (i % 2) * 2;
      room.tickSeq++;
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    }
    const cTail = cSaw - cTail0;
    expect(cTail).toBeGreaterThanOrEqual(1); // still lands in-window fulls
    expect(cTail).toBeLessThanOrEqual(4);
    expect(aSaw).toBeLessThanOrEqual(4);

    room.connections.broadcast = prevBroadcast;
  });

  it('intro gate: a joiner with a swollen outbox holds ticks (not shed); drained once, the normal cap applies', () => {
    // Fresh seat — gameState + rosters still draining. Tick frames queued
    // behind that burst arrive stale or shed at the cap, so the gate
    // reports 'held' instead of 'backlogged' (loss telemetry stays clean).
    const cm = new ConnectionManager();
    let buffered = 300 * 1024;
    let sent = 0;
    cm.register('P', {
      readyState: 1,
      send: () => { sent += 1; return 1; },
      getBufferedAmount: () => buffered,
      data: {},
    } as never);
    const frame = new Uint8Array(64);
    expect(cm.sendBinaryToPlayer('P', frame)).toBe('held');
    expect(sent).toBe(0);
    // Outbox drains once → gate opens permanently for this seat.
    buffered = 0;
    expect(cm.sendBinaryToPlayer('P', frame)).toBe('sent');
    // A mid-session spike past the real cap is a shed, not a hold.
    buffered = 300 * 1024;
    expect(cm.sendBinaryToPlayer('P', frame)).toBe('backlogged');
    // Re-seat (reclaim) re-arms the gate — the rejoin burst is the same shape.
    cm.register('P', {
      readyState: 1,
      send: () => { sent += 1; return 1; },
      getBufferedAmount: () => buffered,
      data: {},
    } as never);
    expect(cm.sendBinaryToPlayer('P', frame)).toBe('held');
  });
});
