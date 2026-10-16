/**
 * botMpc — the committed-run option for a capper: receding-horizon
 * search over the REAL MoveSim (the same sim the shadow runs) producing
 * a short input schedule, held until it exhausts or the bot diverges.
 * No navmesh, no baked routes — the plan is recomputed from senses
 * every window, so it works on any map.
 *
 * Why search at all: grab speed is decided 5-15s ahead by route choices
 * no per-think local rule can see (crest to crest, bank the tank, dive
 * the face — see _docs/2026-10-16_CAPPER_REACTIVE_LIMITS.md). The
 * reactive stack topped out at ~20-30 m/s grabs; this search drives
 * 33-43 in the offline harness (tools/sweeps/mpcCap.ts) because it
 * simulates the whole dive instead of steering into it.
 *
 * Budget: a transit search is ~150-400 states x 9 ticks (sub-ms to a
 * few ms); inside DEEP_M the run-in earns a wider beam — the dive-pump
 * sequences that produce 40+ m/s grabs die in a shallow beam. Sync
 * cost is bounded per replan, ~1/s per capper; a worker pool is the
 * upgrade path if multiple cappers contend.
 */
import { MoveSim, type MoveSurface, type SimSnapshot } from '../../shared/movement.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import type { RoomMoveSim } from './RoomMoveSim.ts';
import type { BotVec } from '../../shared/botVec.ts';

const STEP_S = 0.15, TICKS = 9;
/** 0.02 threads a 6m capsule at speed, 0.10 carves a flank. */
const DYAWS = [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1];
const TRANSIT_BEAM = 150, TRANSIT_HORIZON = 4;
const DEEP_BEAM = 500, DEEP_HORIZON = 5, DEEP_M = 250;
const DIVERGE_M = 14;
/** Adaptive-beam thresholds: above SLOW the solve is costing the room
 *  more than a tick's worth of budget and the next one goes coarser;
 *  below FAST there is headroom and the beam climbs back to full. */
const SLOW_SEARCH_MS = 120, FAST_SEARCH_MS = 35, MIN_BEAM_SCALE = 0.3;

interface Econ { drain: number; regen: number; emax: number; elock: number }

interface Node {
  snap: SimSnapshot; e: number; parent: number;
  act: { yaw: number; jet: boolean };
  sample: { x: number; z: number; y: number };
  proj: number;
}
interface Plan { act: { yaw: number; jet: boolean }[]; exp: { x: number; z: number; y: number }[]; hit: boolean }

const q = (n: number, s: number) => Math.round(n / s);
function key(s: SimSnapshot['st'], e: number): number {
  return ((q(s.pos.x, 4) * 73_856_093) ^ (q(s.pos.z, 4) * 19_349_663) ^ (q(s.pos.y, 4) * 83_492_791)
    ^ (q(s.vel.x, 4) * 297_121_507) ^ (q(s.vel.z, 4) * 433) ^ (q(s.vel.y, 4) * 16_127)
    ^ (q(e, 5) * 991) ^ (s.onGround ? 1 : 0)) | 0;
}

export class BotMpc {
  /** Temp perf counters — total search wall + replan count. */
  static ms = 0; static n = 0; static acts = 0;
  /** Why a replan happened — the split decides where the remaining cost
   *  is (an exhausted plan is the design working; a divergence churn is a
   *  tolerance problem; a fresh run is a role/objective flap). */
  static why = { miss: 0, exhausted: 0, diverged: 0, retargeted: 0 };
  static {
    process.on('exit', () => {
      if (BotMpc.n) {
        const w = BotMpc.why;
        console.log(`[mpcSearch] replans=${BotMpc.n} wallMs=${BotMpc.ms.toFixed(0)} avg=${(BotMpc.ms / BotMpc.n).toFixed(1)} avgPlanActs=${(BotMpc.acts / BotMpc.n).toFixed(1)} why=miss${w.miss}/exh${w.exhausted}/div${w.diverged}/retgt${w.retargeted}`);
      }
    });
  }
  constructor(
    private readonly moveSim: RoomMoveSim,
    private readonly field: Heightfield | null,
  ) {}

