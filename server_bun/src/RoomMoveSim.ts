import { MoveSim, ENERGY, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { hmHeight, hmNormal, type Heightfield } from '../../shared/heightfield.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { logger } from './logger.ts';
import { CONFIG } from './config.ts';

/**
 * Server-side movement shadow — every player gets a MoveSim fed by their
 * inputMove traffic and stepped each room tick against the room's
 * heightfield. Today it runs in shadow mode: the client's reported
 * position remains truth (same as before), while the sim's position is
 * compared against each report. Divergence beyond a tolerance is a
 * speedhack/teleport signal — the plausibility check can only see
 * consecutive-report deltas, while the sim sees the WHOLE trajectory.
 *
 * Divergence policy: drift under ~8m is normal (ping + prediction). Over
 * that we resync the sim to the report and count it — sustained big
 * divergence is logged so it can feed kicks later.
 */
class FieldSurface {
  /** Map structures layered over the terrain — getHeight reports their
   *  top faces as floor, resolveBody handles walls/ceilings. Lives on
   *  the surface object so existing sims pick up late attach transparently. */
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
  resolveBody(s: MoveState): void { this.solid?.resolveBody(s); }
}

interface Shadow {
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

export class RoomMoveSim {
  private surface: FieldSurface | null;
  /** Structures held independently of the surface — they can arrive
   *  before OR after the heightfield, and either order must work. */
  private solid: SolidWorld | null = null;
  private shadows = new Map<string, Shadow>();
  // Judge mode tolerates prediction noise; authority mode is truth — the
  // client needs tight, frequent acks or its prediction drifts for real.
  // Judge tolerance sits above the systematic offset a different-rate
  // predictor produces (server steps 30Hz; clients step at frame rate —
  // live soaks measure honest 20Hz clients drifting up to ~15m steady,
  // a 60Hz human drifts less). Real cheats diverge by orders of
  // magnitude more — 60m+ reads teleport.
  private static readonly DIVERGENCE_M = 14;
  /** Per-step integration noise scales with speed — a skier at 35m/s
   *  legitimately drifts ~60% farther per tick than a walker, and
   *  contact-timing differences (crest lips) widen it more. Scale the
   *  tolerance so honest speed doesn't produce count=1 warn clips;
   *  real teleports are still an order of magnitude past. */
  private static readonly SPEED_TOL_REF = 60; // m/s at which tolerance doubles
  private static readonly AUTHORITY_DIVERGENCE_M = 1.5;
  private static readonly CORRECT_MS = 400;
  private static readonly AUTHORITY_CORRECT_MS = 100;
  authoritative: boolean;
  private wantsAuthority: boolean;
  /** Room heartbeat map — the judge counts corrections + worst gap here
   *  so 'Room health' lines show rubberbanding pressure, not just logs. */
  health?: Map<string, number>;
  /** Fires when a shadow accumulates SEVERE_N teleport-scale divergences
   *  inside SEVERE_MS — the kick wiring lives at the Room level (this
   *  sim only knows movement truth). */
  onCheat?: (playerId: string, dist: number) => void;
  /** Honest judge-mode drift measured ~15m on live traffic; a 60m gap
   *  between report and input replay is teleport territory. */
  private static readonly SEVERE_M = 60;
  private static readonly SEVERE_N = 3;
  private static readonly SEVERE_MS = 60_000;

  constructor(field: Heightfield | null, authoritative = false) {
    this.wantsAuthority = authoritative;
    this.surface = field ? new FieldSurface(field) : null;
    this.authoritative = authoritative && !!field;
  }

  /** Late-arriving terrain (map spec named a .bin loaded async): attach it
   *  and honor the authority flag that was waiting on a field. Existing
   *  shadows keep their sims — the surface object they read is per-sim,
   *  so re-track to pick the new field up — then reseat onto the player's
   *  current server position: ticks stepped against the WRONG field during
   *  the join window would otherwise surface as a one-off divergence. */
  attachField(field: Heightfield, reportedPos?: (playerId: string) => Vec3Like | undefined): void {
    this.surface = new FieldSurface(field);
    this.surface.solid = this.solid;
    this.authoritative = this.wantsAuthority;
    for (const [pid, sh] of this.shadows) {
      const old = sh.sim;
      sh.sim = new MoveSim(this.surface, old.state);
      sh.sim.speedScale = old.speedScale; // armor class survives the swap
      Object.assign(sh.sim.input, old.input);
      const pos = reportedPos?.(pid);
      if (pos) {
        sh.sim.setState({
          pos: { x: pos.x, y: pos.y, z: pos.z }, vel: { ...old.state.vel },
          yaw: old.state.yaw, pitch: old.state.pitch, onGround: old.state.onGround,
        });
      }
    }
  }

  private get divergenceM(): number {
    return this.authoritative ? RoomMoveSim.AUTHORITY_DIVERGENCE_M : RoomMoveSim.DIVERGENCE_M;
  }
  private get correctMs(): number {
    return this.authoritative ? RoomMoveSim.AUTHORITY_CORRECT_MS : RoomMoveSim.CORRECT_MS;
  }

  /** Map structures layered over the field — solid walls and walkable
   *  tops for every sim already tracking (the surface object is shared). */
  attachStructures(list: readonly StructureSpec[] | undefined): void {
    this.solid = list?.length ? SolidWorld.fromSpecs(list) : null;
    if (this.surface) this.surface.solid = this.solid;
  }

  /** Structure top face under (x,z), -Infinity when none — bot brains
   *  fold this into their ground model so walls read as raised terrain. */
  structureTop(x: number, z: number): number {
    return this.solid?.topAt(x, z) ?? -Infinity;
  }

  /** Call on join/spawn — seeds the sim at the reported spot. */
  track(playerId: string, pos: Vec3Like, yaw: number, perk?: string): void {
    if (!this.surface) return;
    const state: MoveState = {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw, pitch: 0, onGround: true,
    };
    const mods = perkMods(perk);
    this.shadows.set(playerId, {
      sim: new MoveSim(this.surface, state), divergences: 0, lastCorrection: 0, lastImpulseAt: 0,
      severeT: [], cheated: false,
      // Spawn seed is the server's guess — the client's first position
      // report is the authoritative landing spot (client picks its own
      // spawn point); comparing would flag a phantom join divergence.
      seeded: false,
      energy: ENERGY.max * mods.energyMax, energyMax: mods.energyMax,
      jetDrain: mods.jetDrain, jetRegen: mods.jetRegen, energyRegen: mods.energyRegen,
      jetWanted: false, skillDrainPerSec: 0, skillSuppressRegen: false, lastStatus: 0,
      lastInputSeq: 0, acc: 0, seqStates: new Map(), simTicks: 0, resyncSeq: -1, resyncAt: 0,
    });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); }

  /** Arm the post-re-seat report grace — see the resyncAt comment on the
   *  shadow: pre-gameState frames still in flight are muted ~1 RTT. */
  markReseated(playerId: string): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.resyncAt = Date.now();
  }

  /** Armor-class ground speed multiplier (server bots / future loadouts). */
  setSpeedScale(playerId: string, scale: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.sim.speedScale = scale;
  }

  /** inputMove → sim input. Rotation/yaw comes from position reports.
   *  `status` is the claimed toggle bits — used to model skill energy
   *  drain and activation antes (rising-edge costs). */
  setInput(playerId: string, input: Partial<MoveInput>, status = 0, seq?: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) return true; // no field → no sim → nothing to order
    if (seq !== undefined && seq <= sh.lastInputSeq) return false;
    if (seq !== undefined) {
      sh.lastInputSeq = seq;
      const s = sh.sim.state;
      sh.seqStates.set(seq, {
        st: { pos: { ...s.pos }, vel: { ...s.vel }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround },
        tick: sh.simTicks,
        // Input + energy snapshot at the moment this seq was consumed —
        // replaying the window with current input (or without the tank)
        // reads a mid-window jet toggle or drain-out as a false ~20m
        // divergence for an honest client.
        inp: { ...sh.sim.input },
        e: sh.energy,
      });
      if (sh.seqStates.size > 32) sh.seqStates.delete(sh.seqStates.keys().next().value!);
    }
    if (input.jetHeld !== undefined) sh.jetWanted = input.jetHeld;
    sh.sim.setInput({ ...input, jetHeld: sh.jetWanted && sh.energy > 0 });

    // Rising-edge antes — the client pays the activation cost when the
    // bit comes up; the sim must mirror it or cloaked jetters desync.
    const rising = status & ~sh.lastStatus;
    if (rising & STATUS.CLOAK) sh.energy = Math.max(0, sh.energy - ENERGY.cloakCost);
    if (rising & STATUS.SHIELD) sh.energy = Math.max(0, sh.energy - ENERGY.shieldCost);
    if (rising & STATUS.MEND) sh.energy = Math.max(0, sh.energy - ENERGY.mendCost);
    sh.lastStatus = status;

    sh.skillDrainPerSec =
      (status & STATUS.CLOAK ? ENERGY.cloakDrain : 0) +
      (status & STATUS.SHIELD ? ENERGY.shieldDrain : 0) +
      (status & STATUS.MEND ? ENERGY.mendDrain : 0);
    sh.skillSuppressRegen = sh.skillDrainPerSec > 0;
    return true;
  }

  /** Energy refunds the world grants — gem pickup half-tank refill. */
  grantEnergy(playerId: string, amount: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.energy = Math.min(ENERGY.max * sh.energyMax, sh.energy + amount);
  }

  /** Energy burns outside the input stream — shield damage soak. */
  drainEnergy(playerId: string, amount: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.energy = Math.max(0, sh.energy - amount);
  }

  /** Modeled tank level — brains read this for jet/skill gating. */
  energyOf(playerId: string): number | null {
    return this.shadows.get(playerId)?.energy ?? null;
  }

  /** Knockback/AOE impulses the server itself applied — the sim must get
   *  the same delta or every blast reads as a divergence. */
  applyImpulse(playerId: string, dv: Vec3Like): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const v = sh.sim.state.vel;
    v.x += dv.x; v.y += dv.y; v.z += dv.z;
    sh.lastImpulseAt = Date.now();
  }

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number): (MoveState & { inputSeq: number }) | null {
    const sh = this.shadows.get(playerId);
    if (!sh) return null;
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
    const tol = this.divergenceM * (1 + speed / RoomMoveSim.SPEED_TOL_REF);
    if (dist <= tol) return null;

    this.noteDivergence(sh, playerId, pos, reportInputSeq, dist, tol);
    const now = Date.now();
    if (now - sh.lastCorrection < this.correctMs) return null;
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
    if (this.health) {
      this.health.set('diverge', (this.health.get('diverge') ?? 0) + 1);
      if (dist > (this.health.get('gapMax') ?? 0)) this.health.set('gapMax', Math.round(dist * 10) / 10);
    }
    if (dist > RoomMoveSim.SEVERE_M && !sh.cheated) {
      const now = Date.now();
      sh.severeT = sh.severeT.filter((t) => now - t < RoomMoveSim.SEVERE_MS);
      sh.severeT.push(now);
      if (sh.severeT.length >= RoomMoveSim.SEVERE_N) {
        sh.cheated = true;
        this.onCheat?.(playerId, dist);
      }
    }
    // Mid-arc knockback skew is transient by construction — the severe
    // counter still eats it (3 hits in 60s = real teleport), but the
    // log line stays informational. Same for permissive mode: without
    // sim authority nothing ever corrects the shadow, so two honest
    // sims drifting on cresty terrain is the expected steady state,
    // not a warn — the plausibility gate is the real judge there.
    const transient = !this.authoritative || dist < tol * 1.5 || Date.now() - sh.lastImpulseAt < 2000;
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
    const probe = (sh.probe ??= new MoveSim(this.surface!, anchor.st));
    probe.setState(anchor.st);
    let tick = anchor.tick;
    let inp = anchor.inp;
    const segs = [...after, { st: anchor.st, tick: sh.simTicks, inp: sh.sim.input }];
    // Cap TOTAL replay work, not each segment — a per-segment cap leaves
    // the probe stale mid-window and reads the truncation as divergence.
    // The journal is ≤32 entries so the whole window is naturally small.
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
    return probe.state;
  }

  private probeForward(sh: Shadow, from: MoveState, steps: number, inp: MoveInput): MoveState {
    const probe = (sh.probe ??= new MoveSim(this.surface!, from));
    probe.setState(from);
    Object.assign(probe.input, inp);
    for (let i = 0, n = Math.min(steps, 16); i < n; i++) probe.update(MoveSim.STEP);
    return probe.state;
  }

  /** Aim/heading update for entities that never send position reports
   *  (server bots): facing is host truth, not a claim. */
  faceYaw(playerId: string, yaw: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.sim.state.yaw = yaw;
  }

  /** Declared discontinuity (teleport/respawn) — resync without counting. */
  resync(playerId: string, pos: Vec3Like, yaw: number, fullEnergy = false): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const s = sh.sim.state;
    sh.sim.setState({
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 }, yaw, pitch: s.pitch, onGround: true,
    });
    // Respawn refills the client's tank; a drained shadow would refuse
    // jets the client legitimately flies → guaranteed divergence streak.
    // Teleport keeps the tank as-modeled (beacons don't recharge).
    if (fullEnergy) sh.energy = ENERGY.max * sh.energyMax;
    // Journal anchors pre-teleport positions — the discarded trajectory
    // would swallow fresh reports' divergence checks.
    sh.seqStates.clear();
    // Input dies with the discontinuity: the client re-declares intent on
    // its next inputMove, but a retained pre-respawn stick/ski/jet would
    // coast the shadow away from the anchor until kick-scale divergence.
    sh.sim.setInput({ forward: 0, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false });
    sh.jetWanted = false;
    sh.resyncSeq = sh.lastInputSeq;
    sh.resyncAt = Date.now();
    sh.divergences = 0; // new trajectory — don't carry old accumulation
  }

  tick(dt: number): void {
    for (const sh of this.shadows.values()) {
      // Jet economy: thrust only while the modeled tank has fuel, drain
      // while burning, recharge only when off jet AND no toggle skill is
      // running (client-side rule — all three pause recharge).
      const jetting = sh.jetWanted && sh.energy > 0;
      if (jetting) sh.energy -= ENERGY.jetDrain * sh.jetDrain * dt;
      if (sh.skillDrainPerSec > 0) sh.energy -= sh.skillDrainPerSec * dt;
      if (!jetting && !sh.skillSuppressRegen) {
        sh.energy = Math.min(ENERGY.max * sh.energyMax, sh.energy + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * dt);
      }
      sh.energy = Math.max(0, sh.energy);
      sh.sim.setInput({ jetHeld: jetting });
      // MoveSim.update() sub-steps internally at its own 1/60 quantum —
      // feed it the raw tick delta. Count consumed steps ourselves for
      // the seq-anchored journal (simTicks is in STEP quanta).
      sh.sim.update(dt);
      sh.acc += dt;
      const steps = Math.floor(sh.acc / MoveSim.STEP);
      sh.acc -= steps * MoveSim.STEP;
      sh.simTicks += steps;
    }
  }

  /** Server-computed position — for future authoritative use. */
  simPos(playerId: string): Vec3Like | null {
    return this.shadows.get(playerId)?.sim.state.pos ?? null;
  }

  /** Full sim state (live refs — read, don't mutate). Authority mode's
   *  tick commit copies pos+vel into the player record from this. */
  simState(playerId: string): MoveState | null {
    return this.shadows.get(playerId)?.sim.state ?? null;
  }
}
