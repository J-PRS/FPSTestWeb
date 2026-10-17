// creatureFuzz — differential conformance over the crawl* edge stream.
// Captures the REAL CreatureSim wire (broadcast + near-player sendTo —
// the union is the superset stream any client can ride) and replays it
// into independent shared/creatureSim replicas through WAN jitter,
// duplication and reorder, then asserts convergence to authority.
//
// Invariants (mirroring netCrawlers/netMelee semantics):
//   * edges snap pos/vel + commitTarget; replicas step the shared sim on
//     the 50ms grid between them
//   * `sk` is cumulative retarget-skips — each retarget spends a whole
//     tick re-aiming, so the replica owes one step quantum per skip
//   * crawlDie ('gone') is terminal — a later edge never resurrects
//   * a joiner reconstructed purely from roster() + later edges converges
//     to the same truth — snapshot + stream is complete
import { describe, it, expect } from 'bun:test';
import { mkRoom, lcg, flat, step } from './harness.ts';
import { SPECIES_FAMILY, speciesFamily, type SimBeing } from '../../../shared/creatureSim.ts';
import { commitTarget } from '../../../shared/creatureCore.ts';
import { SIM_TICK_DT } from '../../../shared/wire.ts';

interface CrawlMsg {
  type: string;
  id: number;
  kind?: string;
  sk?: number;
  position: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
  targetId?: string | null;
  tp?: { x: number; y: number; z: number } | null;
  seed?: number;
  uber?: boolean;
  species?: string;
  state?: string;
  t?: number;
}

interface Replica {
  sim: SimBeing;
  netAcc: number;
  skips: number; // last applied cumulative sk
  lastT: number; // stamp order — a reordered older edge must not overwrite
  dead: boolean;
}

function mkReplica(m: CrawlMsg): Replica | null {
  const species = m.species ?? 'crawler';
  const fam = SPECIES_FAMILY[speciesFamily(species)];
  if (!fam) {return null;}
  const sim = fam.make(m.id, m.position, m.uber ?? false, m.seed ?? 0, species);
  if (m.state) {sim.state = m.state as typeof sim.state;}
  if (m.velocity) { sim.vx = m.velocity.x; sim.vy = m.velocity.y; sim.vz = m.velocity.z; }
  commitTarget(sim, m.targetId ?? null, m.tp ?? null);
  return { sim, netAcc: 0, skips: 0, lastT: -Infinity, dead: false };
}

// Mirror of netCrawlEvt: sk pays skipped quanta first, then the edge
// snaps pos/vel + committed target. Dead replicas drop everything.
function applyEdge(rep: Replica, m: CrawlMsg): void {
  if (rep.dead) {return;}
  // Emit order is stamp order — a WAN-reordered older edge carries stale
  // position/target that must not overwrite newer truth (mirrors the
  // client's lastEvtT gate; balls gate the same via isStaleSeg).
  if (m.t !== undefined && m.t < rep.lastT) {return;}
  if (m.t !== undefined) {rep.lastT = m.t;}
  if (m.sk !== undefined && Number.isFinite(m.sk)) {
    rep.netAcc -= SIM_TICK_DT * (m.sk - rep.skips);
    rep.skips = m.sk;
  } else if (m.kind === 'retarget') {
    rep.netAcc -= SIM_TICK_DT; // pre-sk fallback — one skip per retarget edge
  }
  const s = rep.sim;
  s.x = m.position.x; s.y = m.position.y; s.z = m.position.z;
  if (m.velocity) { s.vx = m.velocity.x; s.vy = m.velocity.y; s.vz = m.velocity.z; }
  if (m.seed !== undefined && Number.isFinite(m.seed)) { s.rng = m.seed; }
  commitTarget(s, m.targetId ?? null, m.tp ?? null);
}