  /** Per-bot run state — the plan is a short input schedule plus the
   *  expected state at each step (divergence from it is what makes a
   *  hit-plan stale). */
  private runs = new Map<string, { plan: Plan; i: number; tgt: BotVec; deepDone: boolean }>();

  /** Adaptive beam. The search runs the REAL MoveSim over ~beam x 14
   *  children x 9 steps a layer ("5.5M sim steps for one 4s transit plan,
   *  profiled: hmField 26% + the solid sweep ~20% -- i.e. the cost is the
   *  sim, not the bookkeeping"), so a beam tuned for an idle box stalls a
   *  room tick when several cappers contend. Scale it to what the box can
   *  actually pay: full quality when there is headroom, coarser instead of
   *  stalling when there isn't. A coarser plan is a worse route; a stalled
   *  tick is a worse MATCH (every bot's movement rides it). */
  private beamScale = 1;
  private tuneBeam(ms: number): void {
    if (ms > SLOW_SEARCH_MS) {this.beamScale = Math.max(MIN_BEAM_SCALE, this.beamScale * 0.7);}
    else if (ms < FAST_SEARCH_MS) {this.beamScale = Math.min(1, this.beamScale * 1.15);}
  }
  private beam(full: number, deep: boolean): number {
    // A/B hook: FPS_MPC_BEAM=1 pins full quality (the owner's comparison
    // against the adaptive scale), any other value overrides the scale.
    const forced = process.env.FPS_MPC_BEAM;
    if (forced) {return Math.max(24, Math.round(full * Number(forced)));}
    // The transit solve is the repeat cost (95% of replans are plans
    // running to exhaustion) and only sets the general line — scale it to
    // what the box can pay. The DEEP solve is the run-in dive, fires about
    // once per run, and is where the 30-40 m/s grabs come from: never
    // cheapen that one.
    const scale = deep ? 1 : this.beamScale;
    return Math.max(24, Math.round(full * scale));
  }
  /** Body mass + capsule must ride into the clone or the searched sim
   *  diverges from the shadow's physics (light capper ≠ medium). */
  private cloneOf(m: MoveSim): MoveSim {
    // Blank initial state — the constructor aliases `initial`, so passing
    // m.state would make the clone write into the live shadow's state.
    const c = new MoveSim((m as unknown as { surface: MoveSurface }).surface,
      {pos: {x: 0, y: 0, z: 0}, vel: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0, onGround: false});
    c.restore(m.snapshot());
    c.mass = m.mass; c.eyeHeight = m.eyeHeight; c.bodyRadius = m.bodyRadius;
    return c;
  }

  /** Projected arrival speed at the stand — the beam's currency. Blend
   *  with closing rate: pure proj rewards high-altitude states past the
   *  stand; pure closing kills descent lines. */
  private proj(px: number, pz: number, py: number, vx: number, vz: number, e0: number, B: BotVec): number {
    let v = Math.max(6, Math.sqrt(vx * vx + vz * vz)), e = e0, time = 0, hPrev = py;
    const len = Math.hypot(B.x - px, B.z - pz) || 1;
    const steps = Math.min(20, Math.max(2, Math.ceil(len / 50)));
    const ds = len / steps;
    for (let s = 1; s <= steps; s += 1) {
      const h = hmHeight(this.field!, px + (B.x - px) * (s / steps), pz + (B.z - pz) * (s / steps));
      v = Math.sqrt(Math.max(16, v * v + 56 * (hPrev - h)));
      v = Math.max(4, v - ds * 0.06);
      time += ds / Math.max(v, 8);
      if (e > 4 && v < 50) {const dv = Math.min(10 * ds / Math.max(v, 8), 50 - v); v += dv; e -= dv * 1.5;}
      hPrev = h;
    }
    const vClose = ((B.x - px) * vx + (B.z - pz) * vz) / len;
    return (v - time * 0.1) + vClose * 0.5;
  }

