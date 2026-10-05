import { MoveSim, ENERGY, cloakDrainPerSec, type BodyCapsule, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import { FieldSurface, MoveJudge, type Shadow } from './moveJudge.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { wallNow } from './wallClock.ts';

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
  private static readonly AUTHORITY_DIVERGENCE_M = 1.5;
  private static readonly CORRECT_MS = 400;
  private static readonly AUTHORITY_CORRECT_MS = 100;
  authoritative: boolean;
  private wantsAuthority: boolean;
  private judge: MoveJudge;
  /** Room heartbeat map — the judge counts corrections + worst gap here
   *  so 'Room health' lines show rubberbanding pressure, not just logs. */
  health?: Map<string, number>;
  /** Fires when a shadow accumulates SEVERE_N teleport-scale divergences
   *  inside SEVERE_MS — the kick wiring lives at the Room level (this
   *  sim only knows movement truth). */
  onCheat?: (playerId: string, dist: number) => void;
  /** Live player capsules for body-vs-body contact — the Room supplies
   *  records each tick (corpses excluded upstream); each shadow gets a
   *  self-less view so its own sim does the pushing. */
  bodySource?: () => Iterable<{ id: string } & BodyCapsule>;

  constructor(field: Heightfield | null, authoritative = false) {
    this.wantsAuthority = authoritative;
    this.surface = field ? new FieldSurface(field) : null;
    this.authoritative = authoritative && !!field;
    this.judge = new MoveJudge({
      authoritative: () => this.authoritative,
      divergenceM: () => this.divergenceM,
      correctMs: () => this.correctMs,
      health: () => this.health,
      onCheat: (id, d) => this.onCheat?.(id, d),
      surface: () => this.surface,
    });
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
      // Armor class survives the swap — speed, mass, and eye height all
      // ride the class row, so a stale default would diverge on jets.
      sh.sim.speedScale = old.speedScale;
      sh.sim.mass = old.mass; sh.sim.eyeHeight = old.eyeHeight;
      sh.sim.bodyRadius = old.bodyRadius;
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
    this.structEpoch++;
  }
  /** Bumped on every attachStructures — structure-reading caches key on
   *  it so a map swap or flag re-snap can't serve stale tops. */
  get structureEpoch(): number { return this.structEpoch; }
  private structEpoch = 0;

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
      jetWanted: false, jetLockT: 0, skillDrainPerSec: 0, skillSuppressRegen: false, lastStatus: 0,
      lastInputSeq: 0, acc: 0, seqStates: new Map(), simTicks: 0, resyncSeq: -1, resyncAt: 0,
      gapStreak: 0, lastHintAt: 0, lastReportAt: 0, reportEma: 0,
    });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); }

  /** Arm the post-re-seat report grace — see the resyncAt comment on the
   *  shadow: pre-gameState frames still in flight are muted ~1 RTT. */
  markReseated(playerId: string): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.resyncAt = wallNow();
  }

  /** Perk swap after track() baked the modifiers — role rebalance pins
   *  (capper featherjets) would otherwise stay cosmetic on the shadow. */
  setPerk(playerId: string, perk?: string): void {
    const sh = this.shadows.get(playerId);
    if (!sh) return;
    const mods = perkMods(perk);
    sh.energyMax = mods.energyMax;
    sh.energy = Math.min(sh.energy, ENERGY.max * sh.energyMax);
    sh.jetDrain = mods.jetDrain;
    sh.jetRegen = mods.jetRegen;
    sh.energyRegen = mods.energyRegen;
  }

  /** Armor-class ground speed multiplier (server bots / future loadouts). */
  setSpeedScale(playerId: string, scale: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.sim.speedScale = scale;
  }

  /** Armor-class body — mass divides jet thrust/impulses, eyeHeight sets
   *  the grounded stand height. Must mirror the client's prediction. */
  setBody(playerId: string, mass: number, eyeHeight: number, bodyRadius: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) { sh.sim.mass = mass; sh.sim.eyeHeight = eyeHeight; sh.sim.bodyRadius = bodyRadius; }
  }

  /** Command-queue ingress — inputMove does NOT apply on arrival. The
   *  newest event parks in the shadow's pending slot and the next tick's
   *  phase-0 drain applies it, so a tick's outcome can't depend on where
   *  inside the tick window a packet landed. Seq gate mirrors setInput's
   *  so the caller's stale-check answer is unchanged. */
  queueInput(playerId: string, input: Partial<MoveInput>, status = 0, seq?: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) return true;
    // Gate against the pending slot too — lastInputSeq only moves at
    // drain, so without it a reordered old packet could overwrite a
    // fresher parked command before the next tick runs.
    if (seq !== undefined && seq <= Math.max(sh.lastInputSeq, sh.pending?.seq ?? 0)) return false;
    sh.pending = { input, status, seq };
    return true;
  }

  /** Phase 0 of every tick: drain pending commands through the normal
   *  setInput path (seq journal, jet gating, rising-edge antes). */
  private drainInputs(): void {
    for (const [pid, sh] of this.shadows) {
      if (!sh.pending) continue;
      const p = sh.pending;
      sh.pending = undefined;
      this.setInput(pid, p.input, p.status, p.seq);
    }
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

    const hSpeed = Math.hypot(sh.sim.state.vel.x, sh.sim.state.vel.z);
    sh.skillDrainPerSec =
      (status & STATUS.CLOAK ? cloakDrainPerSec(hSpeed) : 0) +
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
  drainEnergy(playerId: string, amount: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) return false;
    sh.energy = Math.max(0, sh.energy - amount);
    return true;
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
    sh.lastImpulseAt = wallNow();
  }

  /** Tick-set confirm for the wire frame — the highest inputMove seq
   *  this player's shadow consumed. -1 for untracked ids (spectators):
   *  encodes as 0 on the wire. */
  inputSeqOf(playerId: string): number {
    return this.shadows.get(playerId)?.lastInputSeq ?? -1;
  }

  /** Hard-tolerance trip (Photon Quantum): the position frame carries
   *  the client's input watermark — when it runs ahead of our consumed
   *  seq across several reports, an input edge died in flight and the
   *  shadow is free-running stale input. The room relays inputSync so
   *  the client re-emits its current input. */
  onInputGap?: (playerId: string, lastSeq: number) => void;

  /** Compare a client position report against the shadow sim. Returns the
   *  sim's own state when the report is past the divergence tolerance —
   *  the caller turns it into a client correction (witness → judge). */
  reconcile(playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number): (MoveState & { inputSeq: number }) | null {
    const sh = this.shadows.get(playerId);
    if (!sh) return null;
    // reportInputSeq = the client's input counter at snapshot time. Only
    // a report stamped ahead of everything RECEIVED counts as a gap — a
    // seq parked in pending is covered, just not drained yet. ≥3
    // consecutive uncovered reports means events were lost, not queued.
    if (reportInputSeq !== undefined && reportInputSeq > Math.max(sh.lastInputSeq, sh.pending?.seq ?? 0)) {
      sh.gapStreak++;
      const now = wallNow();
      if (sh.gapStreak >= 3 && now - sh.lastHintAt > 1000) {
        sh.lastHintAt = now;
        this.onInputGap?.(playerId, sh.lastInputSeq);
      }
    } else {
      sh.gapStreak = 0;
    }
    return this.judge.reconcile(sh, playerId, pos, yaw, vel, reportInputSeq);
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
    if (fullEnergy) { sh.energy = ENERGY.max * sh.energyMax; sh.jetLockT = 0; }
    // Journal anchors pre-teleport positions — the discarded trajectory
    // would swallow fresh reports' divergence checks.
    sh.seqStates.clear();
    // Input dies with the discontinuity: the client re-declares intent on
    // its next inputMove, but a retained pre-respawn stick/ski/jet would
    // coast the shadow away from the anchor until kick-scale divergence.
    sh.sim.setInput({ forward: 0, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false });
    sh.jetWanted = false;
    sh.resyncSeq = sh.lastInputSeq;
    sh.resyncAt = wallNow();
    sh.divergences = 0; // new trajectory — don't carry old accumulation
  }

  tick(dt: number): void {
    this.drainInputs(); // phase 0 — all queued commands land at the boundary
    const bodies = this.bodySource ? [...this.bodySource()] : null;
    // One shared broad-phase per tick: without it every shadow scans the
    // whole roster in collideBodies — O(shadows × bodies) at scale. 4m
    // cells dwarf any contact radius, so the 3x3 ring around a pos
    // always contains every capsule it could touch.
    let bodiesNear: ((x: number, z: number) => BodyCapsule[]) | undefined;
    if (bodies && bodies.length > 0) {
      const CELL = 4, BIAS = 512;
      const grid = new Map<number, number[]>();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        const k = ((Math.floor(b.x / CELL) + BIAS) << 16) | (Math.floor(b.z / CELL) + BIAS);
        const cell = grid.get(k);
        if (cell) cell.push(i); else grid.set(k, [i]);
      }
      // Cells return indices — sorted back to roster order so contact
      // resolution runs in the exact sequence the flat scan produced
      // (order matters when 3+ capsules overlap).
      const idx: number[] = [];
      const scratch: BodyCapsule[] = [];
      bodiesNear = (x, z) => {
        idx.length = 0; scratch.length = 0;
        const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(((cx + dx + BIAS) << 16) | (cz + dz + BIAS));
          if (cell) for (const i of cell) idx.push(i);
        }
        idx.sort((a, b) => a - b);
        for (const i of idx) scratch.push(bodies[i]!);
        return scratch;
      };
    }
    for (const [pid, sh] of this.shadows) {
      if (bodies) {
        // Shared list for every shadow — collideBodies skips selfId, so
        // rebuilding N-1 copies per tick was pure churn.
        sh.sim.selfId = pid;
        sh.sim.bodies = bodies;
        sh.sim.bodiesNear = bodiesNear;
      } else {
        sh.sim.bodiesNear = undefined; // no source this tick — a stale grid is worse than none
      }
      // Jet economy: thrust only while the modeled tank has fuel, drain
      // while burning, recharge only when off jet AND no toggle skill is
      // running (client-side rule — all three pause recharge).
      if (sh.jetLockT > 0) sh.jetLockT -= dt;
      const jetting = sh.jetWanted && sh.energy > 0 && sh.jetLockT <= 0;
      if (jetting) sh.energy -= ENERGY.jetDrain * sh.jetDrain * dt;
      if (sh.skillDrainPerSec > 0) sh.energy -= sh.skillDrainPerSec * dt;
      if (!jetting && !sh.skillSuppressRegen) {
        sh.energy = Math.min(ENERGY.max * sh.energyMax, sh.energy + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * dt);
      }
      sh.energy = Math.max(0, sh.energy);
      if (sh.energy <= 0) sh.jetLockT = ENERGY.jetLockout;
      sh.sim.setInput({ jetHeld: jetting });
      // Resting shadows skip the integrator: quiet input + ~zero
      // velocity + grounded means two sub-steps of terrain/solid/body
      // probes would land exactly where it started. Parked defenders
      // and AFK humans sit here a third of their ticks.
      const s = sh.sim.state, inp = sh.sim.input;
      // onGround lies at seed/resync (setState writes it true even for
      // a mid-air drop) — the gate measures rest against the real
      // ground under it, or a dropped body never starts falling.
      const groundY = Math.max(
        this.surface ? this.surface.getHeight(s.pos.x, s.pos.z) : s.pos.y,
        this.structureTop(s.pos.x, s.pos.z),
      );
      const resting = s.onGround && s.pos.y - groundY < sh.sim.eyeHeight + 0.5
        && Math.abs(s.vel.x) + Math.abs(s.vel.y) + Math.abs(s.vel.z) < 0.05
        && !inp.forward && !inp.right && !inp.jumpHeld && !inp.jumpPressed && !inp.skiHeld && !inp.jetHeld
        && (!bodiesNear || !bodiesNear(s.pos.x, s.pos.z).some(b => b.id !== pid && Math.abs(b.x - s.pos.x) < 2.5 && Math.abs(b.z - s.pos.z) < 2.5));
      if (!resting) {
        // MoveSim.update() sub-steps internally at its own 1/60 quantum —
        // feed it the raw tick delta. Count consumed steps ourselves for
        // the seq-anchored journal (simTicks is in STEP quanta).
        sh.sim.update(dt);
      }
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
