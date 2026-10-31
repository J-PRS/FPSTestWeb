import { describe, expect, test } from 'bun:test';
import { mkRoom, seat, freeze } from './harness.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
import { decodeTickFrame } from '../../../shared/wire.ts';
import type { WireTickPlayer } from '../../../shared/wire.ts';
import type { Room } from '../../src/Room.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

/** Stop-tier (Nucleus stop-vs-cull): a far AND near-static seat
 *  replicates nothing on its sparse cadence — the receiver's retained
 *  ~0-vel ghost IS the truth. The staggered heal-fulls still flow
 *  (r.force bypass), so the conn's decode basis stays fresh and an
 *  un-stop needs no re-entry handshake: the next masked delta decodes
 *  right. Nothing on the wire says a record stopped. */
describe('stop tier', () => {
  const mkFanout = (): [TickFanout, FanoutMetrics] => {
    const metrics: FanoutMetrics = { recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
      recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0 };
    return [new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {})), metrics];
  };

  /** Decode the observer's tick frames into playerId→tickSeq presence. */
  const watchConn = (room: Room, observer: string): { presentAt: Map<string, Set<number>>; decode: () => void } => {
    const roster = new Map<number, string>();
    const pool = { slots: [] as WireTickPlayer[], byId: new Map<number, WireTickPlayer>(), resolveId: (wid: number) => roster.get(wid) };
    const presentAt = new Map<string, Set<number>>();
    const prevB = room.connections.broadcast;
    room.connections.broadcast = (m: ServerMessage, ex?: string): void => {
      if (m.type === 'wireIds') {
        const w = m as { add?: Record<number, string>; remove?: number[] };
        for (const [wid, id] of Object.entries(w.add ?? {})) {roster.set(Number(wid), id);}
        for (const wid of w.remove ?? []) {roster.delete(wid);}
      }
      prevB.call(room.connections, m, ex);
    };
    const prevBin = room.connections.sendBinaryToPlayer;
    room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
      if (pid !== observer) {return prevBin.call(room.connections, pid, data);}
      const f = decodeTickFrame(data, pool);
      const seen = new Set<string>();
      for (let i = 0; f && i < f.count; i += 1) {
        const u = f.updates[i]!;
        if (u.playerId) {seen.add(u.playerId);}
      }
      const tick = room.tickSeq;
      for (const id of seen) {
        let s = presentAt.get(id);
        if (!s) {s = new Set(); presentAt.set(id, s);}
        s.add(tick);
      }
      return 'sent';
    };
    return { presentAt, decode: (): void => { room.connections.broadcast = prevB; room.connections.sendBinaryToPlayer = prevBin; } };
  };

  /** One sim-tick: 50ms of fake wall time (suppression needs >250ms to
   *  re-arm heartbeats — 40 real-ms drains would eat every record). */
  let fakeNow = wallNow();
  const drain = (room: Room, fanout: TickFanout): void => {
    room.tickSeq += 1;
    fakeNow = (fakeNow + 50) as typeof fakeNow;
    const players = room.players.getAllPlayers();
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, fakeNow));
  };

  test('far+static replicates nothing on sparse cadence; heal-fulls still land', () => {
    const room = mkRoom({}, 'dm');
    const observer = 'obs';
    const near = 'near', farStill = 'farStill', farFast = 'farFast';
    for (const id of [observer, near, farStill, farFast]) {room.players.addPlayer(id);}
    // Mover needs velocity — freeze() pins the shadow; set wire fields.
    const p = room.players.getPlayer(farFast)!;
    p.velocity = { x: 25, y: 0, z: 0 }; // >12 m/s → never stopped
    freeze(room, observer, { x: 0, y: 60, z: 0 });
    freeze(room, near, { x: 100, y: 60, z: 0 });
    freeze(room, farStill, { x: 700, y: 60, z: 0 });  // >600m, spd 0 → stop-eligible
    freeze(room, farFast, { x: 700, y: 60, z: 50 });   // >600m, 25m/s → sparse, not stopped
    for (const id of [observer, near, farStill, farFast]) {
      const pp = room.players.getPlayer(id)!;
      pp.hasReceivedPosition = true;
      pp.isBot = true; // human seats need a position report or the record skips
    }
    seat(room, observer);

    const [fanout, metrics] = mkFanout();
    const w = watchConn(room, observer);
    // tickSeq must clear the introSeq window (first ~20 ticks full-force
    // every record — the test's stop/quiet assertions start after it).
    for (let t = 0; t < 40; t += 1) {drain(room, fanout);}
    w.decode();

    const farWid = room.wireIds.get(farStill)!;
    const farTicks = w.presentAt.get(farStill) ?? new Set<number>();
    const farFastTicks = w.presentAt.get(farFast) ?? new Set<number>();
    const nearTicks = w.presentAt.get(near) ?? new Set<number>();
    // Post-window (tickSeq>20): the far-static seat appears ONLY on
    // staggered-full ticks — count which seqs those should be.
    const expectedFulls = new Set<number>();
    for (let seq = 21; seq <= 40; seq += 1) {if ((seq + farWid) % 15 === 0) {expectedFulls.add(seq);}}
    const lateFar = new Set([...farTicks].filter((t) => t > 20));
    for (const t of lateFar) {expect(expectedFulls.has(t), `stopped seat sent on non-full tick ${t}`).toBe(true);}
    // A far MOVER keeps its sparse cadence — present on non-full ticks.
    const lateFast = new Set([...farFastTicks].filter((t) => t > 20));
    expect([...lateFast].some((t) => !expectedFulls.has(t))).toBe(true);
    // The near seat rides the tier-1 cadence — every built record lands
    // (static heartbeats suppress to ~4Hz, still >> the far seat's fulls).
    expect(nearTicks.size).toBeGreaterThan(lateFar.size);
    expect(metrics.recordsStopped).toBeGreaterThan(0);
  });
});
