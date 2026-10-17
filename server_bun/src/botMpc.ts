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
 * Dispatch: solves run in botMpcWorker (separate thread — a deep solve
 * measured ~500-3000ms, which inside a 50ms tick stalls every player in
 * the room). While a solve flies, the bot keeps executing its previous
 * plan; when it lands, the plan adopts if the target hasn't moved. No
 * worker → synchronous fallback (harnesses/tests, worker-less hosts).
 */
import type { MoveSurface } from '../../shared/movement.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { RoomMoveSim } from './RoomMoveSim.ts';
import type { BotVec } from '../../shared/botVec.ts';
import { runSearch, type MpcJob, type MpcPlan } from './botMpcSearch.ts';

const TRANSIT_BEAM = 150, TRANSIT_HORIZON = 4;
const DEEP_BEAM = 500, DEEP_HORIZON = 5, DEEP_M = 250;
const DIVERGE_M = 14;
/** Measured: ~0.3 transit beam BEATS full width (4/4 caps, grabV ~43
 *  vs ~37 at 1.0 — a tighter frontier commits to one line's descendants
 *  instead of filling the row with parallel mid-scorers, and shorter
 *  solves land fresher roots). Wider is not better here. */
const TRANSIT_SCALE = 0.3;

interface Econ { drain: number; regen: number; emax: number; elock: number }
interface Run { plan: MpcPlan; i: number; tgt: BotVec; deepDone: boolean }
interface Pending { seq: number; tgt: BotVec; deep: boolean }

export class BotMpc {
  /** Perf counters — total solve wall (worker-reported) + solve count. */
  static ms = 0; static n = 0; static acts = 0;
  /** Why a solve was posted — the split says where the cost goes (an
   *  exhausted plan is the design working; divergence churn is a
   *  tolerance problem; a fresh run is a role/objective flap). */
  static why = { miss: 0, exhausted: 0, diverged: 0, retargeted: 0 };
  static {
    process.on('exit', () => {
      if (BotMpc.n) {
        const w = BotMpc.why;
        console.log(`[mpcSearch] solves=${BotMpc.n} wallMs=${BotMpc.ms.toFixed(0)} avg=${(BotMpc.ms / BotMpc.n).toFixed(1)} avgPlanActs=${(BotMpc.acts / BotMpc.n).toFixed(1)} why=miss${w.miss}/exh${w.exhausted}/div${w.diverged}/retgt${w.retargeted}`);
      }
    });
  }

  constructor(
    private readonly moveSim: RoomMoveSim,
    private readonly field: Heightfield | null,
  ) {}

  /** Per-bot run state — the plan is a short input schedule plus the
   *  expected state at each step (divergence from it is what makes a
   *  plan stale). */
  private runs = new Map<string, Run>();
  /** Latest solve posted per bot — the worker FIFOs them; a superseded
   *  result drops on arrival (target or seq mismatch). */
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** undefined = never tried, null = spawn failed or stalled (sync
   *  fallback). FPS_MPC_SYNC pins the sync path — scenario harnesses
   *  step() in a tight loop that never pumps the event loop, so worker
   *  replies would queue forever. */
  private worker: Worker | null | undefined;
  /** Ticks elapsed with zero worker replies while a job pends — a
   *  non-yielding host (or dead worker) trips this and drops to sync. */
  private stalledTicks = 0;
  private static readonly STALL_TICKS = 400;
  /** Solve requests awaiting worker results, keyed for adoption. */
  private bySeq = new Map<number, { id: string; tgt: BotVec; deep: boolean }>();

