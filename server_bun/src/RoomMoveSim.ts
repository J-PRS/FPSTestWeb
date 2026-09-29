import { MoveSim, ENERGY, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { hmHeight, hmNormal, type Heightfield } from '../../shared/heightfield.ts';
import { logger } from './logger.ts';

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
  constructor(private f: Heightfield) {}
  getHeight(x: number, z: number): number { return hmHeight(this.f, x, z); }
  getNormal(x: number, z: number, out: Vec3Like): Vec3Like {
    hmNormal(this.f, x, z, out as { x: number; y: number; z: number });
    return out;
  }
}

interface Shadow {
  sim: MoveSim;
  /** Scratch sim for seq-anchored compares — stepped ahead by the inputs
   *  the report reflects but the shadow hasn't consumed yet. */
  probe?: MoveSim;
  divergences: number;
  /** Spawn seed is the server's guess — the first position report snaps the
   *  sim to the client's actual landing spot instead of flagging it. */
  seeded: boolean;
  /** Corrections throttle — a client fighting the snap reports divergent
   *  positions every tick; one correction per window is enough. */
  lastCorrection: number;
  // ---- Energy model ---------------------------------------------------
  // The wire `jet` bit is a claim the tank has fuel; the sim must model
  // the same economy or infinite-jet claims read as valid trajectories.
  // Skill drains (cloak/shield/mend) and activation antes are inferred
  // from the status bits the client already sends on inputMove.
  energy: number;
  jetDrain: number;   // perk multipliers — declared at join
  jetRegen: number;
  energyRegen: number;
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
  seqStates: Map<number, { st: MoveState; tick: number }>;
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
  /** Tick substeps accumulate in the client's 1/30 quantum so the shadow
   *  integrates identically to the client sim despite the 50ms room tick. */
  acc: number;
}

