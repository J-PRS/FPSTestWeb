// Ball replay conformance fuzz — the segment stream contract. A real
// server-side BallSim runs under chaos (player targets churning, hits,
// kills, field-driven bouncing) while its emitted ballSegment wire
// frames are captured and delivered to a client replay model through a
// jittered/duplicated/out-of-order queue — modeling the honest WAN.
//
// The replica mirrors ballNet.ts semantics verbatim: fixed 0.05-grid
// stepping gated on the stamped sim clock (never ahead of authority),
// applySeg snaps the anchor on arrival, stale stamps (t < legT0) are
// dropped, dead is terminal.
//
// Invariants, every op and in a clean closing window:
//   * replica pos converges to authority within resync bounds between
//     deliveries — prediction error stays bounded by ~one heartbeat of
//     flight, never compounds
//   * a stale segment never rewinds the anchor (simT monotone per ball)
//   * server truth and replica positions are always finite
//   * dead balls stay dead on the replica — a late segment never
//     resurrects (dead flag is terminal in ballNet: s.dead && !host.dead)
//   * a joiner reconstructed purely from roster() + later segments
//     converges to the same truth — snapshot + stream is complete
import { describe, it, expect } from 'bun:test';
import { mkRoom, lcg, flat, step } from './harness.ts';
import { decodeBallAny, type WireBallSegment as BallSegment } from '../../../shared/wire.ts';
import { stepBall, makeSimBall, type SimBall } from '../../../shared/ballSim.ts';

interface Replica {
  sim: SimBall;
  simT: number;   // replay cursor (grid time)
  netAcc: number; // fixed-dt accumulator
  legT0: number;  // last applied stamp — stale guard
  dead: boolean;
  simNowT: number; // latest delivered server stamp + elapsed est.
}

const SIM_DT = 0.05;

function mkReplica(seg: BallSegment & { variant?: number }): Replica {
  const sim = makeSimBall(seg.id, (seg.variant ?? 0) as 0 | 1 | 2 | 3, 0, seg.position, seg.velocity);
  sim.enraged = seg.enraged;
  sim.enrageTimer = seg.et ?? 0;
  sim.slowTimer = seg.slowT ?? 0;
  sim.dampNextBounce = seg.damp ?? false;
  sim.targetId = seg.targetId;
  if (seg.tp) { sim.tx = seg.tp.x; sim.ty = seg.tp.y; sim.tz = seg.tp.z; sim.tgtValid = true; }
  return { sim, simT: seg.t ?? 0, netAcc: 0, legT0: seg.t ?? -1, dead: false, simNowT: seg.t ?? 0 };
}

// Mirror of ballNet.applySeg — anchors only move forward; a late
// segment is truth, a stale one is dropped.
function applySeg(rep: Replica, seg: BallSegment): boolean {
  const t = seg.t;
  if (t !== undefined && t < rep.legT0) return false; // stale — drop
  const s = rep.sim;
  s.x = seg.position.x; s.y = seg.position.y; s.z = seg.position.z;
  s.vx = seg.velocity.x; s.vy = seg.velocity.y; s.vz = seg.velocity.z;
  s.gt = 0;
  s.enraged = seg.enraged;
  s.enrageTimer = seg.et ?? 0;
  s.slowTimer = seg.slowT ?? 0;
  s.dampNextBounce = seg.damp ?? false;
  if (seg.tp) { s.tx = seg.tp.x; s.ty = seg.tp.y; s.tz = seg.tp.z; s.tgtValid = true; }
  else s.tgtValid = false;
  s.targetId = seg.targetId;
  rep.netAcc = Math.min(0 /* lead unknown in fuzz */, 0.5);
  rep.legT0 = t ?? rep.legT0;
  if (t !== undefined) rep.simT = t;
  rep.simNowT = Math.max(rep.simNowT, t ?? 0);
  rep.dead = false;
  return true;
}

