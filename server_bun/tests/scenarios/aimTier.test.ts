import { describe, expect, test } from 'bun:test';
import { mkRoom, seat, freeze } from './harness.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';
import { decodeTickFrame, type WireTickPlayer } from '../../../shared/wire.ts';
import type { Room } from '../../src/Room.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';

/** Aim promotion: a far target inside the recipient's +-45deg aim cone
 *  emits on the promoted cadence with the full record, not the sparse
 *  speck cadence -- it's the one remote the player can actually hit, so
 *  its ghost must ride interp-rate wire truth. Out-of-cone far records
 *  keep the tier-8 speck path untouched. */
const mkFanout = (): [TickFanout, FanoutMetrics] => {
  const metrics: FanoutMetrics = { recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
    recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0, recordsCapped: 0, recordsAimPromoted: 0, recordsScanned: 0, scanNs: 0, frameNs: 0 };
  return [new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, noop)), metrics];
};

const noop = (..._a: unknown[]): void => undefined;

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
    const n = f ? f.count : 0;
    for (let i = 0; i < n; i += 1) {
      const u = f!.updates[i]!;
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

const lateTicks = (w: { presentAt: Map<string, Set<number>> }, id: string, min: number): Set<number> =>
  new Set([...(w.presentAt.get(id) ?? [])].filter((t) => t > min));

let fakeNow = wallNow();
const drain = (room: Room, fanout: TickFanout): void => {
  room.tickSeq += 1;
  fakeNow = (fakeNow + 50) as typeof fakeNow;
  const players = room.players.getAllPlayers();
  fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, fakeNow));
};

describe('aim promotion', () => {
  test('aimed far targets ride dense full records; out-of-cone stays sparse', () => {
    const room = mkRoom({}, 'dm');
    const observer = 'obs';
    const aimedNear = 'aimedNear', aimedFar = 'aimedFar', offCone = 'offCone';
    for (const id of [observer, aimedNear, aimedFar, offCone]) {room.players.addPlayer(id);}
    // 10 m/s wire velocity on pinned positions: suppression can't eat the
    // records (extrapolation drifts), and 10 <= 12 keeps them under the
    // speed-bump tier so only the aim promotion is exercised.
    for (const id of [aimedNear, aimedFar, offCone]) {room.players.getPlayer(id)!.velocity = { x: 10, y: 0, z: 0 };}
    freeze(room, observer, { x: 0, y: 60, z: 0 });
    // Observer aims +x (cone test is atan2(dx,dz)-yaw → yaw = π/2).
    room.players.getPlayer(observer)!.rotation.yaw = Math.PI / 2;
    freeze(room, aimedNear, { x: 700, y: 60, z: 0 });    // >600m, inside the near gather circle
    freeze(room, aimedFar, { x: 1200, y: 60, z: 0 });    // far cell -- the emitFarCells lane
    freeze(room, offCone, { x: -1200, y: 60, z: 0 });    // same range, behind -- no promotion
    for (const id of [observer, aimedNear, aimedFar, offCone]) {
      const pp = room.players.getPlayer(id)!;
      pp.hasReceivedPosition = true;
      pp.isBot = true; // human seats need a position report or the record skips
    }
    seat(room, observer);

    const [fanout, metrics] = mkFanout();
    const w = watchConn(room, observer);
    for (let t = 0; t < 40; t += 1) {drain(room, fanout);}
    w.decode();

    const nearTicks = lateTicks(w, aimedNear, 20);
    const farTicks = lateTicks(w, aimedFar, 20);
    const offTicks = lateTicks(w, offCone, 20);
    // Promoted lanes: aimedNear every-3rd tick (tier clamp), aimedFar
    // every-2nd tick -- both >> the out-of-cone speck cadence (~1/8).
    expect(nearTicks.size).toBeGreaterThanOrEqual(5);
    expect(farTicks.size).toBeGreaterThanOrEqual(5);
    expect(offTicks.size).toBeGreaterThan(0);
    expect(offTicks.size).toBeLessThan(nearTicks.size);
    expect(offTicks.size).toBeLessThan(farTicks.size);
    expect(metrics.recordsAimPromoted).toBeGreaterThan(0);
  });
});
