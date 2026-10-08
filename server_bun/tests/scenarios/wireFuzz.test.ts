// Differential conformance fuzzer for the v4 wire lifecycle.
//
// The bug class this kills isn't "this join/leave case" — it's EVERY
// ordering of joins, leaves, wireId churn, loss, reorder, roster delay
// and silence against the real encode→decode pair. A seeded op stream
// drives the room through random state while a queue-transport sits
// between fanout and replica; after every flush, and in a clean window
// at the end, the replica's decoded view must equal room truth within
// wire quantization. Any violation names a bug — the same failure would
// have caught baseline-less deltas, stale-frame pollution, synced
// fulls, slot-basis reuse and wireId aliasing in one run instead of one
// bug at a time.
import { describe, it, expect } from 'bun:test';
import { mkRoom, step, lcg } from './harness.ts';
import { TickFanout, type FanoutMetrics } from '../../src/tickRecords.ts';
import { decodeTickFrame, type WireTickPlayer, type TickDecodePool } from '../../../shared/wire.ts';
import { wallNow } from '../../src/wallClock.ts';
import type { ServerMessage } from '../../../shared/protocol.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

// A replica is a client-shaped decode endpoint: wireIds roster events on
// the reliable JSON lane, binary frames that may drop/reorder like QUIC
// datagrams, a decode pool with a real retained baseline, and a `held`
// map = what a client's remote roster would look like.
interface Replica {
  roster: Map<number, string>;
  pool: TickDecodePool;
  held: Map<string, { x: number; y: number; z: number; health: number; isDead: boolean; vel?: { x: number; y: number; z: number } }>;
  violations: string[];
}

// The transport between room and replicas: two lanes. `msgs` (reliable
// JSON: wireIds roster deltas, playerLeft) deliver in order but can lag
// frames — a datagram arriving before its roster edge is the mid-join
// hazard class. `frames` can drop or reorder outright.
interface Lane {
  msgs: ServerMessage[];
  frames: Uint8Array[];
}

function mkReplica(): Replica {
  const roster = new Map<number, string>();
  const pool: TickDecodePool = { slots: [], byId: new Map(), resolveId: (w) => roster.get(w) };
  return { roster, pool, held: new Map(), violations: [] };
}

function drain(rep: Replica, lane: Lane, rng: () => number): void {
  // Frames first or interleaved with msgs — datagrams routinely beat the
  // reliable lane on a real link.
  while (lane.msgs.length || lane.frames.length) {
    // ~30% of drains let a frame jump ahead of queued roster msgs
    // (cross-lane reorder), else deliver oldest-available in order.
    const takeFrame = lane.frames.length > 0 && (lane.msgs.length === 0 || rng() < 0.3);
    if (takeFrame) {
      const i = rng() < 0.15 && lane.frames.length > 1 ? Math.floor(rng() * lane.frames.length) : 0;
      const frame = lane.frames.splice(i, 1)[0]!;
      deliverFrame(rep, frame);
    } else {
      deliverMsg(rep, lane.msgs.shift()!);
    }
  }
}

