import { MoveSim, ENERGY, cloakDrainPerSec, type BodyCapsule, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import { structureColliders, type StructureCollider } from '../../shared/ballCollide.ts';
import { FieldSurface, MoveJudge, TRANSIT_EMA_CAP_MS, type Shadow } from './moveJudge.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { wallNow } from './wallClock.ts';
import { evictEldest } from './evictEldest.ts';

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
  /** Chord-augmented surface for bot shadows — they must ground on the
   *  rendered mesh, not the smooth field (see fromFieldChord). Humans
   *  keep the plain field or their prediction diverges. */
  private botSurface: FieldSurface | null = null;
  /** Structures held independently of the surface — they can arrive
   *  before OR after the heightfield, and either order must work. */
  private solid: SolidWorld | null = null;
  /** Live deployable hulls — the RoomDeployables array, passed by
   *  reference so plants/removals mid-match hit every shadow without a
   *  re-attach. */
  private dyn?: readonly StructureCollider[];
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
  private static readonly AUTHORITY_CORRECT_MS = 80;
  authoritative: boolean;
  private wantsAuthority: boolean;
  private judge: MoveJudge;
  /** Room heartbeat map — the judge counts corrections + worst gap here
   *  so 'Room health' lines show rubberbanding pressure, not just logs. */
  health?: Map<string, number>;
  /** Fires when a shadow accumulates SEVERE_N teleport-scale divergences
   *  inside SEVERE_MS — the kick wiring lives at the Room level (this
   *  sim only knows movement truth). */
  onCheat?: (playerId: string, dist: number, detail?: Record<string, unknown>) => void;
  /** Live player capsules for body-vs-body contact — the Room supplies
   *  records each tick (corpses excluded upstream); each shadow gets a
   *  self-less view so its own sim does the pushing. */
  bodySource?: () => Iterable<{ id: string } & BodyCapsule>;

  constructor(field: Heightfield | null, authoritative = false) {
    this.wantsAuthority = authoritative;
    this.surface = field ? FieldSurface.fromField(field) : null;
    this.botSurface = field ? FieldSurface.fromFieldChord(field) : null;
    this.authoritative = authoritative && !!field;
    this.judge = new MoveJudge({
      authoritative: () => this.authoritative,
      divergenceM: () => this.divergenceM,
      correctMs: () => this.correctMs,
      health: () => this.health,
      onCheat: (id, d, detail) => this.onCheat?.(id, d, detail),
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
    this.surface = FieldSurface.fromField(field);
    this.surface.solid = this.solid;
    this.botSurface = FieldSurface.fromFieldChord(field);
    this.botSurface.solid = this.solid;
    this.authoritative = this.wantsAuthority;
    for (const [pid, sh] of this.shadows) {
      const old = sh.sim;
      sh.sim = new MoveSim(sh.bot && this.botSurface ? this.botSurface : this.surface, old.state);
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
    // Replay seats taken while the field was still loading — reseated
    // grace arms them since pre-gameState frames may still be in flight.
    for (const [pid, t] of this.pendingTrack) {
      this.track(pid, t.pos, t.yaw, t.perk, t.team, t.bot);
      this.markReseated(pid);
    }
    this.pendingTrack.clear();
  }

  private get divergenceM(): number {
    return this.authoritative ? RoomMoveSim.AUTHORITY_DIVERGENCE_M : RoomMoveSim.DIVERGENCE_M;
  }
  private get correctMs(): number {
    return this.authoritative ? RoomMoveSim.AUTHORITY_CORRECT_MS : RoomMoveSim.CORRECT_MS;
  }

  /** Late-attach check — rooms built before the shared heightmap resolves
   *  re-seat via GameServer's post-load pass, same as ballSim.hasField. */
  get hasField(): boolean { return this.surface !== null; }

  /** Map structures layered over the field — solid walls and walkable
   *  tops for every sim already tracking (the surface object is shared). */
  attachStructures(list: readonly StructureSpec[] | undefined): void {
    this.solid = (list?.length || this.dyn?.length) ? new SolidWorld(structureColliders(list ?? []), this.dyn) : null;
    if (this.surface) this.surface.solid = this.solid;
    if (this.botSurface) this.botSurface.solid = this.solid;
    this.structEpoch++;
  }

  /** Deployable hulls — one array, mutated in place by RoomDeployables.
   *  When the map has no structures a first plant may arrive before any
   *  attachStructures call, so mint the world lazily too. */
  setDynamic(cols: readonly StructureCollider[]): void {
    this.dyn = cols;
    if (this.solid) this.solid.dyn = cols;
    else if (cols.length) {
      this.solid = new SolidWorld([], cols);
      if (this.surface) this.surface.solid = this.solid;
      if (this.botSurface) this.botSurface.solid = this.solid;
    }
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

  /** Seats that arrived before the field — attachTerrain resolves async,
   *  so a join mid-load used to drop here and leave the player shadowless
   *  for the whole session: no reconcile, no corrections, no transit. */
  private pendingTrack = new Map<string, { pos: Vec3Like; yaw: number; perk?: string; team?: string; bot?: boolean }>();

  /** Call on join/spawn — seeds the sim at the reported spot. `team`
   *  feeds team-gated colliders (gate shields pass allies). */
  track(playerId: string, pos: Vec3Like, yaw: number, perk?: string, team?: string, bot?: boolean): void {
    if (!this.surface) {
      this.pendingTrack.set(playerId, { pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, perk, team, bot });
      return;
    }
    const state: MoveState = {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw, pitch: 0, onGround: true,
      team,
    };
    const mods = perkMods(perk);
    this.shadows.set(playerId, {
      sim: new MoveSim(bot && this.botSurface ? this.botSurface : this.surface, state),
      bot: bot === true, divergences: 0, lastCorrection: 0, lastImpulseAt: 0,
      severeT: [], cheated: false,
      // Spawn seed is the server's guess — the client's first position
      // report is the authoritative landing spot (client picks its own
      // spawn point); comparing would flag a phantom join divergence.
      seeded: false,
      energy: ENERGY.max * mods.energyMax, energyMax: mods.energyMax,
      jetDrain: mods.jetDrain, jetRegen: mods.jetRegen, energyRegen: mods.energyRegen,
      jetWanted: false, jetLockT: 0, skillDrainPerSec: 0, skillSuppressRegen: false, lastStatus: 0,
      lastInputSeq: 0, acc: 0, seqStates: new Map(), simTicks: 0, resyncSeq: -1, resyncAt: 0, pending: [],
      lastRepPos: null,
      gapStreak: 0, gapAt: 0, deferStreak: 0, lastHintAt: 0, lastReportAt: 0, reportEma: 0,
      transitEma: 0, clientTransitEma: 0, serverTransitEma: 0, transitVar: 0, reportVar: 0,
    });
  }

  untrack(playerId: string): void { this.shadows.delete(playerId); this.pendingTrack.delete(playerId); }

  /** Mid-match team swap (rebalance) — the shadow's gate-shield access
   *  flips with the jersey, not at the next respawn. */
  setTeam(playerId: string, team: string | undefined): void {
    const sh = this.shadows.get(playerId);
    if (sh) sh.sim.state.team = team;
  }

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

  /** Command-queue ingress — inputMove does NOT apply on arrival. Edges
   *  queue in seq order and the next tick's phase-0 drain replays them
   *  across the window, so a tick's outcome can't depend on where inside
   *  the window a packet landed. Seq gate mirrors setInput's so the
   *  caller's stale-check answer is unchanged. FIFO not slot: newest-
   *  wins dropped every co-tick edge (tap-jumps, double-edges inside
   *  50ms, the prev-redundancy copy) — a systematic divergence vs the
   *  client's per-edge replay. */
  queueInput(playerId: string, input: Partial<MoveInput>, status = 0, seq?: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) return true;
    // Gate against the queued tail too — lastInputSeq only moves at
    // drain, so without it a reordered old packet could append a stale
    // edge behind fresher queued ones.
    const tail = sh.pending.length ? sh.pending[sh.pending.length - 1]!.seq : undefined;
    if (seq !== undefined && seq <= Math.max(sh.lastInputSeq, tail ?? 0)) return false;
    sh.pending.push({ input, status, seq });
    // Bounded — a flood can't queue unbounded replay work; the oldest
    // edge drops (its seq anchor with it) so the newest intent survives.
    if (sh.pending.length > 8) sh.pending.shift();
    return true;
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
      if (input.jetHeld !== undefined) sh.jetWanted = input.jetHeld;
      sh.sim.setInput({ ...input, jetHeld: sh.jetWanted && sh.energy > 0 });
      // The anchor carries the input that runs FORWARD from this seq —
      // anchoredCompare replays anchor(k).inp over [k, k+1), so a
      // pre-apply snapshot would replay the input that just ended and
      // read every real edge as a phantom divergence.
      sh.seqStates.set(seq, {
        snap: sh.sim.snapshot(),
        tick: sh.simTicks,
        inp: { ...sh.sim.input },
        e: sh.energy,
      });
      if (sh.seqStates.size > 32) evictEldest(sh.seqStates);
    } else {
      if (input.jetHeld !== undefined) sh.jetWanted = input.jetHeld;
      sh.sim.setInput({ ...input, jetHeld: sh.jetWanted && sh.energy > 0 });
    }

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
   *  this player's shadow has accepted. Pending counts too: an undrained
   *  edge is already claimed — a held-state frame older than it must not
   *  rewind the input it set. -1 for untracked ids (spectators):
   *  encodes as 0 on the wire. */
  inputSeqOf(playerId: string): number {
    const sh = this.shadows.get(playerId);
    if (!sh) return -1;
    const tail = sh.pending.length ? sh.pending[sh.pending.length - 1]!.seq ?? 0 : 0;
    return Math.max(sh.lastInputSeq, tail);
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
  reconcile(playerId: string, pos: Vec3Like, yaw: number, vel?: Vec3Like, reportInputSeq?: number, rttMs?: number): (MoveState & { inputSeq: number }) | null {
    const sh = this.shadows.get(playerId);
    if (!sh) return null;
    // The report's own RTT estimate feeds the broadcast lead — the
    // uplink half is how stale the shadow's input stream is. It's
    // client-reported, so it's a lower bound on trust: server-measured
    // ping/pong echoes cap it from above in syncTransit.
    if (rttMs !== undefined && rttMs > 0) {
      const tr = Math.min(rttMs / 2, TRANSIT_EMA_CAP_MS);
      if (sh.serverTransitEma === 0) sh.transitVar = sh.transitVar * 0.9 + Math.abs(tr - sh.transitEma) * 0.1;
      sh.clientTransitEma = sh.clientTransitEma === 0 ? tr : sh.clientTransitEma * 0.9 + tr * 0.1;
      this.syncTransit(sh);
    }
    // reportInputSeq = the client's input counter at snapshot time. Only
    // a report stamped ahead of everything RECEIVED counts as a gap — a
    // seq parked in pending is covered, just not drained yet. ≥3
    // consecutive uncovered reports means events were lost, not queued
    // (≥2 measured worse: the early hint's resend re-anchored the client
    // mid-flight and corrections tripled on the adverse soak).
    if (reportInputSeq !== undefined && reportInputSeq > Math.max(sh.lastInputSeq, sh.pending.length ? sh.pending[sh.pending.length - 1]!.seq ?? 0 : 0)) {
      if (sh.gapStreak === 0) sh.gapAt = wallNow(); // streak start — the judge's in-flight grace window
      sh.gapStreak++;
      const now = wallNow();
      if (sh.gapStreak >= 3 && now - sh.lastHintAt > 1000) {
        sh.lastHintAt = now;
        this.onInputGap?.(playerId, sh.lastInputSeq);
      }
    } else {
      sh.gapStreak = 0;
    }
    return this.judge.reconcile(sh, playerId, pos, yaw, vel, reportInputSeq, rttMs);
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
    // Queued edges pre-date the discontinuity — replaying them would
    // coast a respawned body on corpse intent for a full tick.
    sh.pending.length = 0;
    // Input dies with the discontinuity: the client re-declares intent on
    // its next inputMove, but a retained pre-respawn stick/ski/jet would
    // coast the shadow away from the anchor until kick-scale divergence.
    sh.sim.setInput({ forward: 0, right: 0, jumpPressed: false, jumpHeld: false, skiHeld: false, jetHeld: false });
    sh.jetWanted = false;
    sh.resyncSeq = sh.lastInputSeq;
    sh.resyncAt = wallNow();
    // The declared discontinuity is a legal step — anchor the report
    // tracker here or the first post-respawn report reads as a forge.
    sh.lastRepPos = { x: pos.x, y: pos.y, z: pos.z };
    sh.divergences = 0; // new trajectory — don't carry old accumulation
  }

  tick(dt: number): void {
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
      // Phase 0 (per shadow): drain the queued edges through setInput in
      // seq order — seq-journal anchors, jet gating, and rising-edge
      // antes all land before the econ pass reads the final jetWanted.
      const edges = sh.pending.length ? sh.pending.splice(0, sh.pending.length) : null;
      if (edges) for (const e of edges) this.setInput(pid, e.input, e.status, e.seq);
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
        && (!edges || edges.every(e => !e.input.forward && !e.input.right && !e.input.jumpHeld && !e.input.jumpPressed && !e.input.skiHeld && !e.input.jetHeld))
        && (!bodiesNear || !bodiesNear(s.pos.x, s.pos.z).some(b => b.id !== pid && Math.abs(b.x - s.pos.x) < 2.5 && Math.abs(b.z - s.pos.z) < 2.5));
      if (!resting) {
        // MoveSim.update() sub-steps internally at its own 1/60 quantum —
        // feed it the raw tick delta. Count consumed steps ourselves for
        // the seq-anchored journal (simTicks is in STEP quanta).
        if (edges) {
          // Interleave: each edge governs an equal slice of the window
          // (uniform intra-tick timing — edges carry seq, not stamps), so
          // a press+release pair holds the key for ~half the tick and the
          // hop/jet fires instead of collapsing into the final state.
          const slice = dt / edges.length;
          for (const e of edges) {
            sh.sim.setInput({ ...e.input, jetHeld: jetting });
            sh.sim.update(slice);
          }
        } else {
          sh.sim.update(dt);
        }
      }
      sh.acc += dt;
      const steps = Math.floor(sh.acc / MoveSim.STEP);
      sh.acc -= steps * MoveSim.STEP;
      sh.simTicks += steps;
    }
  }

  /** Server-measured RTT (ping/pong echo) — the unforgeable channel.
   *  A delayed pong inflates only this EMA, and min() in syncTransit
   *  means it can never RAISE the effective estimate. */
  feedTransit(playerId: string, rttMs: number): void {
    const sh = this.shadows.get(playerId);
    if (!sh || !(rttMs > 0)) return;
    const tr = Math.min(rttMs / 2, TRANSIT_EMA_CAP_MS);
    sh.transitVar = sh.transitVar * 0.9 + Math.abs(tr - sh.transitEma) * 0.1;
    sh.serverTransitEma = sh.serverTransitEma === 0 ? tr : sh.serverTransitEma * 0.9 + tr * 0.1;
    this.syncTransit(sh);
  }

  /** Claim-declared uplink sample: `fireAt` is the shooter's server-clock
   *  estimate of its trigger instant, so (arrival − fireAt) is THIS
   *  claim's real uplink transit — per-claim truth where the ping/pong
   *  EMA is a smoothed guess. Feeds the same server channel: a forged
   *  fireAt is bounded the same way a fabricated pong is (inflating it
   *  only shrinks the forger's own rendered lead). */
  feedUplink(playerId: string, uplinkMs: number): void {
    const sh = this.shadows.get(playerId);
    if (!sh || !(uplinkMs >= 0)) return;
    const tr = Math.min(uplinkMs, TRANSIT_EMA_CAP_MS);
    sh.serverTransitEma = sh.serverTransitEma === 0 ? tr : sh.serverTransitEma * 0.9 + tr * 0.1;
    this.syncTransit(sh);
  }

  /** Effective uplink transit: the server's own measurement owns the
   *  estimate the moment it exists — the client channel stands alone
   *  only until the first pong lands (join grace). A fabricated report
   *  can't move it in EITHER direction: lowballing would shrink the
   *  forger's broadcast lead (ghost trails truth — harder to hit), and
   *  inflating bought tolerance/rewind before this channel existed. */
  private syncTransit(sh: Shadow): void {
    sh.transitEma = sh.serverTransitEma > 0 ? sh.serverTransitEma : sh.clientTransitEma;
  }

  /** Uplink-transit estimate (ms) for the broadcast lead — the shadow
   *  trails the client's authored stream by this much. */
  transitOf(playerId: string): number {
    return this.shadows.get(playerId)?.transitEma ?? 0;
  }

  /** Both raw channels — the effective estimate is min(client, server
   *  + slack); tests assert the server's own probe actually lands. */
  transitChannelsOf(playerId: string): { client: number; server: number } {
    const sh = this.shadows.get(playerId);
    return { client: sh?.clientTransitEma ?? 0, server: sh?.serverTransitEma ?? 0 };
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
