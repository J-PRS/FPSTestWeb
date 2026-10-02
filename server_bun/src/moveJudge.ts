/**
 * MoveJudge — compares client position reports against the shadow sim.
 * Honest drift tops out ~15m steady; corrections resync the client (not
 * the sim), and N teleport-scale gaps inside a window fire the cheat
 * hook. Split out of RoomMoveSim so the shadow bookkeeping (track/energy/
 * input journal) stays separate from the verdict logic.
 */
import { MoveSim, ENERGY, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import type { SolidWorld } from '../../shared/solidWorld.ts';
import { hmHeight, hmNormal } from '../../shared/heightfield.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';

/** Map structures layered over the terrain — getHeight reports their
 *  top faces as floor, resolveBody handles walls/ceilings. Lives on
 *  the surface object so existing sims pick up late attach transparently. */
export class FieldSurface {
  solid: SolidWorld | null = null;

  constructor(private f: Heightfield) {}
  getHeight(x: number, z: number): number {
    const g = hmHeight(this.f, x, z);
    const t = this.solid?.topAt(x, z) ?? -Infinity;
    return t > g ? t : g;
  }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    const t = this.solid?.topAt(x, z) ?? -Infinity;
    if (t > hmHeight(this.f, x, z)) { out.x = 0; out.y = 1; out.z = 0; return out; }
    hmNormal(this.f, x, z, out as { x: number; y: number; z: number });
    return out;
  }
  resolveBody(s: MoveState, height: number): void { this.solid?.resolveBody(s, height); }
}

export interface Shadow {
  sim: MoveSim;
  /** Scratch sim for seq-anchored compares — stepped ahead by the inputs
   *  the report reflects but the shadow hasn't consumed yet. */
  probe?: MoveSim;
  divergences: number;
  /** Timestamps of teleport-scale divergences in the rolling window —
   *  honest drift tops out ~15m, so repeated >SEVERE_M gaps mean a
   *  client reporting positions its own inputs can't produce. */
  severeT: number[];
  /** Fired once — kick isn't retried every report while teardown runs. */
  cheated: boolean;
  /** Spawn seed is the server's guess — the first position report snaps the
   *  sim to the client's actual landing spot instead of flagging it. */
  seeded: boolean;
  /** Corrections throttle — a client fighting the snap reports divergent
   *  positions every tick; one correction per window is enough. */
  lastCorrection: number;
  /** Last server-applied impulse — a knocked client's report and shadow
   *  apply the shove at different sim phases, so mid-arc reads diverge
   *  ~40m for ~2s without anyone cheating. */
  lastImpulseAt: number;
  // ---- Energy model ---------------------------------------------------
  // The wire `jet` bit is a claim the tank has fuel; the sim must model
  // the same economy or infinite-jet claims read as valid trajectories.
  // Skill drains (cloak/shield/mend) and activation antes are inferred
  // from the status bits the client already sends on inputMove.
  energy: number;
  jetDrain: number;   // perk multipliers — declared at join
  jetRegen: number;
  energyRegen: number;
  /** Pool-size perk multiplier (airtank = 1.5). */
  energyMax: number;
  /** Raw claimed jet bit — the sim sees it gated by modeled energy. */
  jetWanted: boolean;
  /** Sum of active per-second skill drains from claimed status bits. */
  skillDrainPerSec: number;
  /** Cloak/shield/mend all suppress the tank recharge client-side too. */
  skillSuppressRegen: boolean;
  /** For ante deduction on 0→1 bit transitions. */
  lastStatus: number;
  /** inputMove ordering — change-only events on unordered transports
   *  (RTC/WT datagrams) can land out of order; regressions are dropped. */
  lastInputSeq: number;
  /** Sim state per consumed input seq, stamped with the sim tick it was
   *  captured at. A report stamped seq N behind the shadow's consumed seq
   *  must compare against the journal entry at N replayed to now — the
   *  live sim applied inputs the report predates (e.g. a jump), which
   *  reads as a divergence otherwise. Insertion-ordered; bounded. */
  seqStates: Map<number, { st: MoveState; tick: number; inp: MoveInput; e: number }>;
  /** Number of 1/30 sim quanta the shadow has integrated. */
  simTicks: number;
  /** Input seq consumed at the last resync() — reports stamped at or below
   *  it are provably pre-respawn/pre-teleport traffic still in flight; the
   *  journal was cleared so they have no anchor to compare against and
   *  would read the discarded trajectory as a blow-through divergence. */
  resyncSeq: number;
  /** Wall time of the last resync(). Reports for ~1 RTT after it are
   *  causally pre-respawn — the respawn message is still in flight to
   *  them so they honestly report the corpse position with fresh seqs
   *  the stale-epoch check can't catch. */
  resyncAt: number;
  /** Step-count residue — simTicks counts MoveSim.STEP quanta; the
   *  fraction of a step dt didn't complete carries into the next tick. */
  acc: number;
}

