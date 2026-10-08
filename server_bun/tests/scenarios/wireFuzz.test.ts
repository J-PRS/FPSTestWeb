// Differential conformance fuzzer for the v4 wire lifecycle.
//
// The bug class this kills isn't "this join/leave case" — it's EVERY
// ordering of joins, leaves, wireId churn, loss, reorder, roster delay
// and silence against the real encode→decode pair. A seeded op stream
// drives the room through random state while queue-transports sit
// between fanout and replicas; after every flush, and in a clean window
// at the end, each replica's decoded view must equal room truth within
// wire quantization. Any violation names a bug — the same failure would
// have caught baseline-less deltas, stale-frame pollution, synced
// fulls, slot-basis reuse and wireId aliasing in one run instead of one
// bug at a time.
import { describe, it, expect } from 'bun:test';
import { mkRoom, step, lcg } from './harness.ts';
import {
  mkFuzzReplica, fuzzDrain, mountFuzzFanout, assertFuzzConverged,
  type FuzzReplica, type Lane,
} from './fuzzKit.ts';
import { wallNow, wallMs } from '../../src/wallClock.ts';
import type { PlayerState } from '../../src/types.ts';

describe('wire conformance fuzz', () => {
  it('replicas converge to room truth under seeded chaos', () => {
    // Seeds ≥2 run the same op engine with different streams — a fixed
    // corpus, not a nightly RNG: a failure replays byte-for-byte.
    const SEEDS = [11, 23, 37, 53, 71, 89, 101, 127];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const room = mkRoom({ bots: 0 }, '', seed);
      const reps: FuzzReplica[] = [mkFuzzReplica('__fuzz_0__'), mkFuzzReplica('__fuzz_1__'), mkFuzzReplica('__fuzz_2__')];
      const lanes: Lane[] = reps.map(() => ({ msgs: [], frames: [] }));
      const teardown = mountFuzzFanout(room, reps, lanes);

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
          if (ids.length > 2) {
            const gone = ids[Math.floor(rng() * ids.length)]!;
            silenced.delete(gone);
            room.removePlayerCompletely(gone, 'fuzz', () => {});
          }
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
          // player would (legally) stay silent forever. A silenced
          // socket that speaks again resumes normal records.
          const ids = alive();
          if (ids.length) {
            const p = room.players.getPlayer(ids[Math.floor(rng() * ids.length)]!);
            if (p) {
              if (silenced.has(p.id)) {
                p.lastSeen = wallNow();
                silenced.delete(p.id);
              } else {
                p.lastSeen = wallMs(wallNow() - 6000 - Math.floor(rng() * 2000));
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
        for (const [i, rep] of reps.entries()) if (rng() < 0.7) fuzzDrain(rep, lanes[i]!, rng);
      }

      // Clean window: flush everything, then enough ticks for every
      // staggered full record (15-tick window) to land on every replica.
      for (let t = 0; t < 20; t++) {
        step(room, 1);
        for (const [i, rep] of reps.entries()) fuzzDrain(rep, lanes[i]!, rng);
      }
      assertFuzzConverged(room, reps, `seed=${seed}`);
      teardown();

      const violations = reps.flatMap((rep) => rep.violations.map((v) => `${rep.id}:${v}`));
      expect(violations).toEqual([]);
    }
  });
});