function deliverMsg(rep: Replica, m: ServerMessage): void {
  if (m.type === 'wireIds') {
    const w = m as { add?: Record<number, string>; remove?: number[] };
    for (const [wid, id] of Object.entries(w.add ?? {})) rep.roster.set(Number(wid), id);
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

function deliverFrame(rep: Replica, frame: Uint8Array): void {
  const f = decodeTickFrame(frame, rep.pool);
  if (!f) { rep.violations.push('decode:null'); return; }
  for (let i = 0; i < f.count; i++) {
    const u = f.updates[i]!;
    if (!u.playerId) continue; // unresolved/dropped record — legal
    // Invariant: a decoded update must resolve through the CURRENT
    // roster binding — a playerId that doesn't match wireId→playerId
    // means a stale baseline leaked into a reassigned id.
    const bound = rep.roster.get(u.wireId ?? -1);
    if (u.wireId !== undefined && bound !== u.playerId) {
      rep.violations.push(`alias:wireId=${u.wireId} decoded=${u.playerId} bound=${bound ?? 'none'}`);
    }
    // Invariant: never hold a player the server doesn't have (ghost
    // injection) — caught at assert time vs room truth; here we record
    // it so a violation pins WHO showed up.
    rep.held.set(u.playerId, {
      x: u.position.x, y: u.position.y, z: u.position.z,
      health: u.health, isDead: u.isDead, vel: u.velocity ? { ...u.velocity } : undefined,
    });
  }
}

function truth(room: Room): Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }> {
  const t = new Map<string, { x: number; y: number; z: number; health: number; isDead: boolean }>();
  for (const [id, p] of room.players.getAllPlayers()) {
    t.set(id, { x: p.position.x, y: p.position.y, z: p.position.z, health: p.health, isDead: p.isDead });
  }
  return t;
}

// Convergence check: after clean delivery every held entry must match
// wire-quantized room truth, no ghost rows, no stale baselines.
function assertConverged(room: Room, reps: Replica[], ctx: string): void {
  const t = truth(room);
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
      if (h.isDead !== tp.isDead) rep.violations.push(`${ctx}: isDead ${id} held=${h.isDead} room=${tp.isDead}`);
    }
    // Rostered players the replica never saw are legal ONLY if their
    // record was suppressed/lost this whole run — after the clean
    // window every live wireId owner must be held.
    for (const [wid, id] of rep.roster) {
      if (t.has(id) && !rep.held.has(id)) rep.violations.push(`${ctx}: missing ${id} (wireId ${wid})`);
    }
  }
}

