import { describe, it, expect } from 'bun:test';
import { mkRoom, pin, seat, twoPlayers } from './harness.ts';
import { decodeTickFrame, type WireTickPlayer, type TickDecodePool } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { STATUS } from '../../../shared/status.ts';
import { simMs, simNow } from '../../src/simClock.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

// Wire-invisible cloak: the record itself must not reach non-teammates
// — a visual-only hide still ships the position on the wire.
describe('scenario: cloak wire secrecy', () => {
  const mkFanout = () => {
    const metrics: FanoutMetrics = {
      recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0, recordsScanned: 0, scanNs: 0, frameNs: 0,
    };
    return new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
  };

  it('a cloaked enemy emits no record; a teammate still sees the ghost', () => {
    const room = mkRoom({ bots: 3 });
    const [a, b] = twoPlayers(room);
    const c = room.players.addPlayer('p3', 'bravo');
    seat(room, a.id); seat(room, b.id); seat(room, c.id);
    a.team = 'alpha'; b.team = 'bravo'; c.team = 'bravo';
    pin(room, a.id, { x: 0, y: 31, z: 0 });
    pin(room, b.id, { x: 20, y: 31, z: 0 });
    pin(room, c.id, { x: -20, y: 31, z: 0 });
    b.status = STATUS.CLOAK;
    b.lastFireSim = simMs(-1e9); // long past the shoot-reveal window

    const roster = new Map<number, string>();
    const pool: TickDecodePool = { slots: [] as WireTickPlayer[], byId: new Map(), resolveId: (w) => roster.get(w) };
    const seen = new Map<string, Set<string>>();
    const prevBroadcast = room.connections.broadcast;
    room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
      if (m.type === 'wireIds') {
        for (const [wid, id] of Object.entries((m as { add?: Record<number, string> }).add ?? {})) {roster.set(Number(wid), id);}
      }
      return prevBroadcast.call(room.connections, m, exclude);
    };
    room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
      const f = decodeTickFrame(data, pool);
      if (f) {seen.set(pid, new Set([...f.updates].slice(0, f.count).map((u) => u.playerId)));}
      return 'sent';
    };

    const fanout = mkFanout();
    const players = room.players.getAllPlayers();
    const tick = () => {
      b.position.z = (room.tickSeq % 2) * 2; // keep B out of suppression
      room.tickSeq++;
      seen.clear();
      fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
    };

    tick(); // mint wireIds (first emit is a full record for everyone)
    tick(); // b is now minted — second emit exercises the cloak gate
    expect(seen.get(a.id)?.has(b.id)).toBe(false); // enemy: no record at all
    expect(seen.get(c.id)?.has(b.id)).toBe(true);  // teammate: still streams

    // Shoot-reveal: a fire stamp inside the window re-admits the record.
    b.lastFireSim = simMs(simNow());
    tick();
    expect(seen.get(a.id)?.has(b.id)).toBe(true);
  });
});