  private beam(full: number, deep: boolean): number {
    // A/B hook: FPS_MPC_BEAM=N pins beam=N*full for both kinds.
    const forced = process.env.FPS_MPC_BEAM;
    if (forced) {return Math.max(24, Math.round(full * Number(forced)));}
    // Transit solves are the repeat cost and only set the general line —
    // pinned to the measured sweet spot. The DEEP solve is the run-in
    // dive, fires about once per run, and is where the 40-50 m/s grabs
    // come from: never cheapen that one.
    return Math.max(24, Math.round(full * (deep ? 1 : TRANSIT_SCALE)));
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== undefined) {return this.worker;}
    if (process.env.FPS_MPC_SYNC) {this.worker = null; return null;}
    try {
      const wk = new Worker(new URL('./botMpcWorker.ts', import.meta.url));
      // Idle search workers are a service, not a reason to live — tools
      // (capStat/matchSim) otherwise hang at exit on the open port.
      (wk as unknown as { unref?: () => void }).unref?.();
      wk.onmessage = (e): void => this.onPlan(e.data);
      wk.onerror = (): void => { this.worker = null; };
      wk.postMessage({ kind: 'init', field: this.field, solidSpecs: this.moveSim.structureSpecs });
      this.worker = wk;
    } catch { this.worker = null; }
    return this.worker;
  }

  private onPlan(m: { kind?: string; seq?: number; plan?: MpcPlan; ms?: number }): void {
    if (m.kind !== 'plan' || typeof m.seq !== 'number' || !m.plan) {return;}
    const job = this.bySeq.get(m.seq);
    this.bySeq.delete(m.seq);
    if (!job) {return;}
    this.stalledTicks = 0;
    BotMpc.ms += m.ms ?? 0; BotMpc.n += 1; BotMpc.acts += m.plan.act.length;
    const pend = this.pending.get(job.id);
    if (pend?.seq === m.seq) {this.pending.delete(job.id);}
    const run = this.runs.get(job.id);
    // Adopt only if the room still wants this target — a retarget/dead
    // bot's late plan must not resurrect a stale run.
    if (!run) {return;}
    if (Math.hypot(run.tgt.x - job.tgt.x, run.tgt.z - job.tgt.z) > 30) {return;}
    if (job.deep) {run.deepDone = true;}
    run.plan = m.plan; run.i = 0;
  }

  /** Drive one bot through a search-planned leg. Returns false when the
   *  option can't run (no field/shadow/plan-in-flight) so the caller
   *  keeps the normal pipeline. `tgt` is the committed destination. */
  drive(id: string, tgt: BotVec): boolean {
    // FPS_MPC_OFF: scenario harnesses pin the option off entirely —
    // the sync fallback pays ~300ms/solve inside step(), which turns a
    // 10s soak into minutes and measures the planner, not the room.
    if (process.env.FPS_MPC_OFF) {return false;}
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
    // pay a solve for a plan that was already working.
    const ex = run ? run.plan.exp[stepI(run)] : undefined;
    const diverged = run && run.i >= 3
      ? (ex ? Math.hypot(sh.pos.x - ex.x, sh.pos.z - ex.z) > DIVERGE_M : true)
      : false;
    const retargeted = run && Math.hypot(run.tgt.x - tgt.x, run.tgt.z - tgt.z) > 30;
    const need = !run || stepI(run) >= run.plan.act.length || Boolean(diverged) || Boolean(retargeted);
    const pend = this.pending.get(id);
    // Non-yielding host detector: pending jobs that never resolve mean
    // the event loop isn't pumping — switch this driver to sync solves
    // rather than leave cappers on the reactive stack forever.
    if (pend && this.worker && ++this.stalledTicks > BotMpc.STALL_TICKS) {
      this.worker.terminate();
      this.worker = null;
      this.pending.clear(); this.bySeq.clear();
    }

    if (need) {
      if (!run) {BotMpc.why.miss++;}
      else if (stepI(run) >= run.plan.act.length) {BotMpc.why.exhausted++;}
      else if (diverged) {BotMpc.why.diverged++;}
      else {BotMpc.why.retargeted++;}
      // One deep solve when the run-in window opens — the dive plan it
      // finds is held, not re-rolled every second.
      const inside = Math.hypot(tgt.x - sh.pos.x, tgt.z - sh.pos.z) < DEEP_M;
      const deep = inside && !(run?.deepDone ?? pend?.deep ?? false);
      // Skip if an in-flight solve already targets ~here.
      const pendCovers = pend && Math.hypot(pend.tgt.x - tgt.x, pend.tgt.z - tgt.z) <= 30;
      if (!pendCovers) {
        const job: MpcJob = {
          snap: sim.snapshot(),
          mass: sim.mass, eyeHeight: sim.eyeHeight, bodyRadius: sim.bodyRadius,
          speedScale: sim.speedScale,
          waterLevel: sim.waterLevel,
          e0: econ.energy, ec, tgt: { x: tgt.x, y: tgt.y, z: tgt.z },
          beamW: this.beam(deep ? DEEP_BEAM : TRANSIT_BEAM, deep),
          horizon: deep ? DEEP_HORIZON : TRANSIT_HORIZON,
        };
        const seq = ++this.seq;
        const wk = this.ensureWorker();
        if (wk) {
          this.pending.set(id, { seq, tgt: job.tgt, deep });
          this.bySeq.set(seq, { id, tgt: job.tgt, deep });
          wk.postMessage({ kind: 'job', seq, id, job });
        } else {
          // No worker support — synchronous fallback. Same function the
          // worker runs; costs the tick, keeps harnesses honest.
          const t0 = performance.now();
          const plan = runSearch((sim as unknown as { surface: MoveSurface }).surface, this.field, job);
          const ms = performance.now() - t0;
          BotMpc.ms += ms; BotMpc.n += 1; BotMpc.acts += plan.act.length;
          run = run ?? { plan, i: 0, tgt: job.tgt, deepDone: false };
          run.plan = plan; run.i = 0; run.tgt = job.tgt;
          run.deepDone = run.deepDone || deep;
          this.runs.set(id, run);
        }
      }
      // Ensure a run record exists so plan adoption finds it later —
      // deepDone flips only when a deep plan actually LANDS (onPlan).
      if (!run) {
        run = { plan: { act: [], exp: [], hit: false }, i: 0, tgt: { x: tgt.x, y: tgt.y, z: tgt.z }, deepDone: false };
        this.runs.set(id, run);
      }
    }
    const a = run?.plan.act[stepI(run!)];
    if (!a) {return false;}
    run!.i += 1;
    this.moveSim.faceYaw(id, a.yaw);
    this.moveSim.setInput(id, { forward: 1, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: true, jetHeld: a.jet });
    return true;
  }

  /** Option end — a bot that stops running (carries, dies, retargets)
   *  drops its schedule instead of holding a stale line. */
  release(id: string): void {
    this.runs.delete(id);
    const p = this.pending.get(id);
    if (p) {this.pending.delete(id); this.bySeq.delete(p.seq);}
  }
}