describe('wire conformance fuzz', () => {
  it('replicas converge to room truth under seeded chaos', () => {
    // Seeds ≥2 run the same op engine with different streams — a fixed
    // corpus, not a nightly RNG: a failure replays byte-for-byte.
    const SEEDS = [11, 23, 37, 53, 71, 89, 101, 127];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const room = mkRoom({ bots: 0 }, '', seed);
      const reps = [mkReplica(), mkReplica(), mkReplica()];
      const lanes: Lane[] = reps.map(() => ({ msgs: [], frames: [] }));
      const repIds = reps.map((_, i) => `__fuzz_${i}__`);
      for (const id of repIds) room.spectators.add(id);

      const metrics: FanoutMetrics = {
        recordsBuilt: 0, recordsSuppressed: 0, recordsIdleReaped: 0,
        recordsSent: 0, recordsTierSkipped: 0, bytesSent: 0, tickFramesDropped: 0,
      };
      const fanout = new TickFanout(metrics, (r, pid, reason) => r.removePlayerCompletely(pid, reason, () => {}));
      const fanoutSim = { name: 'fanout', tick: () => {
        room.tickSeq++;
        const players = room.players.getAllPlayers();
        fanout.fanoutRecords(room, players, fanout.buildRecords(room, players, wallNow()));
      } };
      room.sims.push(fanoutSim);

      // Split broadcast/sink so msgs go to the reliable lane and frames
      // (which arrive through sendBinaryToPlayer) go to the lossy lane.
      const prevBroadcast = room.connections.broadcast;
      const prevSendBin = room.connections.sendBinaryToPlayer;
      room.connections.broadcast = (m: ServerMessage, exclude?: string) => {
        for (const lane of lanes) lane.msgs.push(m);
        return prevBroadcast.call(room.connections, m, exclude);
      };
      room.connections.sendBinaryToPlayer = (pid: string, data: Uint8Array) => {
        const i = repIds.indexOf(pid);
        if (i < 0) return prevSendBin.call(room.connections, pid, data);
        // Slice: the frame arena recycles the buffer next encode — a
        // queued view would alias the NEXT player's frame (a real
        // transport copies at send).
        lanes[i]!.frames.push(data.slice());
        return 'sent';
      };

      let joined = 0;
      // A silenced socket writes nothing to truth — production mutations
      // all come from its own inputs. Mutating it while gated on the 2s
      // heartbeat window is a combination production can't produce.
      const silenced = new Set<string>();
      const alive = () => [...room.players.getAllPlayers().keys()];
      const addPlayer = (tag: string) => {
        const id = `fz_${seed}_${tag}`;
        room.players.addPlayer(id);
        const p = room.players.getPlayer(id)!;
        p.hasReceivedPosition = true;
        p.lastSeen = wallNow();
        return p;
      };
      // Two players so fanout has bodies from tick 1.
      addPlayer('a'); addPlayer('b'); joined = 2;

      const OPS = 120;
      for (let op = 0; op < OPS; op++) {
        const roll = rng();
        if (roll < 0.16 && joined < 14) {
          addPlayer(`j${joined++}`);
        } else if (roll < 0.28) {
          const ids = alive();
          if (ids.length > 2) room.removePlayerCompletely(ids[Math.floor(rng() * ids.length)]!, 'fuzz', () => {});
        } else if (roll < 0.62) {
          const ids = alive().filter((id) => !silenced.has(id));
          if (ids.length) {
            const p = room.players.getPlayer(ids[Math.floor(rng() * ids.length)]!) as PlayerState | undefined;
            if (p) {
              const f = Math.floor(rng() * 7);
              if (f === 0) { p.position = { x: (rng() - 0.5) * 800, y: (rng() - 0.5) * 200, z: (rng() - 0.5) * 800 }; room.moveSim.resync(p.id, p.position, 0); }
              else if (f === 1) p.velocity = { x: (rng() - 0.5) * 60, y: (rng() - 0.5) * 40, z: (rng() - 0.5) * 60 };
              else if (f === 2) { p.rotation = { yaw: rng() * Math.PI * 2, pitch: (rng() - 0.5) * 2 }; }
              else if (f === 3) p.health = Math.floor(rng() * p.maxHealth);
              else if (f === 4) p.isDead = !p.isDead;
              else if (f === 5) p.status = Math.floor(rng() * 16);
              else { p.skiing = rng() < 0.5 ? 1 : 0; p.jetting = rng() < 0.5 ? 1 : 0; }
            }
          }
        } else if (roll < 0.72) {
          // Silence: push a player past the 5s heartbeat gate AND age
          // their lastSent — the fuzz runs in wall-milliseconds, so the
          // 2s heartbeat window would never lapse on its own and the
          // player would (legally) stay silent forever.
          const ids = alive();
          if (ids.length) {
            const p = room.players.getPlayer(ids[Math.floor(rng() * ids.length)]!);
            if (p) {
              if (silenced.has(p.id)) {
                // Spoke again: the socket wakes, heartbeat gate lifts.
                p.lastSeen = wallNow();
                silenced.delete(p.id);
              } else {
                p.lastSeen = wallNow() - 6000 - Math.floor(rng() * 2000);
                const lastSent = room.lastSentPositions.get(p.id);
                if (lastSent) lastSent.t = wallNow() - 3000;
                silenced.add(p.id);
              }
            }
          }
        } else if (roll < 0.82) {
          // Loss burst: drop the next 1-4 frames on a random replica —
          // the masked-delta staleness class.
          const lane = lanes[Math.floor(rng() * lanes.length)]!;
          for (let k = 0; k <= Math.floor(rng() * 4) && lane.frames.length; k++) lane.frames.shift();
        } else {
          // Deep reorder: reverse a replica's queued frames — the
          // out-of-order baseline class.
          const lane = lanes[Math.floor(rng() * lanes.length)]!;
          lane.frames.reverse();
        }
        step(room, 1);
        // Each op drains a random subset of lanes — delivery lag is part
        // of the model (a replica behind by N frames is a live client
        // on a bad link).
        for (const [i, rep] of reps.entries()) if (rng() < 0.7) drain(rep, lanes[i]!, rng);
      }

      // Clean window: flush everything, then enough ticks for every
      // staggered full record (15-tick window) to land on every replica.
      for (let t = 0; t < 20; t++) {
        step(room, 1);
        for (const [i, rep] of reps.entries()) drain(rep, lanes[i]!, rng);
      }
      assertConverged(room, reps, `seed=${seed}`);

      room.sims.splice(room.sims.indexOf(fanoutSim), 1);
      for (const id of repIds) room.spectators.delete(id);
      room.connections.broadcast = prevBroadcast;
      room.connections.sendBinaryToPlayer = prevSendBin;

      const violations = reps.flatMap((rep, i) => rep.violations.map((v) => `rep${i}:${v}`));
      expect(violations).toEqual([]);
    }
  });
});
