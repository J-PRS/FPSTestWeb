import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, seat } from './harness.ts';
import { decodeTickFrame, type WireTickPlayer, type TickDecodePool } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// K-nearest record cap: a recipient's frame is bounded at MAX_RECORDS
// (32) regardless of roster density — egress stays O(seats x cap), not
// ~quadratic. Culled records are the farthest; their hit/kill truth
// still rides reliable events.
describe('scenario: K-nearest record cap', () => {
  it('40 bodies in engagement range emit 32 records; the 8 farthest are culled', () => {
    const room = mkRoom({ bots: 1 });
    const r0 = [...room.players.getAllPlayers().values()][0]!;
    seat(room, r0.id);
    pin(room, r0.id, { x: 0, y: 31, z: 0 });

    // 32 near at ~50m + 8 far at ~140m — all inside the 150m tier-1 ring,
    // so every record earns a slot on tier grounds; the cap does the cull.
    const nearIds: string[] = [], farIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const p = room.players.addPlayer(`CAP${i}`, 'alpha', 'none', 'medium');
      // Bot seats: a human seat with no position claim is skipRecord'd,
      // and idle past IDLE_KICK_MS is reaped outright.
      p.isBot = true;
      seat(room, p.id);
      const far = i >= 32;
      const ang = i * 0.9;
      const d = far ? 140 : 50;
      pin(room, p.id, { x: Math.cos(ang) * d, y: 31, z: Math.sin(ang) * d });
      (far ? farIds : nearIds).push(p.id);
    }

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
    let r0Count = -1;
    const r0Seen = new Set<string>();
    room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
      const f = decodeTickFrame(data, pool);
      if (f && pid === r0.id) {
        r0Count = f.count;
        for (const u of [...f.updates].slice(0, f.count)) {r0Seen.add(u.playerId);}
      }
      return 'sent';
    };

    const players = room.players.getAllPlayers();
    // Wobble keeps everyone out of the suppression window; intro must be
    // past so the cadence tail isn't exempt-forced.
    room.introSeq = room.tickSeq - 25;
    // Fresh seats are pending admission — the paced admit gate skips their
    // records until it drains (~4/tick). On any tick where the cap binds,
    // capture what r0 saw: everything culled must be a far id.
    let cappedSeen = new Set<string>();
    let cappedCount = -1;
    for (let i = 0; i < 30; i += 1) {
      for (const p of players.values()) {p.position.z += (i % 2) * 2 - 1;}
      room.tickSeq++;
      const before = metrics.recordsCapped;
      r0Seen.clear();
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
      if (metrics.recordsCapped > before) {cappedSeen = new Set(r0Seen); cappedCount = r0Count;}
    }

    const allIds = new Set([...nearIds, ...farIds]);
    expect(metrics.recordsCapped).toBeGreaterThan(0);
    expect(cappedCount).toBeLessThanOrEqual(35); // 32 capped + exempt
    const missing = [...allIds].filter((id) => !cappedSeen.has(id));
    for (const id of missing) {expect(farIds).toContain(id);}

    room.connections.broadcast = prevBroadcast;
  });
});