export interface JudgeHost {
  /** Judge mode tolerates prediction noise; authority mode is truth —
   *  the client needs tight, frequent acks or its prediction drifts for real. */
  authoritative(): boolean;
  /** Judge tolerance sits above the systematic offset a different-rate
   *  predictor produces (server steps 30Hz; clients step at frame rate —
   *  live soaks measure honest 20Hz clients drifting up to ~15m steady,
   *  a 60Hz human drifts less). Real cheats diverge by orders of
   *  magnitude more — 60m+ reads teleport. */
  divergenceM(): number;
  correctMs(): number;
  /** Room heartbeat map — the judge counts corrections + worst gap here
   *  so 'Room health' lines show rubberbanding pressure, not just logs. */
  health(): Map<string, number> | undefined;
  /** Fires when a shadow accumulates SEVERE_N teleport-scale divergences
   *  inside SEVERE_MS — the kick wiring lives at the Room level (this
   *  sim only knows movement truth). */
  onCheat(playerId: string, dist: number): void;
  surface(): FieldSurface | null;
}

/** Per-step integration noise scales with speed — a skier at 35m/s
 *  legitimately drifts ~60% farther per tick than a walker, and
 *  contact-timing differences (crest lips) widen it more. Scale the
 *  tolerance so honest speed doesn't produce count=1 warn clips;
 *  real teleports are still an order of magnitude past. */
const SPEED_TOL_REF = 60; // m/s at which tolerance doubles
/** Honest judge-mode drift measured ~15m on live traffic; a 60m gap
 *  between report and input replay is teleport territory. */
const SEVERE_M = 60;
const SEVERE_N = 3;
const SEVERE_MS = 60_000;

export class MoveJudge {
  constructor(private host: JudgeHost) {}

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(sh: Shadow, playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number): (MoveState & { inputSeq: number }) | null {
    const s = sh.sim.state;
    s.yaw = yaw; // facing is client truth — sim only needs it for input dir
    // Stale in-flight reports after a re-seat (room hop): the old seat
    // kept reporting until the client saw gameState — those frames would
    // seed the fresh shadow at the old position and flag the real spawn
    // landing ~60m away as a cheat. The hop grace mutes them; the first
    // post-gameState report seeds at the true spawn instead.
    if (Date.now() - sh.resyncAt < CONFIG.reportGraceMs) return null;
    if (!sh.seeded) {
      sh.seeded = true;
      s.pos = { x: pos.x, y: pos.y, z: pos.z };
      // The guess-run during the mute built momentum the client never
      // had — adopt the reported velocity too or the leftover vel
      // carries the shadow ~10m ahead for one divergence blip.
      if (vel) s.vel = { x: vel.x, y: vel.y, z: vel.z };
      s.onGround = true;
      sh.seqStates.clear(); // pre-seed journal anchors the discarded guess
      return null;
    }
    if (vel) { s.vel.x = vel.x; s.vel.y = vel.y; s.vel.z = vel.z; }
    // Stale-epoch reports: the client sent this before it saw the respawn/
    // teleport that reseated the shadow. Judging it against the new anchor
    // flags a phantom blow-through (a guaranteed ~100m spike per respawn).
    if (reportInputSeq !== undefined && reportInputSeq <= sh.resyncSeq) return null;
    // The report's seq tells us how many input events the client had
    // consumed when it generated this position. If the shadow is behind
    // (inputs still in flight), the client is legitimately ahead by up
    // to ~vel * pending-steps — compare against a probe stepped forward
    // that many ticks with the last-seen input instead of the stale sim.
    const dx0 = pos.x - s.pos.x, dy0 = pos.y - s.pos.y, dz0 = pos.z - s.pos.z;
    let dist = Math.hypot(dx0, dy0, dz0);
    if (reportInputSeq !== undefined) {
      // The journal replay is an approximation — it can't reproduce
      // server-applied impulses (knockback, energy grants) inside the
      // window. Judging the worst of both comparisons flags honest hits;
      // the judge takes the better of the two — a cheat still reads far
      // from every reference.
      const cmp = this.anchoredCompare(sh, s, reportInputSeq);
      const d = Math.hypot(pos.x - cmp.pos.x, pos.y - cmp.pos.y, pos.z - cmp.pos.z);
      if (d < dist) dist = d;
    }
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const tol = this.host.divergenceM() * (1 + speed / SPEED_TOL_REF);
    if (dist <= tol) return null;

    this.noteDivergence(sh, playerId, pos, reportInputSeq, dist, tol);
    const now = Date.now();
    if (now - sh.lastCorrection < this.host.correctMs()) return null;
    sh.lastCorrection = now;
    // The sim keeps its own position — resyncing onto the rejected report
    // would make the correction we just sent diverge from the next report
    // and ping-pong forever. Convergence comes from the client snapping.
    const truth: MoveState & { inputSeq: number } = {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      yaw, pitch: s.pitch, onGround: s.onGround,
      // Which client input event the sim consumed last — the correction
      // anchor so the client replays only what the server never saw.
      inputSeq: sh.lastInputSeq,
    };
    return truth;
  }

