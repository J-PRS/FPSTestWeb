import { MoveSim, ENERGY, MOVEMENT_CONFIG, cloakDrainPerSec, type BodyCapsule, type MoveInput, type MoveState, type Vec3Like } from '../../shared/movement.ts';
import { dhypot2 } from '../../shared/dmath.ts';
import { STATUS } from '../../shared/status.ts';
import { perkMods } from '../../shared/perks.ts';
import { CLASS_STATS, type ArmorClass } from '../../shared/botClasses.ts';
import type { Heightfield } from '../../shared/heightfield.ts';
import { SolidWorld } from '../../shared/solidWorld.ts';
import { inv } from '../../shared/invariants.ts';
import { structureColliders, type StructureCollider } from '../../shared/ballCollide.ts';
import { FieldSurface, MoveJudge, TRANSIT_EMA_CAP_MS, type Shadow } from './moveJudge.ts';
import type { StructureSpec } from '../../shared/mapSpec.ts';
import { wallNow } from './wallClock.ts';
import { evictEldest } from './evictEldest.ts';
import { type SimJournal,JOURNAL_HASH_EVERY,type JournalEv,type JournalEvNoT} from './simJournal.ts';


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
  /** Map water level (spec.water.level) — undefined on a dry map. Copied
   *  into every shadow sim so its replay matches the client's prediction. */
  private waterLevel?: number;
  /** Kill zone height (world Y). Undefined = no zone. */
  private killY?: number;
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
  /** Worst landing -v·n (m/s) this tick past the T1 damage threshold —
   *  Room routes it through the damage funnel. */
  onLanding?: (playerId: string, impact: number) => void;
  /** Body dropped below the map's kill zone — the Room turns it into an
   *  environment kill (the "fell out of the arena" death). */
  onKillZone?: (playerId: string) => void;
  /** Live player capsules for body-vs-body contact — the Room supplies
   *  records each tick (corpses excluded upstream); each shadow gets a
   *  self-less view so its own sim does the pushing. */
  bodySource?: () => Iterable<{ id: string } & BodyCapsule>;
  /** Forensic recorder — every sim-affecting call lands with the tick
   *  index it applied on (simJournal.ts). Env-gated at the Room;
   *  undefined = zero-cost (one check per call site). */
  journal?: SimJournal;
  /** Completed-tick count — journal events stamp "after N ticks". */
  private journalT = 0;
  private jev(ev: JournalEvNoT): void {
    this.journal?.push(Object.assign({ t: this.journalT }, ev) as JournalEv);
  }
  /** Sorted FNV over shadow sim state — the hash markers replayJournal
   *  compares. Covers the fields that decide trajectories; wall-clock
   *  judge bookkeeping (gap streaks, EMAs) is deliberately out — it
   *  doesn't feed positions. */
  journalHash(): number {
    let h = 0x81_1C_9D_C5;
    const mix = (n: number): void => { h ^= n; h = Math.imul(h, 0x01_00_01_93) >>> 0; };
    for (const [pid, sh] of [...this.shadows].sort(([a], [b]) => (a < b ? -1 : 1))) {
      mix(pid.length); for (let i = 0; i < pid.length; i += 1) {mix(pid.charCodeAt(i));}
      const s = sh.sim.state;
      mix(Math.round(s.pos.x * 100)); mix(Math.round(s.pos.y * 100)); mix(Math.round(s.pos.z * 100));
      mix(Math.round(s.vel.x * 100)); mix(Math.round(s.vel.y * 100)); mix(Math.round(s.vel.z * 100));
      mix(Math.round(s.yaw * 1000)); mix(s.onGround ? 1 : 0); mix(Math.round(sh.energy));
    }
    return h;
  }

  constructor(field: Heightfield | null, authoritative = false) {
    this.wantsAuthority = authoritative;
    this.surface = field ? FieldSurface.fromField(field) : null;
    this.botSurface = field ? FieldSurface.fromFieldChord(field) : null;
    this.authoritative = authoritative && Boolean(field);
    this.judge = new MoveJudge({
      authoritative: (): boolean => this.authoritative,
      divergenceM: (): number => this.divergenceM,
      correctMs: (): number => this.correctMs,
      health: (): Map<string, number> | undefined => this.health,
      onCheat: (id, d, detail): void | undefined => this.onCheat?.(id, d, detail),
      surface: (): FieldSurface | null => this.surface,
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
      sh.sim.waterLevel = old.waterLevel;
      sh.sim.tether = old.tether;
      Object.assign(sh.sim.input, old.input);
      const pos = reportedPos?.(pid);
      if (pos && Number.isFinite(pos.x + pos.y + pos.z)) {
        // The record carries the OLD field's height at that xz — under a
        // fresh map's surface it reads as a 30-45m burial. The 0.5s
        // unbury sweep used to catch the instant and fire a warn per bot
        // on every room mint; lift the reseat so the warn only ever means
        // a real burial.
        const g = (sh.bot && this.botSurface ? this.botSurface : this.surface)
          ?.getHeight(pos.x, pos.z);
        const y = g !== undefined && Number.isFinite(g) ? Math.max(pos.y, g + sh.sim.eyeHeight) : pos.y;
        // pos IS the player's live record object (reportedPos hands the
        // ref) — lifting it here also fixes the record's stale pre-attach
        // height, not just the shadow's.
        pos.y = y;
        sh.sim.setState({
          pos: { x: pos.x, y, z: pos.z }, vel: Object.assign({}, old.state.vel),
          yaw: old.state.yaw, pitch: old.state.pitch, onGround: old.state.onGround,
        });
      }
    }
    // Replay seats taken while the field was still loading — reseated
    // grace arms them since pre-gameState frames may still be in flight.
    for (const [pid, t] of this.pendingTrack) {
      this.track(pid, t.pos, t.yaw, t.perk, t.team, t.bot, t.armorClass);
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
    this.solidSpecs = list ?? [];
    this.solid = (list?.length || this.dyn?.length) ? new SolidWorld(structureColliders(list ?? []), this.dyn) : null;
    if (this.surface) {this.surface.solid = this.solid;}
    if (this.botSurface) {this.botSurface.solid = this.solid;}
this.structEpoch += 1;
  }

  /** Deployable hulls — one array, mutated in place by RoomDeployables.
   *  When the map has no structures a first plant may arrive before any
   *  attachStructures call, so mint the world lazily too. */
  setDynamic(cols: readonly StructureCollider[]): void {
    this.dyn = cols;
    if (this.solid) {this.solid.dyn = cols;}
    else if (cols.length > 0) {
      this.solid = new SolidWorld([], cols);
      if (this.surface) {this.surface.solid = this.solid;}
      if (this.botSurface) {this.botSurface.solid = this.solid;}
    }
  }
  /** Bumped on every attachStructures — structure-reading caches key on
   *  it so a map swap or flag re-snap can't serve stale tops. */
  get structureEpoch(): number { return this.structEpoch; }
  private structEpoch = 0;
  /** Raw specs for off-thread consumers (the MPC worker rebuilds the
   *  solid world from these — the colliders themselves aren't shippable). */
  private solidSpecs: readonly StructureSpec[] = [];
  get structureSpecs(): readonly StructureSpec[] { return this.solidSpecs; }

  /** Structure top face under (x,z), -Infinity when none — bot brains
   *  fold this into their ground model so walls read as raised terrain. */
  structureTop(x: number, z: number): number {
    return this.solid?.topAt(x, z) ?? -Infinity;
  }

  /** Seats that arrived before the field — attachTerrain resolves async,
   *  so a join mid-load used to drop here and leave the player shadowless
   *  for the whole session: no reconcile, no corrections, no transit. */
  private pendingTrack = new Map<string, { pos: Vec3Like; yaw: number; perk?: string; team?: string; bot?: boolean; armorClass?: string }>();

  /** Call on join/spawn — seeds the sim at the reported spot. `team`
   *  feeds team-gated colliders (gate shields pass allies). */
  track(playerId: string, pos: Vec3Like, yaw: number, perk?: string, team?: string, bot?: boolean, armorClass?: string): void {
    this.jev({ kind: 'track', pid: playerId, pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, perk, team, bot, armorClass });
    if (!this.surface) {
      this.pendingTrack.set(playerId, { pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, perk, team, bot, armorClass });
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
      // Per-shadow merge scratch — setInput copies declared fields, so a
      // persistent Partial replaces the Object.assign churn per edge.
      mergeIn: {}, jetIn: {},
      lastRepPos: null,
      gapStreak: 0, gapAt: 0, gapClosedAt: 0, gapRunMs: 0, deferStreak: 0, lastHintAt: 0, lastReportAt: 0, reportEma: 0,
      transitEma: 0, clientTransitEma: 0, serverTransitEma: 0, transitVar: 0, reportVar: 0,
    });
    {const sh = this.shadows.get(playerId); if (sh) {sh.sim.waterLevel = this.waterLevel; sh.sim.jumpstart = mods.jumpstart;}}
    // The sim body derives from the class at creation — the default eye
    // otherwise survives a pre-track setBody no-op (applyClass ran before
    // the shadow existed, the eyeOf-vs-class mismatch behind the unbury
    // loop). One write site for eye per lifecycle event: track + setBody.
    if (armorClass && armorClass in CLASS_STATS) {
      const st = CLASS_STATS[armorClass as ArmorClass];
      this.setBody(playerId, st.mass, st.eyeHeight, st.radius);
      this.setSpeedScale(playerId, st.speedScale);
    }
  }

  untrack(playerId: string): void {
    this.jev({ kind: 'untrack', pid: playerId });
    this.shadows.delete(playerId); this.pendingTrack.delete(playerId);
  }

  /** The shadow's own eye height — the measure of "buried" must match
   *  the sim's floor convention (pos.y IS the eye point). Reading the
   *  record's armorClass instead phantom-buries every bot whose sim
   *  body wasn't re-set after a class refit: lifted to the class eye,
   *  sinks back to its sim eye, rescued again — the rescue/re-sink loop. */
  eyeOf(playerId: string): number | undefined {
    return this.shadows.get(playerId)?.sim.eyeHeight;
  }

  /** Unbury autopsy: what the shadow knows about a body the record says
   *  is under the field — its flag, its sim pos, and what each surface
   *  claims the ground is there. */
  unburyDebug(playerId: string): string {
    const sh = this.shadows.get(playerId);
    const pos = sh?.sim.state.pos;
    const x = pos?.x ?? 0, z = pos?.z ?? 0;
    const f = this.surface?.getHeight(x, z).toFixed(1) ?? '?';
    const c = this.botSurface?.getHeight(x, z).toFixed(1) ?? '?';
    // Burial autopsy beyond position: is the sim stepping (simTicks acc),
    // what did the LAST swept debug tick see, and does the sim's own
    // surface agree with the room's samplers at that spot.
    const simG = (sh?.sim as { surface?: { getHeight(x: number, z: number): number } } | undefined)
      ?.surface?.getHeight(x, z);
    const prev = this.unburyTicks.get(playerId);
    if (sh) {this.unburyTicks.set(playerId, sh.simTicks);}
    return `shadow=${this.shadowDesc(sh, simG, prev)} xz=${x.toFixed(1)},${z.toFixed(1)} fieldG=${f} chordG=${c}`;
  }

  private shadowDesc(sh: Shadow | undefined, simG: number | undefined, prev: number | undefined): string {
    if (!sh) {return 'none';}
    return `bot=${sh.bot} y=${sh.sim.state.pos!.y.toFixed(1)} onG=${sh.sim.state.onGround} tickDelta=${prev === undefined ? '?' : sh.simTicks - prev} surfG=${simG === undefined ? '?' : simG.toFixed(1)} vel=${sh.sim.state.vel.x.toFixed(1)},${sh.sim.state.vel.y.toFixed(1)},${sh.sim.state.vel.z.toFixed(1)}`;
  }
  /** unburyDebug's prior simTicks — the tickDelta line that separates a
   *  sim that stopped stepping while buried from one re-seeded per tick. */
  private readonly unburyTicks = new Map<string, number>();

  /** Mid-match team swap (rebalance) — the shadow's gate-shield access
   *  flips with the jersey, not at the next respawn. */
  setTeam(playerId: string, team: string | undefined): void {
    const sh = this.shadows.get(playerId);
    if (sh) {sh.sim.state.team = team;}
  }

  /** Arm the post-re-seat report grace — see the resyncAt comment on the
   *  shadow: pre-gameState frames still in flight are muted ~1 RTT. */
  markReseated(playerId: string): void {
    const sh = this.shadows.get(playerId);
    if (sh) {sh.resyncAt = wallNow();}
  }

  /** Perk swap after track() baked the modifiers — role rebalance pins
   *  (capper featherjets) would otherwise stay cosmetic on the shadow. */
  setPerk(playerId: string, perk?: string): void {
    const sh = this.shadows.get(playerId);
    if (!sh) {return;}
    const mods = perkMods(perk);
    sh.energyMax = mods.energyMax;
    sh.energy = Math.min(sh.energy, ENERGY.max * sh.energyMax);
    sh.jetDrain = mods.jetDrain;
    sh.jetRegen = mods.jetRegen;
    sh.energyRegen = mods.energyRegen;
    sh.sim.jumpstart = mods.jumpstart;
  }

  /** Armor-class ground speed multiplier (server bots / future loadouts). */
  setSpeedScale(playerId: string, scale: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) {sh.sim.speedScale = scale;}
  }

  /** Water dome (the watersphere pack) — the pocket of water a body is
   *  wading through. Undefined clears it, so a sphere that expires or a
   *  body that leaves it is dry again. */
  setWaterDome(playerId: string, dome: { x: number; y: number; z: number; r: number } | undefined): void {
    const sh = this.shadows.get(playerId);
    if (sh) {sh.sim.waterDome = dome;}
  }

  /** Every shadowed body id — the watersphere clears its domes on death. */
  shadowIds(): string[] {
    return [...this.shadows.keys()];
  }

  /** Tether snare the body is inside (enemy side) — undefined clears it. */
  setTether(playerId: string, tether: { x: number; y: number; z: number; r: number } | undefined): void {
    const sh = this.shadows.get(playerId);
    if (sh) {sh.sim.tether = tether;}
  }

  tetherSlowOf(playerId: string): number {
    return this.shadows.get(playerId)?.sim.tetherSlowNow ?? 0;
  }

  /** Armor-class body — mass divides jet thrust/impulses, eyeHeight sets
   *  the grounded stand height. Must mirror the client's prediction. */
  setBody(playerId: string, mass: number, eyeHeight: number, bodyRadius: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) { sh.sim.mass = mass; sh.sim.eyeHeight = eyeHeight; sh.sim.bodyRadius = bodyRadius; }
  }

  /** Map water level — the sea surface the shadows float in. Absent clears
   *  it, so a hot-reload onto a dry map can't leave the old sea behind.
   *  Applied to live shadows and every later track(). */
  setWaterLevel(level?: number): void {
    this.jev({ kind: 'water', level });
    this.waterLevel = level;
    for (const sh of this.shadows.values()) {sh.sim.waterLevel = level;}
  }

  /** Kill zone — world Y below which a shadow is out of the arena. The
   *  heightfield is always present, so on a terrainless map this is what
   *  ends a fall. Absent = no zone (every other map unchanged). */
  setKillY(level?: number): void {
    this.jev({ kind: 'killY', level });
    this.killY = level;
  }

  /** Command-queue ingress — inputMove does NOT apply on arrival. Edges
   *  queue in seq order and the next tick's phase-0 drain replays them
   *  across the window, so a tick's outcome can't depend on where inside
   *  the window a packet landed. Seq gate mirrors setInput's so the
   *  caller's stale-check answer is unchanged. FIFO not slot: newest-
   *  wins dropped every co-tick edge (tap-jumps, double-edges inside
   *  50ms, the prev-redundancy copy) — a systematic divergence vs the
   *  client's per-edge replay. */
  queueInput(playerId: string, input: Partial<MoveInput>, status = 0, seq?: number, ageMs?: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) {return true;}
    // Gate against the queued tail too — lastInputSeq only moves at
    // drain, so without it a reordered old packet could append a stale
    // edge behind fresher queued ones.
    const tail = sh.pending.length > 0 ? sh.pending[sh.pending.length - 1]!.seq : undefined;
    if (seq !== undefined && seq <= Math.max(sh.lastInputSeq, tail ?? 0)) {return false;}
    // ageMs is a client-claimed "this edge fired N ms before send" -
    // same trust class as fireAt: clamp it into the link's plausible
    // window (honest age error IS uplink jitter) so a forged stamp
    // can't buy replay time the path never had. est lands the edge on
    // the server's wall clock: arrival minus transit minus claimed age.
    let est: number | undefined;
    if (ageMs !== undefined && Number.isFinite(ageMs)) {
      const clamped = Math.min(Math.max(ageMs, 0), sh.transitEma * 2 + sh.transitVar * 4 + 50);
      est = wallNow() - sh.transitEma - clamped;
    }
    sh.pending.push({ input, status, seq, est });
    // Bounded — a flood can't queue unbounded replay work; the oldest
    // edge drops (its seq anchor with it) so the newest intent survives.
    if (sh.pending.length > 8) {sh.pending.shift();}
    return true;
  }

  /** inputMove → sim input. Rotation/yaw comes from position reports.
   *  `status` is the claimed toggle bits — used to model skill energy
   *  drain and activation antes (rising-edge costs). */
  setInput(playerId: string, input: Partial<MoveInput>, status = 0, seq?: number): boolean {
    const sh = this.shadows.get(playerId);
    if (!sh) {return true;} // no field → no sim → nothing to order
    if (seq !== undefined && seq <= sh.lastInputSeq) {return false;}
    if (this.journal) {this.jev({ kind: 'input', pid: playerId, input: { ...input }, status, seq });}
    if (seq === undefined) {
      if (input.jetHeld !== undefined) {sh.jetWanted = input.jetHeld;}
      this.applyInput(sh, input, sh.jetWanted && sh.energy > 0);
    } else {
      sh.lastInputSeq = seq;
      if (input.jetHeld !== undefined) {sh.jetWanted = input.jetHeld;}
      this.applyInput(sh, input, sh.jetWanted && sh.energy > 0);
      // The anchor carries the input that runs FORWARD from this seq —
      // anchoredCompare replays anchor(k).inp over [k, k+1), so a
      // pre-apply snapshot would replay the input that just ended and
      // read every real edge as a phantom divergence.
      sh.seqStates.set(seq, {
        snap: sh.sim.snapshot(),
        tick: sh.simTicks,
        inp: Object.assign({}, sh.sim.input),
        e: sh.energy,
      });
      if (sh.seqStates.size > 32) {evictEldest(sh.seqStates);}
    }

    // Rising-edge antes — the client pays the activation cost when the
    // bit comes up; the sim must mirror it or cloaked jetters desync.
    const rising = status & ~sh.lastStatus;
    if (rising & STATUS.CLOAK) {sh.energy = Math.max(0, sh.energy - ENERGY.cloakCost);}
    if (rising & STATUS.SHIELD) {sh.energy = Math.max(0, sh.energy - ENERGY.shieldCost);}
    if (rising & STATUS.MEND) {sh.energy = Math.max(0, sh.energy - ENERGY.mendCost);}
    sh.lastStatus = status;

    const hSpeed = dhypot2(sh.sim.state.vel.x, sh.sim.state.vel.z);
    sh.skillDrainPerSec =
      (status & STATUS.CLOAK ? cloakDrainPerSec(hSpeed) : 0) +
      (status & STATUS.SHIELD ? ENERGY.shieldDrain : 0) +
      (status & STATUS.MEND ? ENERGY.mendDrain : 0);
    sh.skillSuppressRegen = sh.skillDrainPerSec > 0;
    return true;
  }

  /** Merge an input edge + the server-modeled jet bit into the shadow's
   *  persistent scratch and apply — every field is written each call so
   *  an absent edge field reads undefined (setInput skips those) rather
   *  than applying the previous edge's value. */
  private applyInput(sh: Shadow, input: Partial<MoveInput>, jetHeld: boolean): void {
    const m = sh.mergeIn;
    m.forward = input.forward; m.right = input.right;
    m.jumpPressed = input.jumpPressed; m.jumpHeld = input.jumpHeld;
    m.skiHeld = input.skiHeld; m.jetHeld = jetHeld;
    sh.sim.setInput(m);
  }

  /** Energy refunds the world grants — gem pickup half-tank refill. */
  grantEnergy(playerId: string, amount: number): void {
    const sh = this.shadows.get(playerId);
    if (sh && Number.isFinite(amount)) {
      this.jev({ kind: 'energy', pid: playerId, amount, drain: false });
      sh.energy = Math.min(ENERGY.max * sh.energyMax, sh.energy + amount);
    }
  }

  /** Energy burns outside the input stream — shield damage soak. */
  drainEnergy(playerId: string, amount: number): boolean {
    const sh = this.shadows.get(playerId);
    // NaN amount: Math.max(0, NaN) = NaN — one poison write kills
    // jets/skills for the session and never self-heals.
    if (!sh || !Number.isFinite(amount)) {return false;}
    this.jev({ kind: 'energy', pid: playerId, amount, drain: true });
    sh.energy = Math.max(0, sh.energy - amount);
    return true;
  }

  /** Modeled tank level — brains read this for jet/skill gating. */
  energyOf(playerId: string): number | null {
    return this.shadows.get(playerId)?.energy ?? null;
  }

  /** Knockback/AOE impulses the server itself applied — the sim must get
   *  the same delta or every blast reads as a divergence. */
  applyImpulse(playerId: string, dv: Vec3Like, fallBoost?: number): void {
    const sh = this.shadows.get(playerId);
    // sim-vel names a poisoned shadow but doesn't fix it — a NaN dv
    // writes straight into the sim's velocity, so the funnel drops it.
    if (!sh || !Number.isFinite(dv.x + dv.y + dv.z)) {return;}
    this.jev({ kind: 'impulse', pid: playerId, dv: { x: dv.x, y: dv.y, z: dv.z } });
    sh.sim.impulse(dv);
    if (fallBoost !== undefined) {sh.sim.armFallBoost(fallBoost);}
    sh.lastImpulseAt = wallNow();
  }

  /** Tick-set confirm for the wire frame — the highest inputMove seq
   *  this player's shadow has accepted. Pending counts too: an undrained
   *  edge is already claimed — a held-state frame older than it must not
   *  rewind the input it set. -1 for untracked ids (spectators):
   *  encodes as 0 on the wire. */
  inputSeqOf(playerId: string): number {
    const sh = this.shadows.get(playerId);
    if (!sh) {return -1;}
    const tail = sh.pending.length > 0 ? sh.pending[sh.pending.length - 1]!.seq ?? 0 : 0;
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
    if (!sh) {return null;}
    if (this.journal) {this.jev({ kind: 'reconcile', pid: playerId, pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, vel: vel && { x: vel.x, y: vel.y, z: vel.z }, seq: reportInputSeq, rtt: rttMs });}
    // The report's own RTT estimate feeds the broadcast lead — the
    // uplink half is how stale the shadow's input stream is. It's
    // client-reported, so it's a lower bound on trust: server-measured
    // ping/pong echoes cap it from above in syncTransit.
    this.noteRtt(sh, rttMs);
    // reportInputSeq = the client's input counter at snapshot time. Only
    // a report stamped ahead of everything RECEIVED counts as a gap — a
    // seq parked in pending is covered, just not drained yet. ≥3
    // consecutive uncovered reports means events were lost, not queued
    // (≥2 measured worse: the early hint's resend re-anchored the client
    // mid-flight and corrections tripled on the adverse soak).
    if (reportInputSeq !== undefined && reportInputSeq > Math.max(sh.lastInputSeq, sh.pending.length > 0 ? sh.pending[sh.pending.length - 1]!.seq ?? 0 : 0)) {
      if (sh.gapStreak === 0) {sh.gapAt = wallNow();} // streak start — the judge's in-flight grace window
sh.gapStreak += 1;
      const now = wallNow();
      if (sh.gapStreak >= 3 && now - sh.lastHintAt > 1000) {
        sh.lastHintAt = now;
        this.onInputGap?.(playerId, sh.lastInputSeq);
      }
    } else {
      // Streak close: record when and how long it ran. The report that
      // closes it is the catch-up one — mostly explained by the stall
      // the shadow free-ran — so the judge keeps crediting the bar for a
      // short window past the close (GAP_CLOSED_GRACE_MS) instead of
      // dropping the deficit exactly where it peaks.
      if (sh.gapStreak > 0) {
        sh.gapRunMs = wallNow() - sh.gapAt;
        sh.gapClosedAt = wallNow();
      }
      sh.gapStreak = 0;
    }
    return this.judge.reconcile(sh, playerId, pos, yaw, vel, reportInputSeq, rttMs);
  }

  /** Aim/heading update for entities that never send position reports
   *  (server bots): facing is host truth, not a claim. */
  faceYaw(playerId: string, yaw: number): void {
    const sh = this.shadows.get(playerId);
    if (sh) {this.jev({ kind: 'face', pid: playerId, yaw }); sh.sim.state.yaw = yaw;}
  }

  /** Declared discontinuity (teleport/respawn) — resync without counting. */
  resync(playerId: string, pos: Vec3Like, yaw: number, fullEnergy = false): void {
    const sh = this.shadows.get(playerId);
    // Claim lanes gate upstream, but a NaN spawn/reseat from any caller
    // still seeds a poisoned shadow — sim-pos can only count it after.
    if (!sh || !Number.isFinite(pos.x + pos.y + pos.z + yaw)) {return;}
    this.jev({ kind: 'resync', pid: playerId, pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, fullEnergy });
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

  /** Persistent broad-phase state — cell arrays stay alive across
   *  ticks (the occupied set is bounded by body count), so a rebuild
   *  is length resets + pushes, not a fresh Map and number[] churn.
   *  The bodies list reuses bodyScratch for the same reason. */
  private readonly gridCells = new Map<number, number[]>();
  private readonly bodyScratch: ({ id: string } & BodyCapsule)[] = [];

  tick(dt: number): void {
    const bodies = this.bodySource ? this.bodyScratch : null;
    if (bodies) {bodies.length = 0; for (const b of this.bodySource!()) {bodies.push(b);}}
    // One shared broad-phase per tick: without it every shadow scans the
    // whole roster in collideBodies — O(shadows × bodies) at scale. 4m
    // cells dwarf any contact radius, so the 3x3 ring around a pos
    // always contains every capsule it could touch.
    let bodiesNear: ((x: number, z: number) => BodyCapsule[]) | undefined = undefined;
    if (bodies && bodies.length > 0) {
      const CELL = 4, BIAS = 512;
      const grid = this.gridCells;
      for (const cell of grid.values()) {cell.length = 0;}
      for (let i = 0; i < bodies.length; i += 1) {
        const b = bodies[i]!;
        const k = ((Math.floor(b.x / CELL) + BIAS) << 16) | (Math.floor(b.z / CELL) + BIAS);
        const cell = grid.get(k);
        if (cell) {cell.push(i);} else {grid.set(k, [i]);}
      }
      // Cells return indices — sorted back to roster order so contact
      // resolution runs in the exact sequence the flat scan produced
      // (order matters when 3+ capsules overlap).
      const idx: number[] = [];
      const scratch: BodyCapsule[] = [];
      bodiesNear = (x, z): BodyCapsule[] => {
        idx.length = 0; scratch.length = 0;
        const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
        for (let dx = -1; dx <= 1; dx += 1) {for (let dz = -1; dz <= 1; dz += 1) {
          const cell = grid.get(((cx + dx + BIAS) << 16) | (cz + dz + BIAS));
          if (cell) {for (const i of cell) {idx.push(i);}}
        }}
        idx.sort((a, b): number => a - b);
        for (const i of idx) {scratch.push(bodies[i]!);}
        return scratch;
      };
    }
    for (const [pid, sh] of this.shadows) {
      // Phase 0 (per shadow): drain the queued edges through setInput in
      // seq order — seq-journal anchors, jet gating, and rising-edge
      // antes all land before the econ pass reads the final jetWanted.
      const edges = sh.pending.length > 0 ? sh.pending.splice(0, sh.pending.length) : null;
      // Stamped slicing needs the input state that governed BEFORE the
      // first edge fired - setInput is about to overwrite it, so capture
      // it here (the drain must still see edges in seq order for
      // anchors/gating/antes).
      const preIn = edges ? { ...sh.sim.input } : null;
      if (edges) {for (const e of edges) {this.setInput(pid, e.input, e.status, e.seq);}}
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
      if (sh.jetLockT > 0) {sh.jetLockT -= dt;}
      const jetting = sh.jetWanted && sh.energy > 0 && sh.jetLockT <= 0;
      if (jetting) {sh.energy -= ENERGY.jetDrain * sh.jetDrain * dt;}
      if (sh.skillDrainPerSec > 0) {sh.energy -= sh.skillDrainPerSec * dt;}
      if (!jetting && !sh.skillSuppressRegen) {
        sh.energy = Math.min(ENERGY.max * sh.energyMax, sh.energy + ENERGY.jetCharge * sh.jetRegen * sh.energyRegen * dt);
      }
      // NaN is sticky (Math.max(0, NaN) = NaN) — a poisoned pool would
      // ride forever; drain to empty once, then let regen rebuild it.
      if (!Number.isFinite(sh.energy)) {sh.energy = 0;}
      sh.energy = Math.max(0, sh.energy);
      // Pool law: energy lives in [0, cap]. grant/regen both clamp —
      // an over-cap read here means a write path added without one.
      inv('energy-bounds', sh.energy <= ENERGY.max * sh.energyMax + 0.01,
        () => ({ id: pid, e: Number(sh.energy.toFixed(1)), cap: Number((ENERGY.max * sh.energyMax).toFixed(1)) }));
      if (sh.energy <= 0) {sh.jetLockT = ENERGY.jetLockout;}
      sh.jetIn.jetHeld = jetting;
      sh.sim.setInput(sh.jetIn);
      // Resting shadows skip the integrator: quiet input + ~zero
      // velocity + grounded means two sub-steps of terrain/solid/body
      // probes would land exactly where it started. Parked defenders
      // and AFK humans sit here a third of their ticks.
      const s = sh.sim.state, inp = sh.sim.input;
      // onGround lies at seed/resync (setState writes it true even for
      // a mid-air drop) — the gate measures rest against the real
      // ground under it, or a dropped body never starts falling.
      // A sunk shadow is NOT resting — pos.y - groundY goes negative,
      // which passed the upper bound alone, so a bot seeded under
      // terrain (respawn anchor, stale resync) parked forever instead
      // of stepping back onto the floor. 2Hz unbury was the only
      // rescue — that was the ~1s sink-then-pop cycle, 514 rescues in
      // one 15-minute soak.
      // Cheap gates first: the heightfield+structureTop probe is the
      // expensive term — on a moving roster it ran per-shadow-per-tick
      // only to be discarded (hmChord showed up in the cpuprofile).
      const resting = s.onGround
        && Math.abs(s.vel.x) + Math.abs(s.vel.y) + Math.abs(s.vel.z) < 0.05
        && !inp.forward && !inp.right && !inp.jumpHeld && !inp.jumpPressed && !inp.skiHeld && !inp.jetHeld
        && (!edges || edges.every((e): boolean => !e.input.forward && !e.input.right && !e.input.jumpHeld && !e.input.jumpPressed && !e.input.skiHeld && !e.input.jetHeld))
        && ((): boolean => {
          const surf = sh.bot && this.botSurface ? this.botSurface : this.surface;
          const groundY = Math.max(
            surf ? surf.getHeight(s.pos.x, s.pos.z) : s.pos.y,
            this.structureTop(s.pos.x, s.pos.z),
          );
          return s.pos.y - groundY > -0.5 && s.pos.y - groundY < sh.sim.eyeHeight + 0.5;
        })()
        && (!bodiesNear || !bodiesNear(s.pos.x, s.pos.z).some((b): boolean => b.id !== pid && Math.abs(b.x - s.pos.x) < 2.5 && Math.abs(b.z - s.pos.z) < 2.5));
      if (!resting) {
        let landing = 0;
        // MoveSim.update() sub-steps internally at its own 1/60 quantum —
        // feed it the raw tick delta. Count consumed steps ourselves for
        // the seq-anchored journal (simTicks is in STEP quanta).
        if (edges) {
          if (edges.every((e): boolean => e.est !== undefined)) {
            // Stamped edges replay at their real intra-tick times: edge
            // i's input governs [est_i, est_{i+1}) and the sim's
            // pre-edge state covers [t0, est_0). Estimates clamp into
            // the window and stay non-decreasing - a forged or skewed
            // stamp degrades to zero-length slices, not time travel.
            // This is the claim-driven side of the tick window, so the
            // placement clock is the same wall domain the stamps use.
            const t1 = wallNow();
            const t0 = t1 - dt * 1000;
            // preIn (pre-drain input) governs [t0, est_0) - setInput
            // already pushed the FINAL edge state live, so without
            // restoring it the pre-edge span would run future input.
            this.applyInput(sh, preIn!, jetting);
            let t = t0, prevEst = t0;
            for (const e of edges) {
              const start = Math.min(Math.max(e.est!, prevEst), t1);
              prevEst = start;
              if (start > t) {
                sh.sim.update((start - t) / 1000);
                landing = Math.max(landing, sh.sim.landingImpact);
              }
              this.applyInput(sh, e.input, jetting);
              t = start;
            }
            if (t1 > t) {
              sh.sim.update((t1 - t) / 1000);
              landing = Math.max(landing, sh.sim.landingImpact);
            }
          } else {
            // Interleave: each edge governs an equal slice of the window
            // (uniform intra-tick timing for unstamped edges), so a
            // press+release pair holds the key for ~half the tick and
            // the hop/jet fires instead of collapsing into the final
            // state.
            const slice = dt / edges.length;
            for (const e of edges) {
              this.applyInput(sh, e.input, jetting);
              sh.sim.update(slice);
              landing = Math.max(landing, sh.sim.landingImpact);
            }
          }
        } else {
          sh.sim.update(dt);
          landing = Math.max(landing, sh.sim.landingImpact);
        }
        // T1 fall damage (floodyberry part 3): -v·n at the contact kill
        // pays (impact - 25) * 0.005 of the bar — the funnel lives one
        // layer up so respawn/killfeed ride the same path as any death.
        if (landing * sh.sim.fallBoost > MOVEMENT_CONFIG.fallDamageMinSpeed) {this.onLanding?.(pid, landing * sh.sim.fallBoost);}
      }
      // Kill zone: the deck ran out and the void starts. Checked on the
      // shadow, not on a claim — the client can't argue its way out of
      // falling off the map. Outside the resting gate on purpose: a body
      // parked on a surface below the plane (the plain under a sky arena)
      // is still out of the arena, and gating it made such a body immortal.
      if (this.killY !== undefined && s.pos.y < this.killY) {this.onKillZone?.(pid);}
      sh.acc += dt;
      const steps = Math.floor(sh.acc / MoveSim.STEP);
      sh.acc -= steps * MoveSim.STEP;
      sh.simTicks += steps;
      // A NaN shadow is invisible on the wire AND keeps consuming
      // claims — the poison always enters through an ungated lane, so
      // name the field that broke, don't silence it.
      inv('sim-pos', Number.isFinite(s.pos.x + s.pos.y + s.pos.z), () => ({ id: pid }));
      inv('sim-vel', Number.isFinite(s.vel.x + s.vel.y + s.vel.z), () => ({ id: pid }));
    }
    this.journalT += 1;
    if (this.journal && this.journalT % JOURNAL_HASH_EVERY === 0) {
      this.journal.push({ t: this.journalT, kind: 'hash', h: this.journalHash() });
    }
  }

  /** Server-measured RTT (ping/pong echo) — the unforgeable channel.
   *  A delayed pong inflates only this EMA, and min() in syncTransit
   *  means it can never RAISE the effective estimate. */
  feedTransit(playerId: string, rttMs: number): void {
    const sh = this.shadows.get(playerId);
    if (!sh || !(rttMs > 0)) {return;}
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
    if (!sh || !(uplinkMs >= 0)) {return;}
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

  // The report's own RTT estimate feeds the broadcast lead — the
  // uplink half is how stale the shadow's input stream is. It's
  // client-reported, so it's a lower bound on trust: server-measured
  // ping/pong echoes cap it from above in syncTransit.
  private noteRtt(sh: Shadow, rttMs: number | undefined): void {
    if (rttMs === undefined || rttMs <= 0) {return;}
    const tr = Math.min(rttMs / 2, TRANSIT_EMA_CAP_MS);
    if (sh.serverTransitEma === 0) {sh.transitVar = sh.transitVar * 0.9 + Math.abs(tr - sh.transitEma) * 0.1;}
    sh.clientTransitEma = sh.clientTransitEma === 0 ? tr : sh.clientTransitEma * 0.9 + tr * 0.1;
    this.syncTransit(sh);
  }

  /** Uplink-transit estimate (ms) for the broadcast lead — the shadow
   *  trails the client's authored stream by this much. */
  transitOf(playerId: string): number {
    return this.shadows.get(playerId)?.transitEma ?? 0;
  }

  /** Link jitter — EMA of |sample − transitEma|. Server-observed, so
   *  lag-comp bounds can key off the real path instead of client claims. */
  transitVarOf(playerId: string): number {
    return this.shadows.get(playerId)?.transitVar ?? 0;
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

  /** The shadow sim itself — BotMpc clones it for forward search.
   *  Read-only in intent: mutating it mutates the live drive. */
  simOf(playerId: string): MoveSim | null {
    return this.shadows.get(playerId)?.sim ?? null;
  }

  /** Energy economy for the MPC planner — the search has to model the
   *  same tank the shadow drains (drain/regen are perk multipliers). */
  econOf(playerId: string): { energy: number; jetDrain: number; jetRegen: number; energyRegen: number; energyMax: number } | null {
    const sh = this.shadows.get(playerId);
    return sh ? { energy: sh.energy, jetDrain: sh.jetDrain, jetRegen: sh.jetRegen, energyRegen: sh.energyRegen, energyMax: sh.energyMax } : null;
  }
}
