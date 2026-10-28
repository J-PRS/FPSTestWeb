// Shared differential-fuzz machinery: the thing every conformance fuzz
// reuses. A fuzz spec owns its OP SET (what chaos can happen) and its
// INVARIANTS (what must always be true); the kit owns the transport
// model (reliable msgs vs lossy frames), the replica decode endpoints,
// and the convergence oracle (does the receiver's view match room
// truth once the link goes quiet).
//
// The class of bug this kills isn't "case X didn't work" — it's EVERY
// ordering of state-machine edges against the real code paths. Any
// violation names a bug; every future bug becomes a new op or a new
// invariant.
import type { Room } from '../../src/Room.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { TickDecodePool } from '../../../shared/wire.ts';
import { decodeTickFrame } from '../../../shared/wire.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { wallNow } from '../../src/wallClock.ts';

/** A replica is a client-shaped decode endpoint: wireIds roster events
 *  on the reliable JSON lane, binary frames that may drop/reorder like
 *  QUIC datagrams, a decode pool with a real retained baseline, and a
 *  `held` map = what a client's remote roster would look like. */
export interface FuzzReplica {
  id: string;
  roster: Map<number, string>;
  pool: TickDecodePool;
  held: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean; vel?: { x: number; y: number; z: number } }>;
  violations: string[];
}

/** The transport between room and replicas: two lanes. `msgs` (reliable
 *  JSON: wireIds roster deltas, playerLeft) deliver in order but can lag
 *  frames — a datagram arriving before its roster edge is the mid-join
 *  hazard class. `frames` can drop or reorder outright. */
export interface Lane {
  msgs: ServerMessage[];
  frames: Uint8Array[];
}

export function mkFuzzReplica(id: string): FuzzReplica {
  const roster = new Map<number, string>();
  const pool: TickDecodePool = { slots: [], byId: new Map(), resolveId: (w) => roster.get(w) };
  return { id, roster, pool, held: new Map(), violations: [] };
}

export function fuzzDeliverMsg(rep: FuzzReplica, m: ServerMessage): void {
  if (m.type === 'wireIds') {
    const w = m as { add?: Record<number, string>; remove?: number[] };
    for (const [wid, id] of Object.entries(w.add ?? {})) {rep.roster.set(Number(wid), id);}
    for (const wid of w.remove ?? []) {
      rep.roster.delete(wid);
      // The client's contract: a retired wireId's decode baseline dies
      // with the binding — a recycled id must never inherit it.
      rep.pool.byId?.delete(wid);
    }
  } else if (m.type === 'playerLeft') {
    rep.held.delete((m as { playerId: string }).playerId);
  }
}

export function fuzzDeliverFrame(rep: FuzzReplica, frame: Uint8Array): void {
  const f = decodeTickFrame(frame, rep.pool);
  if (!f) { rep.violations.push('decode:null'); return; }
  for (let i = 0; i < f.count; i++) {
    const u = f.updates[i]!;
    if (!u.playerId) {continue;} // unresolved/dropped record — legal
    // A decoded update must resolve through the CURRENT roster binding
    // — a playerId that doesn't match wireId→playerId means a stale
    // baseline leaked into a reassigned id.
    const bound = rep.roster.get(u.wireId ?? -1);
    if (u.wireId !== undefined && bound !== u.playerId) {
      rep.violations.push(`alias:wireId=${u.wireId} decoded=${u.playerId} bound=${bound ?? 'none'}`);
    }
    rep.held.set(u.playerId, {
      x: u.position.x, y: u.position.y, z: u.position.z,
      health: u.health, isDead: u.isDead, vel: u.velocity ? { ...u.velocity } : undefined,
    });
  }
}

/** Drain a lane: frames may jump ahead of queued msgs (cross-lane
 *  reorder is the production reality) or drop/reorder within frames. */
export function fuzzDrain(rep: FuzzReplica, lane: Lane, rng: () => number): void {
  while (lane.msgs.length > 0 || lane.frames.length > 0) {
    const takeFrame = lane.frames.length > 0 && (lane.msgs.length === 0 || rng() < 0.3);
    if (takeFrame) {
      const i = rng() < 0.15 && lane.frames.length > 1 ? Math.floor(rng() * lane.frames.length) : 0;
      fuzzDeliverFrame(rep, lane.frames.splice(i, 1)[0]!);
    } else {
      fuzzDeliverMsg(rep, lane.msgs.shift()!);
    }
  }
}