  private search(rootSim: MoveSim, e0: number, ec: Econ, B: BotVec, beamW: number, horizon: number): Plan {
    // One scratch sim replays every child — nodes carry plain snapshots
    // so the arena is memory, not live sims (the old JSON round-trip per
    // child was the dominant replan cost by an order of magnitude).
    const scratch = this.cloneOf(rootSim);
    const cold = (s: SimSnapshot): void => {
      // Cold ground edges, same semantics the JSON clone produced: the
      // snapshot's in-flight jump/ground bookkeeping would carry a
      // phantom touchdown into every branch and the beam loses its
      // descent lines (measured: kata s1 60→18 m/s when restored warm).
      scratch.restore(s);
      const x = scratch as unknown as { wishJump: boolean; allowNextJump: boolean; groundedBuffered: boolean; groundGraceT: number; acc: number; lastJumpableNormal: {x: number; y: number; z: number} };
      x.wishJump = false; x.allowNextJump = false; x.groundedBuffered = false;
      x.groundGraceT = 0; x.acc = 0; x.lastJumpableNormal.x = 0; x.lastJumpableNormal.y = 1; x.lastJumpableNormal.z = 0;
    };
    const arena: Node[] = [];
    arena.push({
      snap: rootSim.snapshot(), e: e0, parent: -1,
      act: { yaw: rootSim.state.yaw, jet: false },
      sample: { x: rootSim.state.pos.x, z: rootSim.state.pos.z, y: rootSim.state.pos.y },
      proj: -Infinity,
    });
    let frontier = [0];
    const seen = new Set([key(arena[0]!.snap.st, e0)]);
    let bestIdx = -1;
    const steps = Math.round(horizon / STEP_S);
    for (let sIdx = 0; sIdx < steps; sIdx++) {
      const next: number[] = [];
      for (const ni of frontier) {
        const n = arena[ni]!;
        for (const dOff of DYAWS) {
          for (const jet of [false, true]) {
            if (jet && n.e < ec.elock) {continue;}
            cold(n.snap);
            scratch.state.yaw += dOff;
            scratch.setInput({ forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: jet });
            let hit = false;
            for (let t = 0; t < TICKS; t++) {
              scratch.update(1 / 60);
              const sp = scratch.state.pos;
              // Squared test, not Math.hypot: this runs 9x per child
              // (~500k times a search) and hypot's overflow-safe scaling
              // costs several times a multiply — it was 3.7% of the whole
              // process profile. Same comparison, no root.
              const dx = B.x - sp.x, dz = B.z - sp.z;
              if (dx * dx + dz * dz <= 36 && Math.abs(sp.y - B.y) <= 6) {hit = true; break;}
            }
            const e = Math.min(ec.emax, n.e + (jet ? -ec.drain * STEP_S : ec.regen * STEP_S));
            const s = scratch.state;
            const child: Node = {
              snap: scratch.snapshot(), e, parent: ni, act: { yaw: s.yaw, jet },
              sample: { x: s.pos.x, z: s.pos.z, y: s.pos.y },
              proj: -Infinity,
            };
            arena.push(child);
            if (hit) {return unwind(arena, arena.length - 1, true);}
            const k = key(child.snap.st, e);
            if (seen.has(k)) {continue;}
            seen.add(k);
            child.proj = this.proj(s.pos.x, s.pos.z, s.pos.y, s.vel.x, s.vel.z, e, B);
            next.push(arena.length - 1);
          }
        }
      }
      if (next.length > beamW) {
        next.sort((a, b) => arena[b]!.proj - arena[a]!.proj);
        next.length = beamW;
      }
      frontier = next;
      if (frontier.length === 0) {break;}
      // Best node IN THIS LAYER, never across layers. Every node here has
      // had the same elapsed time, so their projections are comparable;
      // a cross-layer max is not (a depth-1 node still carrying the entry
      // speed outscored every real plan), and the winner it produced was a
      // 1-act plan that exhausted in 3 ticks -> replan 6.7x/s at ~0.5s a
      // solve. A held plan is the whole point of receding-horizon.
      let bi = -1, bs = -Infinity;
      for (const ix of frontier) {
        const p = arena[ix]!.proj;
        if (p > bs) {bs = p; bi = ix;}
      }
      bestIdx = bi;
    }
    return bestIdx < 0 ? { act: [], exp: [], hit: false } : unwind(arena, bestIdx, false);
  }