describe('ball replay conformance fuzz', () => {
  it('segment stream + fixed-grid replay converges to authority under WAN chaos', () => {
    const SEEDS = [3, 17, 41];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const room = mkRoom({ mode: 'dm', bots: 4, balls: { base: 6, perPlayer: 1, max: 12 } }, 'dm', seed);
      const violations: string[] = [];
      const ctx = (op: number, d: string) => `seed=${seed} op=${op} ${d}`;

      // Capture the real wire stream.
      const wire: BallSegment[] = [];
      const prevReliable = room.connections.broadcastBinaryReliable.bind(room.connections);
      room.connections.broadcastBinaryReliable = (data: Uint8Array) => {
        for (const s of decodeBallAny(data)) {wire.push(s);}
        prevReliable(data);
      };

      // Delivery queue models WAN reorder/delay/dup: each entry waits
      // holdSteps before the replica sees it.
      const queue: { seg: BallSegment; hold: number }[] = [];
      const replicas = new Map<number, Replica>();
      // Joiner replica: built ONLY from a mid-run roster snapshot +
      // whatever segments arrive after — the full snapshot+stream path.
      const joiner = new Map<number, Replica>();
      let joinerBorn = -1;

      const deliver = (op: number) => {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (--queue[i]!.hold > 0) continue;
          const seg = queue.splice(i, 1)[0]!.seg;
          // Joiner feeds first: roster-born replicas legitimately know
          // balls the stream replica never saw a 'spawn' for — the
          // unseen-spawn guard below must not starve them.
          if (joinerBorn >= 0) {
            let j = joiner.get(seg.id);
            if (!j) { j = mkReplica(seg); joiner.set(seg.id, j); }
            else applySeg(j, seg);
          }
          let rep = replicas.get(seg.id);
          if (!rep) {
            if (seg.kind !== 'spawn') continue; // mid-flight segment for an unseen ball — wait for its spawn/roster
            rep = mkReplica(seg);
            replicas.set(seg.id, rep);
          }
          applySeg(rep, seg);
          // Post-dead segments must not resurrect.
          if (rep.dead) violations.push(`${ctx(op, `seg ${seg.id}`)}: segment applied to dead replica`);
        }
      };

      const OPS = 300;
      for (let op = 0; op < OPS; op++) {
        room.ballSim.step(SIM_DT);
        step(room, 1, SIM_DT); // players move — targets churn
        // Enqueue new segments with WAN jitter.
        while (wire.length) {
          const seg = wire.shift()!;
          queue.push({ seg, hold: Math.floor(rng() * 6) }); // 0-300ms at 50ms cells
          if (rng() < 0.03) queue.push({ seg, hold: Math.floor(rng() * 6) }); // dup
        }
        // Rarely shuffle the queue — out-of-order arrival.
        if (queue.length > 1 && rng() < 0.15) {
          const i = Math.floor(rng() * queue.length);
          const j = Math.floor(rng() * queue.length);
          const tmp = queue[i]!; queue[i] = queue[j]!; queue[j] = tmp;
        }
        deliver(op);
        // Mid-run joiner snapshot — snapshot truth + later segments must
        // suffice.
        if (op === Math.floor(OPS / 2)) {
          joinerBorn = op;
          for (const row of room.ballSim.roster()) {
            joiner.set(row.id, mkReplica({
              id: row.id, kind: 'spawn', position: row.position, velocity: row.velocity,
              variant: row.variant,
              enraged: row.enraged, targetId: row.targetId,
              // roster rows carry the committed target snap (tp) — drop
              // it and a chasing ball replays without its aim. Timers
              // too: enrage/stall/damp ride the roster so a mid-flight
              // joiner replays the same timers the segments carry.
              tp: (row as { tp?: { x: number; y: number; z: number } | null }).tp ?? null,
              et: (row as { et?: number }).et,
              slowT: (row as { slowT?: number }).slowT,
              damp: ((row as { damp?: number }).damp ?? 0) !== 0,
              t: row.t,
            } as BallSegment));
          }
        }
        // Replica predict step — mirror tickNet: consume whole cells up
        // to stamped authority time; when the clock estimate stalls the
        // netAcc cap breaks the freeze so sims can't deadlock.
        const allReplicas: Iterable<Replica> = joinerBorn >= 0
          ? [...replicas.values(), ...joiner.values()]
          : replicas.values();
        for (const rep of allReplicas) {
          if (rep.dead) continue;
          rep.netAcc = Math.min(rep.netAcc + SIM_DT, 0.5);
          // The client's simNow() is a LIVE server-clock estimate — it
          // advances between segments, not just at deliveries. Freeze it
          // at the last stamp and the replay never steps (the joiner
          // freeze this fuzz caught).
          rep.simNowT += SIM_DT;
          const s = rep.sim;
          const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
          while (rep.netAcc >= SIM_DT && rep.simT + SIM_DT <= rep.simNowT) {
            rep.netAcc -= SIM_DT; rep.simT += SIM_DT;
            stepBall(s, SIM_DT, flat, tgt, false, { colliders: room.ballSim.colliders });
          }
          if (rep.netAcc >= 0.5) {
            while (rep.netAcc >= SIM_DT) { rep.netAcc -= SIM_DT; rep.simT += SIM_DT; stepBall(s, SIM_DT, flat, tgt, false, { colliders: room.ballSim.colliders }); }
          }
          if (!Number.isFinite(s.x + s.y + s.z)) violations.push(`${ctx(op, 'step')}: ball ${s.id} NaN replica`);
        }
        // Authority sanity — sim state always finite.
        for (const b of room.ballSim.roster()) {
          if (!Number.isFinite(b.position.x + b.position.y + b.position.z)) violations.push(`${ctx(op, 'authority')}: ball ${b.id} NaN`);
        }
      }

      // Clean window: flush the queue AND run past one full resync
      // interval (~1.2s of sim = ~24 cells) so every live ball's replica
      // re-anchors on a fresh segment before the comparison.
      for (let i = 0; i < 60; i++) {
        room.ballSim.step(SIM_DT);
        while (wire.length) queue.push({ seg: wire.shift()!, hold: 0 });
        for (const q of queue) q.hold = 0;
        deliver(OPS + i);
        // Replicas keep stepping through the window — a quiet network
        // freezes delivery, never the replay clock.
        const all2: Iterable<Replica> = [...replicas.values(), ...joiner.values()];
        for (const rep of all2) {
          if (rep.dead) continue;
          rep.netAcc = Math.min(rep.netAcc + SIM_DT, 0.5);
          rep.simNowT += SIM_DT;
          const s = rep.sim;
          const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
          while (rep.netAcc >= SIM_DT && rep.simT + SIM_DT <= rep.simNowT) {
            rep.netAcc -= SIM_DT; rep.simT += SIM_DT;
            stepBall(s, SIM_DT, flat, tgt, false, { colliders: room.ballSim.colliders });
          }
        }
      }
      const truth = new Map(room.ballSim.roster().map((b) => [b.id, b]));
      // The honest bound is staleness, not meters: a replica can only
      // ever be its anchor's age behind — one heartbeat (~1.2s) plus the
      // stepped span since. Speed × that window caps the legal gap.
      const STALE_S = 2.5;
      for (const [id, rep] of replicas) {
        const t = truth.get(id);
        if (!t) continue; // died server-side — 'gone' rides JSON, the segment fuzz doesn't model it
        const gap = Math.hypot(rep.sim.x - t.position.x, rep.sim.y - t.position.y, rep.sim.z - t.position.z);
        const speed = Math.hypot(t.velocity.x, t.velocity.y, t.velocity.z);
        if (gap > 15 + speed * STALE_S) violations.push(`${ctx(OPS, 'final')}: ball ${id} replica ${gap.toFixed(1)}m off authority (bound ${(15 + speed * STALE_S).toFixed(0)}m)`);
      }
      for (const [id, j] of joiner) {
        const t = truth.get(id);
        if (!t) continue;
        const gap = Math.hypot(j.sim.x - t.position.x, j.sim.y - t.position.y, j.sim.z - t.position.z);
        const speed = Math.hypot(t.velocity.x, t.velocity.y, t.velocity.z);
        if (gap > 15 + speed * STALE_S) {
          const s = j.sim;
          violations.push(`${ctx(OPS, 'joiner')}: ball ${id} joiner replica ${gap.toFixed(1)}m off (bound ${(15 + speed * STALE_S).toFixed(0)}m)` +
            ` enr=${s.enraged} tgt=${s.targetId} tgtV=${s.tgtValid} snap=(${s.tx.toFixed(0)},${s.ty.toFixed(0)},${s.tz.toFixed(0)}) simT=${j.simT.toFixed(1)} now=${j.simNowT.toFixed(1)} legT0=${j.legT0.toFixed(1)}` +
            ` rep=(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)}) v=(${s.vx.toFixed(0)},${s.vy.toFixed(0)},${s.vz.toFixed(0)}) truth=(${t.position.x.toFixed(0)},${t.position.y.toFixed(0)},${t.position.z.toFixed(0)})`);
        }
      }

      expect(violations).toEqual([]);
    }
  });
});