  /** Divergence bookkeeping — counter for future kicks, health metrics,
   *  and the log gate: a single just-over-tolerance clip is a crest-lip
   *  contact-timing gap (the next correction converges it), so WARN only
   *  on repeats or blow-throughs; count=1 marginal clips are the known
   *  noise floor and stay INFO for later review. */
  private noteDivergence(sh: Shadow, playerId: string, pos: Vec3Like, reportInputSeq: number | undefined, dist: number, tol: number): void {
    sh.divergences++;
    this.noteHealth(dist);
    this.noteSevere(sh, playerId, dist);
    // Mid-arc knockback skew is transient by construction — the severe
    // counter still eats it (3 hits in 60s = real teleport), but the
    // log line stays informational. Same for permissive mode: without
    // sim authority nothing ever corrects the shadow, so two honest
    // sims drifting on cresty terrain is the expected steady state,
    // not a warn — the plausibility gate is the real judge there.
    const transient = !this.host.authoritative() || dist < tol * 1.5 || Date.now() - sh.lastImpulseAt < 2000;
    if (sh.divergences !== 1 && sh.divergences % 20 !== 0) return;
    const s = sh.sim.state;
    logger[transient ? 'info' : 'warn']('Move sim divergence', {
      playerId, dist: dist.toFixed(1), tol: tol.toFixed(1), count: sh.divergences,
      simTicks: sh.simTicks, inSeq: sh.lastInputSeq, repSeq: reportInputSeq,
      inp: `${sh.sim.input.forward},${sh.sim.input.right},${sh.sim.input.skiHeld ? 1 : 0},${sh.sim.input.jetHeld ? 1 : 0}`,
      simPos: `${s.pos.x.toFixed(1)},${s.pos.y.toFixed(1)},${s.pos.z.toFixed(1)}`,
      repPos: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
    });
  }

  private noteHealth(dist: number): void {
    const h = this.host.health();
    if (!h) return;
    h.set('diverge', (h.get('diverge') ?? 0) + 1);
    if (dist > (h.get('gapMax') ?? 0)) h.set('gapMax', Math.round(dist * 10) / 10);
  }

  /** Rolling severe-blow counter — N overshoots inside the window flags
   *  the shadow as a teleporter, not a drifter. */
  private noteSevere(sh: Shadow, playerId: string, dist: number): void {
    if (dist <= SEVERE_M || sh.cheated) return;
    const now = Date.now();
    sh.severeT = sh.severeT.filter((t) => now - t < SEVERE_MS);
    sh.severeT.push(now);
    if (sh.severeT.length >= SEVERE_N) {
      sh.cheated = true;
      this.host.onCheat(playerId, dist);
    }
  }