/** Mount the production fanout on a room as a sim so step() drives the
 *  exact production ordering (input → sim → fanout), and split the
 *  broadcast/binary sinks into the two transport lanes. Returns a
 *  teardown that restores the room's originals. */
export function mountFuzzFanout(
  room: Room,
  reps: FuzzReplica[],
  lanes: Lane[],
  onRemove?: (room: Room, playerId: string, reason: string) => void,
): () => void {
  const repIds = reps.map((r) => r.id);
  for (const id of repIds) {room.spectators.add(id);}
  const metrics: FanoutMetrics = {
    recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
    recordsSent: 0, recordsTierSkipped: 0, recordsStopped: 0, bytesSent: 0, tickFramesDropped: 0, tickFramesHeld: 0,
  };
  const fanout = new TickFanout(metrics,
    onRemove ?? ((r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {})));
  const fanoutSim = { name: 'fuzz-fanout', tick: () => {
    room.tickSeq++;
    const players = room.players.getAllPlayers();
    fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
  } };
  room.sims.push(fanoutSim);

  const prevBroadcast = room.connections.broadcast;
  const prevSendBin = room.connections.sendBinaryToPlayer;
  room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
    for (const lane of lanes) {lane.msgs.push(m);}
    return prevBroadcast.call(room.connections, m, exclude);
  };
  room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
    const i = repIds.indexOf(pid);
    if (i === -1) {return prevSendBin.call(room.connections, pid, data);}
    // Slice: the frame arena recycles the buffer next encode — a queued
    // view would alias the NEXT player's frame (a real transport copies
    // at send).
    lanes[i]!.frames.push(data.slice());
    return 'sent';
  };
  return () => {
    const i = room.sims.indexOf(fanoutSim);
    if (i !== -1) {room.sims.splice(i, 1);}
    for (const id of repIds) {room.spectators.delete(id);}
    room.connections.broadcast = prevBroadcast;
    room.connections.sendBinaryToPlayer = prevSendBin;
  };
}

/** Convergence oracle: after clean delivery every held entry must match
 *  wire-quantized room truth, no ghost rows, no stale baselines. */
export function assertFuzzConverged(room: Room, reps: FuzzReplica[], ctx: string): void {
  const t = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
  for (const [id, p] of room.players.getAllPlayers()) {
    t.set(id, { x: p.position.x, y: p.position.y, z: p.position.z, health: p.health, isDead: p.isDead });
  }
  for (const rep of reps) {
    for (const [id, h] of rep.held) {
      const tp = t.get(id);
      if (!tp) { rep.violations.push(`${ctx}: ghost ${id}`); continue; }
      if (Math.round(h.x) !== Math.round(tp.x) || Math.round(h.y) !== Math.round(tp.y) || Math.round(h.z) !== Math.round(tp.z)) {
        rep.violations.push(`${ctx}: pos ${id} held(${h.x.toFixed(1)},${h.y.toFixed(1)},${h.z.toFixed(1)}) room(${tp.x.toFixed(1)},${tp.y.toFixed(1)},${tp.z.toFixed(1)})`);
      }
      if (Math.floor(Math.round(h.health) / 4) !== Math.floor(Math.round(tp.health) / 4)) {
        rep.violations.push(`${ctx}: health ${id} held=${h.health} room=${tp.health}`);
      }
      if (h.isDead !== tp.isDead) {rep.violations.push(`${ctx}: isDead ${id} held=${h.isDead} room=${tp.isDead}`);}
    }
    // Rostered players the replica never saw are legal ONLY if their
    // record was suppressed/lost this whole run — after the clean
    // window every live wireId owner must be held.
    for (const [wid, id] of rep.roster) {
      if (t.has(id) && !rep.held.has(id)) {rep.violations.push(`${ctx}: missing ${id} (wireId ${wid})`);}
    }
  }
}