  /** Drive one bot through a search-planned leg. Returns false when the
   *  option can't run (no field/shadow) so the caller keeps the normal
   *  pipeline. `tgt` is the committed destination (stand or head). */
  drive(id: string, tgt: BotVec): boolean {
    const sim = this.moveSim.simOf(id);
    const econ = this.moveSim.econOf(id);
    if (!sim || !econ || !this.field) {return false;}
    const sh = sim.state;
    let run = this.runs.get(id);
    const ec: Econ = { drain: 15 * econ.jetDrain, regen: 8 * econ.jetRegen * econ.energyRegen, emax: 60 * econ.energyMax, elock: 6 };
    const stepI = (r: { i: number }) => Math.floor(r.i / 3);
    // Plans run to exhaustion — divergence (not a timer) is what kills
    // a stale one: the live shadow sits ~14m+ off the expected track
    // when the world disagrees. A timer would re-solve mid-flight and
    // pay ~500ms for a plan that was already working.
    const ex = run ? run.plan.exp[stepI(run)] : undefined;
    const diverged = run && run.i >= 3
      ? (ex ? Math.hypot(sh.pos.x - ex.x, sh.pos.z - ex.z) > DIVERGE_M : true)
      : false;
    const retargeted = run && Math.hypot(run.tgt.x - tgt.x, run.tgt.z - tgt.z) > 30;
    if (!run || stepI(run) >= run.plan.act.length || diverged || retargeted) {
      if (!run) {BotMpc.why.miss++;}
      else if (stepI(run) >= run.plan.act.length) {BotMpc.why.exhausted++;}
      else if (diverged) {BotMpc.why.diverged++;}
      else {BotMpc.why.retargeted++;}
      // One deep solve when the run-in window opens — the dive plan it
      // finds is held, not re-rolled every second (live-room cost:
      // ~500ms once per approach vs a per-second tick stall).
      const inside = Math.hypot(tgt.x - sh.pos.x, tgt.z - sh.pos.z) < DEEP_M;
      const deep = inside && !(run?.deepDone ?? false);
      const t0 = performance.now();
      const plan = this.search(sim, econ.energy, ec, tgt, this.beam(deep ? DEEP_BEAM : TRANSIT_BEAM, deep), deep ? DEEP_HORIZON : TRANSIT_HORIZON);
      const solveMs = performance.now() - t0;
      BotMpc.ms += solveMs; BotMpc.n += 1; BotMpc.acts += plan.act.length;
      this.tuneBeam(solveMs);
      run = { plan, i: 0, tgt: { x: tgt.x, y: tgt.y, z: tgt.z }, deepDone: (run?.deepDone ?? false) || deep };
      this.runs.set(id, run);
    }
    const a = run.plan.act[stepI(run)];
    run.i += 1;
    if (!a) {return false;}
    this.moveSim.faceYaw(id, a.yaw);
    this.moveSim.setInput(id, { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: a.jet });
    return true;
  }

  /** Option end — a bot that stops running (carries, dies, retargets)
   *  drops its schedule instead of holding a stale line. */
  release(id: string): void {
    this.runs.delete(id);
  }
}

function unwind(arena: Node[], idx: number, hit: boolean): Plan {
  const act: { yaw: number; jet: boolean }[] = [];
  const exp: { x: number; z: number; y: number }[] = [];
  for (let cur = idx; cur > 0; cur = arena[cur]!.parent) {
    const n = arena[cur]!;
    act.unshift(n.act);
    exp.unshift(n.sample);
  }
  return { act, exp, hit };
}