  /** Pick the sim state a seq-stamped report should be compared against.
   *  Client ahead (report seq > consumed): probe the live state forward
   *  by the in-flight input gap. Shadow ahead: replay from the journal
   *  anchor at/below the report seq up to now — the live sim applied
   *  inputs the report predates, which reads as divergence otherwise. */
  private anchoredCompare(sh: Shadow, s: MoveState, reportSeq: number): MoveState {
    if (reportSeq > sh.lastInputSeq) return this.probeForward(sh, s, reportSeq - sh.lastInputSeq, sh.sim.input);
    // Entries after the anchor (sorted) define input segments: each runs
    // its recorded input until the next entry's sim tick — a jet toggle
    // mid-window then replays correctly instead of being applied to the
    // whole span.
    let anchorSeq: number | undefined;
    const after: { st: MoveState; tick: number; inp: MoveInput; e: number }[] = [];
    for (const [k, e] of sh.seqStates) {
      if (k <= reportSeq && (anchorSeq === undefined || k > anchorSeq)) anchorSeq = k;
      else if (k > reportSeq) after.push(e);
    }
    after.sort((x, y) => x.tick - y.tick);
    const anchor = anchorSeq !== undefined ? sh.seqStates.get(anchorSeq) : undefined;
    if (!anchor) return s;
    const probe = (sh.probe ??= new MoveSim(this.host.surface()!, anchor.st));
    // The probe replays the SAME body — a heavy's weaker jets would
    // replay as a phantom climb if mass/eye fell back to defaults.
    probe.mass = sh.sim.mass; probe.eyeHeight = sh.sim.eyeHeight;
    probe.setState(anchor.st);
    const segs = [...after, { st: anchor.st, tick: sh.simTicks, inp: sh.sim.input }];
    this.replayWindow(sh, probe, anchor, segs);
    return probe.state;
  }

  /** Replay the anchor→now input segments through the probe, mirroring
   *  the tank's energy gating. Cap TOTAL replay work, not each segment —
   *  a per-segment cap leaves the probe stale mid-window and reads the
   *  truncation as divergence (journal is ≤32 entries, window is small). */
  private replayWindow(
    sh: Shadow, probe: MoveSim,
    anchor: { st: MoveState; tick: number; inp: MoveInput; e: number },
    segs: { tick: number; inp: MoveInput }[],
  ): void {
    let tick = anchor.tick;
    let inp = anchor.inp;
    let budget = 128;
    // The probe must mirror the tank: the live sim gates jetHeld off when
    // energy drains — replaying raw input keeps the probe jetting where
    // the real sim ran dry (~18m false divergence at spawn jet windows).
    let e = anchor.e;
    for (const seg of segs) {
      const steps = Math.min(seg.tick - tick, budget);
      if (steps > 0) {
        Object.assign(probe.input, inp);
        for (let i = 0; i < steps; i++) {
          const jetting = inp.jetHeld === true && e > 0;
          probe.input.jetHeld = jetting;
          if (jetting) e -= ENERGY.jetDrain * sh.jetDrain * MoveSim.STEP;
          else if (!sh.skillSuppressRegen) e = Math.min(ENERGY.max * sh.energyMax, e + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * MoveSim.STEP);
          if (sh.skillDrainPerSec > 0) e -= sh.skillDrainPerSec * MoveSim.STEP;
          e = Math.max(0, e);
          probe.update(MoveSim.STEP);
        }
        tick += steps;
        budget -= steps;
      }
      if (tick >= sh.simTicks || budget <= 0) break;
      inp = seg.inp;
    }
  }

  private probeForward(sh: Shadow, from: MoveState, steps: number, inp: MoveInput): MoveState {
    const probe = (sh.probe ??= new MoveSim(this.host.surface()!, from));
    probe.mass = sh.sim.mass; probe.eyeHeight = sh.sim.eyeHeight;
    probe.setState(from);
    Object.assign(probe.input, inp);
    for (let i = 0, n = Math.min(steps, 16); i < n; i++) probe.update(MoveSim.STEP);
    return probe.state;
  }
}