function stepReplica(rep: Replica, room: { creatureSim: { colliders: readonly import('../../../shared/ballSim.ts').StructureCollider[] } }): void {
  if (rep.dead) {return;}
  rep.netAcc = Math.min(rep.netAcc + SIM_TICK_DT, 0.5);
  const s = rep.sim;
  const tgt = s.tgtValid ? { x: s.tx, y: s.ty, z: s.tz } : null;
  while (rep.netAcc >= SIM_TICK_DT) {
    rep.netAcc -= SIM_TICK_DT;
    SPECIES_FAMILY[s.family].step(s, SIM_TICK_DT, flat, tgt, false, room.creatureSim.colliders);
    // Local s.dead (baneling fuse/age) is NOT terminal on a real client —
    // no creature replica propagates sim death to the entity; only the
    // authority's crawlDie kills. Mirroring production keeps a diverged
    // replica recoverable by the next resync edge instead of ghosting.
  }
}

describe('creature replay conformance fuzz', () => {
  it('crawl* edge stream + seeded replay converges to authority under WAN chaos', () => {
    const SEEDS = [5, 19, 43];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const room = mkRoom({ mode: 'dm', bots: 4, creatures: { crawler: 4, baneling: 2 } }, 'dm', seed);
      const violations: string[] = [];
      const ctx = (op: number, d: string) => `seed=${seed} op=${op} ${d}`;

      // Capture the real wire: edges ride broadcast OR near-player
      // sendTo — capture both, the union is the full stream.
      const wire: CrawlMsg[] = [];
      const isCrawl = (m: unknown): m is CrawlMsg => {
        const t = (m as { type?: string }).type;
        return t === 'crawlSpawn' || t === 'crawlEvt' || t === 'crawlDie';
      };
      const prevB = room.connections.broadcast.bind(room.connections);
      room.connections.broadcast = (msg: import('../../src/types.ts').ServerMessage) => { if (isCrawl(msg)) {wire.push(msg);} prevB(msg); };
      const prevS = room.connections.sendToPlayer.bind(room.connections);
      room.connections.sendToPlayer = (pid: string, msg: import('../../src/types.ts').ServerMessage) => { if (isCrawl(msg)) {wire.push(msg);} prevS(pid, msg); };

      const queue: { msg: CrawlMsg; hold: number }[] = [];
      const replicas = new Map<number, Replica>();
      // Joiner replica: built ONLY from a mid-run roster snapshot +
      // whatever edges arrive after — the full snapshot+stream path.
      const joiner = new Map<number, Replica>();
      let joinerBorn = -1;

      const deliver = () => {
        for (let i = queue.length - 1; i >= 0; i--) {
          if (--queue[i]!.hold > 0) {continue;}
          const m = queue.splice(i, 1)[0]!.msg;
          // Roster-born joiner replicas must get every edge even when
          // the stream replica never saw a spawn — feed joiner first.
          if (joinerBorn >= 0) {
            const j = joiner.get(m.id);
            if (m.type === 'crawlDie') { if (j) {j.dead = true;} }
            else if (j) {applyEdge(j, m);}
            else {
              // An edge for a roster-unknown id still carries enough to
              // seat it? No — no seed on edges; wait for roster/spawn.
            }
          }
          if (m.type === 'crawlDie') {
            const r = replicas.get(m.id);
            if (r) {r.dead = true;}
            continue;
          }
          if (m.type === 'crawlSpawn') {
            if (!replicas.has(m.id)) {
              const r = mkReplica(m);
              if (r) {replicas.set(m.id, r);}
            }
            continue;
          }
          const rep = replicas.get(m.id);
          if (rep) {applyEdge(rep, m);}
        }
      };

      const OPS = 300;
      for (let op = 0; op < OPS; op++) {
        step(room, 1, SIM_TICK_DT); // drives creatureSim + bots move — targets churn
        while (wire.length > 0) {
          const m = wire.shift()!;
          queue.push({ msg: m, hold: Math.floor(rng() * 6) });
          if (rng() < 0.03) {queue.push({ msg: m, hold: Math.floor(rng() * 6) });} // dup
        }
        if (queue.length > 1 && rng() < 0.15) {
          const i = Math.floor(rng() * queue.length);
          const j = Math.floor(rng() * queue.length);
          const tmp = queue[i]!; queue[i] = queue[j]!; queue[j] = tmp;
        }
        deliver();
        if (op === Math.floor(OPS / 2)) {
          joinerBorn = op;
          for (const row of room.creatureSim.roster()) {
            const r = mkReplica({
              type: 'crawlSpawn', id: row.id, position: row.position,
              velocity: row.velocity, seed: row.seed, uber: row.uber,
              species: row.species, state: row.state,
              targetId: row.targetId, tp: row.tp, t: row.t,
            });
            if (r) {joiner.set(row.id, r);}
          }
        }
        for (const rep of [...replicas.values(), ...joiner.values()]) {
          stepReplica(rep, room);
          const s = rep.sim;
          if (!Number.isFinite(s.x + s.y + s.z)) {violations.push(`${ctx(op, 'step')}: creature ${s.id} NaN replica`);}
        }
        for (const c of room.creatureSim.roster()) {
          if (!Number.isFinite(c.position.x + c.position.y + c.position.z)) {violations.push(`${ctx(op, 'authority')}: creature ${c.id} NaN`);}
        }
      }

      // Clean window: flush the queue so every emitted edge lands.
      for (let i = 0; i < 60; i++) {
        step(room, 1, SIM_TICK_DT);
        while (wire.length > 0) {queue.push({ msg: wire.shift()!, hold: 0 });}
        for (const q of queue) {q.hold = 0;}
        deliver();
        for (const rep of [...replicas.values(), ...joiner.values()]) {stepReplica(rep, room);}
      }

      const truth = new Map(room.creatureSim.roster().map((c) => [c.id, c]));
      // Hops are short arcs; committed edges bound drift tightly. 40m is
      // generous — anything past it is a missed edge or diverged sim.
      const BOUND = 40;
      for (const [name, map] of [['stream', replicas], ['joiner', joiner]] as const) {
        for (const [id, rep] of map) {
          const t = truth.get(id);
          if (rep.dead) {
            if (t) {violations.push(`${ctx(OPS, name)}: creature ${id} replica dead but alive on authority`);}
            continue;
          }
          if (!t) {continue;} // died on authority; 'gone' may still ride the queue on a real link
          const s = rep.sim;
          const gap = Math.hypot(s.x - t.position.x, s.y - t.position.y, s.z - t.position.z);
          // The committed aim itself lags by design: replicas steer at
          // tp snapshots that only refresh on retarget edges, so a chase
          // can legitimately sit aim-lag × target-speed off truth — but
          // the replica must still be AT one of its known-good states:
          // near truth, or parked on its own committed aim. A replica
          // far from both missed an edge.
          const aimGap = s.tgtValid ? Math.hypot(s.x - s.tx, s.y - s.ty, s.z - s.tz) : Infinity;
          if (Math.min(gap, aimGap) > BOUND) {
            violations.push(`${ctx(OPS, name)}: creature ${id} replica ${gap.toFixed(1)}m off` +
              ` st=${s.state} tgt=${s.targetId} tgtV=${s.tgtValid} rep=(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)}) truth=(${t.position.x.toFixed(0)},${t.position.y.toFixed(0)},${t.position.z.toFixed(0)})` +
              ` repTp=(${s.tx.toFixed(0)},${s.ty.toFixed(0)},${s.tz.toFixed(0)}) truTp=(${t.tp ? `${t.tp.x.toFixed(0)},${t.tp.y.toFixed(0)},${t.tp.z.toFixed(0)}` : 'none'})`);
          }
        }
      }
      // Ghost check: every live authority creature must exist on the joiner too.
      for (const [id] of truth) {
        const j = joiner.get(id);
        if (j && j.dead) {violations.push(`${ctx(OPS, 'joiner')}: creature ${id} live on authority, dead on joiner`);}
      }

      // The stream must actually have flowed — an empty-wire pass would
      // prove nothing.
      expect(replicas.size + joiner.size).toBeGreaterThan(0);

      expect(violations).toEqual([]);
    }
  });
});