export class RoomMoveSim {
  private surface: FieldSurface | null;
  private shadows = new Map<string, Shadow>();
  // Judge mode tolerates prediction noise; authority mode is truth — the
  // client needs tight, frequent acks or its prediction drifts for real.
  // Judge tolerance sits above the systematic offset a different-rate
  // predictor produces (server steps 30Hz; clients step at frame rate —
  // an honest fleet bot at 20Hz drifts ~8m, a 60Hz human drifts less).
  // Real cheats diverge by orders of magnitude more.
  private static readonly DIVERGENCE_M = 10;
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
      sim: new MoveSim(this.surface, state), divergences: 0, lastCorrection: 0,
      // Spawn seed is the server's guess — the client's first position
      // report is the authoritative landing spot (client picks its own
      // spawn point); comparing would flag a phantom join divergence.
      seeded: false,
      energy: ENERGY.max,
      jetDrain: mods.jetDrain, jetRegen: mods.jetRegen, energyRegen: mods.energyRegen,
      jetWanted: false, skillDrainPerSec: 0, skillSuppressRegen: false, lastStatus: 0,
      lastInputSeq: 0, acc: 0, seqStates: new Map(), simTicks: 0, resyncSeq: -1, resyncAt: 0,
    });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); }

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
    if (sh) sh.energy = Math.min(ENERGY.max, sh.energy + amount);
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
  }

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number): (MoveState & { inputSeq: number }) | null {
    const sh = this.shadows.get(playerId);
    if (!sh) return null;
    const s = sh.sim.state;
    s.yaw = yaw; // facing is client truth — sim only needs it for input dir
    if (!sh.seeded) {
      sh.seeded = true;
      s.pos = { x: pos.x, y: pos.y, z: pos.z };
      s.onGround = true;
      sh.seqStates.clear(); // pre-seed journal anchors the discarded guess
      return null;
    }
    if (vel) { s.vel.x = vel.x; s.vel.y = vel.y; s.vel.z = vel.z; }
    // Stale-epoch reports: the client sent this before it saw the respawn/
    // teleport that reseated the shadow. Judging it against the new anchor
    // flags a phantom blow-through (a guaranteed ~100m spike per respawn).
    if (reportInputSeq !== undefined && reportInputSeq <= sh.resyncSeq) return null;
    if (Date.now() - sh.resyncAt < 500) return null;
    // The report's seq tells us how many input events the client had
    // consumed when it generated this position. If the shadow is behind
    // (inputs still in flight), the client is legitimately ahead by up
    // to ~vel * pending-steps — compare against a probe stepped forward
    // that many ticks with the last-seen input instead of the stale sim.
    const cmp = reportInputSeq !== undefined
      ? this.anchoredCompare(sh, s, reportInputSeq)
      : s;
    const dx = pos.x - cmp.pos.x, dy = pos.y - cmp.pos.y, dz = pos.z - cmp.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const tol = this.divergenceM * (1 + speed / RoomMoveSim.SPEED_TOL_REF);
    if (dist <= tol) return null;

    sh.divergences++;
    if (this.health) {
      this.health.set('diverge', (this.health.get('diverge') ?? 0) + 1);
      if (dist > (this.health.get('gapMax') ?? 0)) this.health.set('gapMax', Math.round(dist * 10) / 10);
    }
    // A single just-over-tolerance clip is a crest-lip contact-timing
    // gap — the next correction converges it, count never accumulates.
    // WARN only on repeats or blow-throughs; count=1 marginal clips are
    // the known noise floor and stay INFO for later review.
    const transient = dist < tol * 1.5;
    if (sh.divergences === 1 || sh.divergences % 20 === 0) {
      logger[transient ? 'info' : 'warn']('Move sim divergence', { playerId, dist: dist.toFixed(1), tol: tol.toFixed(1), count: sh.divergences });
    }
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

  /** Pick the sim state a seq-stamped report should be compared against.
   *  Client ahead (report seq > consumed): probe the live state forward
   *  by the in-flight input gap. Shadow ahead: replay from the journal
   *  anchor at/below the report seq up to now — the live sim applied
   *  inputs the report predates, which reads as divergence otherwise. */
  private anchoredCompare(sh: Shadow, s: MoveState, reportSeq: number): MoveState {
    if (reportSeq > sh.lastInputSeq) return this.probeForward(sh, s, reportSeq - sh.lastInputSeq);
    let anchorSeq: number | undefined;
    for (const k of sh.seqStates.keys()) {
      if (k <= reportSeq && (anchorSeq === undefined || k > anchorSeq)) anchorSeq = k;
    }
    const anchor = anchorSeq !== undefined ? sh.seqStates.get(anchorSeq) : undefined;
    if (!anchor) return s;
    const steps = sh.simTicks - anchor.tick;
    return steps > 0 ? this.probeForward(sh, anchor.st, steps) : anchor.st;
  }

  private probeForward(sh: Shadow, from: MoveState, steps: number): MoveState {
    const probe = (sh.probe ??= new MoveSim(this.surface!, from));
    probe.setState(from);
    Object.assign(probe.input, sh.sim.input);
    for (let i = 0, n = Math.min(steps, 8); i < n; i++) probe.update(1 / 30);
    return probe.state;
  }

  /** Aim/heading update for entities that never send position reports
   *  (server bots): facing is host truth, not a claim. */
  faceYaw(playerId: string, yaw: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.sim.state.yaw = yaw;
  }

  /** Declared discontinuity (teleport/respawn) — resync without counting. */
  resync(playerId: string, pos: Vec3Like, yaw: number): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const s = sh.sim.state;
    sh.sim.setState({
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 }, yaw, pitch: s.pitch, onGround: true,
    });
    // Journal anchors pre-teleport positions — the discarded trajectory
    // would swallow fresh reports' divergence checks.
    sh.seqStates.clear();
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
        sh.energy = Math.min(ENERGY.max, sh.energy + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * dt);
      }
      sh.energy = Math.max(0, sh.energy);
      sh.sim.setInput({ jetHeld: jetting });
      // Integrate in the client's 1/30 quanta — the room tick is 50ms, and
      // a single 50ms step resolves ski/ground contact differently than
      // the client's 33ms steps, producing a permanent ~2m divergence.
      sh.acc += dt;
      while (sh.acc >= 1 / 30) {
        sh.acc -= 1 / 30;
        sh.sim.update(1 / 30);
        sh.simTicks++;
      }
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
