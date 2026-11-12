/**
 * TickFanout -- the per-tick record family for TickLoop: which players
 * earn a record this tick (skip/reap/suppress), the server-owned health
 * and charge echoes that ride along, and the distance-tiered fanout to
 * each recipient. TickLoop owns the timers/metrics rollup; this owns
 * "what leaves the room this tick".
 */
import type { Room } from './Room.ts';
import { encodeTickPlayerV4, encodeTickFrame, WIRE_TICK_V4, tickEncodeScratch, v4Last, sparseV4Record, type TickEncodeScratch, type WireTickPlayer } from '../../shared/wire.ts';
import { STATUS, SHOOT_REVEAL_S } from '../../shared/status.ts';
import { lgChargeAt } from '../../shared/combat.ts';
import { heldBuffRates, POWERUP } from '../../shared/pickups.ts';
import { BELT_MAX, ammoOf, WEAPONS } from '../../shared/weapons.ts';
import { logger } from './logger.ts';
import type { PlayerState } from './types.ts';
import { PlayerManager } from './PlayerManager.ts';
import { healPerTick, recordSuppressed, type TickRecord } from './tickHelpers.ts';
import { WORLD_MODEL, spawnPayload } from '../../shared/worldModel.ts';
import type { ServerMessage } from '../../shared/protocol.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { CONFIG } from './config.ts';
import { healPool } from './healPool.ts';
import { inv } from '../../shared/invariants.ts';
import { simNow } from './simClock.ts';
import { wallNow , wallMs} from './wallClock.ts';

type Players = ReturnType<Room['players']['getAllPlayers']>;
type PooledRecord = TickRecord & { enc: TickEncodeScratch; enc2?: TickEncodeScratch; encSparse?: TickEncodeScratch; sparseTick?: number; spd?: number };

/** Everything the per-recipient fanout stages share -- one reused
 *  object (rctx) so the seat loop doesn't allocate a context per
 *  recipient per tick. fanoutRecipient populates it before the
 *  gather/eval/send stages run; nothing downstream outlives the call. */
interface RcpCtx {
  room: Room;
  players: Players;
  recipientId: string;
  rp: PlayerState;
  rx: number;
  ry: number;
  rz: number;
  seq: number;
  tiers: Map<number, number>;
  intro: boolean;
  introFull: boolean;
  pending: Set<string> | undefined;
  engaged: Map<string, number> | undefined;
  recCap: number;
  tScan: bigint;
}

/** Derived per-candidate values emitEval consumes -- evalRecord fills
 *  the shared scratch (evg) so the hot path allocates nothing. */
interface EvalGeom { dSq: number; dx: number; dz: number; mem: number | undefined; spd: number; }

/** The ensured lastSent snapshot -- Room.lastSentPositions' value type. */
type SentSnap = NonNullable<ReturnType<Room['lastSentPositions']['get']>>;

/** What recordGate hands the emit half: the ensured snapshot plus the
 *  per-player wire values computed on the way. */
interface RecGate {
  snap: SentSnap;
  forceSend: boolean;
  sheep: number;
  wireStatus: number;
  hidden: boolean;
}

/** Per-tick build accumulators -- one per buildRecords call (not per
 *  player), threaded through emitRecord. */
interface BuildCtx {
  recN: number;
  roster: Record<number, string> | null;
  rosterDirty: boolean;
  introPending: boolean;
}

/** A retired wireId is reissued only after this much dead time -- any
 *  plausible cross-lane reorder window (reliable roster edge vs binary
 *  frames) is sub-second; 60s is paranoia, not measurement. */
const WIRE_ID_QUIET_MS = 60_000;

/** Dev-only frame-loss repro -- see the drop site in fanoutRecords. */
const DROP_PCT = Number(process.env.FPS_DROP_PCT ?? 0) || 0;

/** Mint a u16 record id: prefer a retired id that's been quiet long
 *  enough, else extend the counter. The naive `nextWireId++` walked into
 *  the u16 wrap at 65536 total mints -- setUint16 mods silently and the
 *  new player's records would resolve to a *live teammate's* binding. */
function mintWireId(room: Room): number {
  const now = wallNow();
  for (const [id, at] of room.wireIdRetired) {
    if (now - at >= WIRE_ID_QUIET_MS) { room.wireIdRetired.delete(id); return id; }
  }
  if (room.nextWireId <= 0xFF_FF) {return ((room.nextWireId += 1) - 1);}
  // Space exhausted with nothing quiet enough -- take the eldest retired
  // id anyway; strictly better than a silent modulo-wrap.
  const eldest = room.wireIdRetired.keys().next().value;
  if (eldest !== undefined) {
    logger.error('wireId space full -- recycling before the quiet window', { room: room.name, id: eldest });
    room.wireIdRetired.delete(eldest);
    return eldest;
  }
  // 65536 simultaneously-bound ids -- the room has bigger problems than
  // this collision, but fail loud rather than aliasing silently.
  logger.error('wireId space exhausted -- live collision', { room: room.name });
  return (((room.nextWireId += 1) - 1) % 0xFF_FF) + 1;
}

/** Deterministic 0-7 phase for a recipient's far-emit tick -- spreads
 *  the far-scan work evenly across ticks instead of one seq%8 spike
 *  doing N^2 every 400ms. */
function staggerOf(pid: string): number {
  let h = 0;
  for (let i = 0; i < pid.length; i += 1) {h = (h + pid.charCodeAt(i)) | 0;}
  return h & 7;
}

/** Kth-smallest of `a` (0-indexed k) -- quickselect on a copy so the
 *  candidate order stays stable for the emit filter. Linear expected
 *  time; only runs for recipients whose roster exceeds the cap. */
function kthSmallest(a: number[], k: number): number {
  const b = a.slice();
  const ki = k - 1;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) {
    const pivot = b[(lo + hi) >> 1]!;
    let i = lo, j = hi;
    while (i <= j) {
      while (b[i]! < pivot) {i++;}
      while (b[j]! > pivot) {j--;}
      if (i <= j) {const t = b[i]!; b[i] = b[j]!; b[j] = t; i++; j--;}
    }
    if (ki <= j) {hi = j;} else if (ki >= i) {lo = i;} else {return b[ki]!;}
  }
  return b[ki]!;
}

/** Counters the loop's metrics rollup reads -- shared object so a second
 *  writer (this family) lands in the same rollup window. */
export interface FanoutMetrics {
  recordsBuilt: number;
  recordsSuppressed: number;
  recordsIdleReaped: number;
  recordsSent: number;
  recordsTierSkipped: number;
  /** Stop-tier verdicts -- far+static records replicated nothing (the
   *  sparse cadence record carries no truth a 0-vel ghost lacks). */
  recordsStopped: number;
  bytesSent: number;
  tickFramesDropped: number;
  /** Frames held at the intro gate (join burst still draining) -- NOT
   *  loss: the client can't decode them yet either. Tracked separately
   *  so join storms don't masquerade as shed. */
  tickFramesHeld: number;
  /** Records dropped by the K-nearest per-recipient cap -- egress bound,
   *  not loss: the culled ghosts are the farthest by definition. */
  recordsCapped: number;
  /** Candidate records distance-tested per tick across all recipients
   *  (near-circle + every-tick list) -- the O(N^2) term the spatial
   *  index bounds. recordsScanned / recipients ≈ candidates/seat. */
  recordsScanned: number;
  /** Per-tick ns split inside fanoutRecords: candidate gather+eval vs
   *  cap-filter + frame encode + send -- decides where the next lever
   *  lives (index already cut the scan; if encode dominates, the
   *  fanout phase is frame assembly, not interest math). */
  scanNs: number;
  frameNs: number;
}

export class TickFanout {
  /** Scratch array: same array every tick, zero allocation on the hot
   *  path -- encodeTickFrame consumes it before the next recipient
   *  iterates. */
  private readonly scratchOthers: Uint8Array[] = [];
  // Record pool: build→fanout is synchronous within one tick, so the
  // array, its wrappers, and their encode buffers all recycle -- fresh
  // allocations per room per tick were the last steady-state allocs in
  // the fanout path.
  private readonly scratchRecords: PooledRecord[] = [];
  /** Per-recipient tier memory (recipient → target playerId → tier) --
   *  boundary orbits need hysteresis or the send cadence flaps 20↔10Hz
   *  tick-to-tick. Increases require 15% past the boundary; decreases
   *  (closer) always apply immediately -- fresh data is never wrong. */
  private readonly tierMem = new Map<string, Map<number, number>>();
  /** Scratch basis for per-recipient intro fulls -- NEVER the shared
   *  v4Last ring (a second encode against it would double-step the basis
   *  receivers actually hold). forceFull makes every call fresh, so the
   *  basis contents don't matter -- it's a parameter-shape dummy. */
  private readonly introLast = v4Last();
  /** Scratch fields object for encodeTickPlayerV4 -- read synchronously
   *  inside the call and never retained, so one shared object replaces a
   *  per-record-per-tick allocation (the last hot-loop garbage left). */
  private readonly scratchFields: WireTickPlayer =
    { playerId: '', position: { x: 0, y: 0, z: 0 }, rotation: { yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, health: 0, isDead: false, ping: undefined, ski: 0, jet: 0, status: 0, sheep: 0 };

  private static readonly IDLE_KICK_MS = CONFIG.idleKickMs; // silent >60s → remove
  /** Claim silence past this is broadcast as declared-stale — long enough
   *  to swallow loss/reorder gaps, short enough to matter before the
   *  idle/afk reapers. */
  private static readonly STALE_MS = 5000;
  /** v4 masks delta against last-encoded state -- a masked field a lost
   *  frame carried stays stale until it changes again or this forces a
   *  full record (15 ticks = 750ms worst-case drift on a torn link). */
  private static readonly FULL_RECORD_EVERY = 15;
  /** First ticks of a joiner's intro window get every record every tick
   *  -- the decode baseline must punch through loss fast. The window's
   *  tail keeps sending the full VARIANT but at normal tier cadence:
   *  stacked intros in a join burst otherwise each pay full-cadence +
   *  full-copies for a whole second (measured: join-phase CPU ~2.2x
   *  settled, profload --settle 3). */
  private static readonly INTRO_CADENCE_TICKS = 5;
  /** Seats a joiner's world admits per fanout tick -- 4/tick drains a
   *  30-seat roster in ~350ms (the burst becomes a trickle). */
  private static readonly ADMIT_PER_TICK = 4;
  /** Hard bound on records per recipient per tick. Without it egress is
   *  ~quadratic in roster: every seat gets everything its interest
   *  tiers admit, so a 500-seat room ships ~roster-sized frames to every
   *  seat. Culled records are by definition the farthest -- hits/kills
   *  still ride reliable events, and forced (hit/knockback) + intro
   *  records are exempt since they carry truth a cap can't defer. */
  private static readonly MAX_RECORDS = 32;
  /** Cap candidates: variant + score pairs that compete for MAX_RECORDS
   *  slots (exempt traffic pushed straight into `others`). */
  private readonly candRecs: Uint8Array[] = [];
  private readonly candScore: number[] = [];
  /** Spatial index (Replication-Graph shape): records bucketed by map
   *  cell once per tick so a recipient distance-tests only its own
   *  engagement volume instead of the whole roster -- the measured
   *  O(N^2) fanout phase at 370 seats. */
  private readonly cells = new Map<number, TickRecord[]>();
  /** Records evaluated every tick regardless of distance: fast movers
   *  (5m-travel-budget tier) and forced records (hit-window sends +
   *  staggered fulls) -- both carry truth that can't wait for the
   *  far-scan tick. Slow far records are evaluated only on the seq%8
   *  emit tick their tier could ever fire on. */
  private readonly fastRecords: TickRecord[] = [];
  /** Per-recipient candidate list -- rebuilt each recipient, holds
   *  near-circle + fast records, ordered nearest-cell-first so the cap
   *  cutoff can early-out the rest. */
  private readonly candList: TickRecord[] = [];
  private readonly candListMin: number[] = [];
  private readonly cellKeys: number[] = [];
  private readonly cellMinSq: number[] = [];
  /** Cells a recipient's near circle actually included this tick --
   *  the far emit iterates every OTHER cell. */
  private readonly nearCellKeys = new Set<number>();
  /** Per-recipient fanout context -- repopulated each recipient,
   *  reused across the whole seat loop (zero per-seat allocation). */
  private readonly rctx: RcpCtx = {
    room: null!, players: null!, recipientId: '', rp: null!,
    rx: 0, ry: 0, rz: 0, seq: 0, tiers: new Map(), intro: false,
    introFull: false, pending: undefined, engaged: undefined,
    recCap: 0, tScan: 0n,
  };
  /** evalRecord's derived values for emitEval -- one reused object. */
  private readonly evg: EvalGeom = { dSq: 0, dx: 0, dz: 0, mem: undefined, spd: 0 };
  /** Engagement cell size + span: recipients gather cells whose CENTER
   *  sits inside ~950m (covers the 600m outer tier x 1.15 hysteresis
   *  plus a cell's half-diagonal). A box span was too fat on a 2km
   *  map -- the corner cells alone held a third of the roster. */
  private static readonly CELL = 350;
  private static readonly CELL_SPAN = 3;
  private static readonly NEAR_CELL_SQ = 950 * 950;
  /** Score far-cell emits compete under -- they always lose to anything
   *  in-engagement (that's the point of a cap), so an honest ordering
   *  inside the far set is unnecessary. */
  private static readonly FAR_SCORE = 1e9;
  private cellKey(x: number, z: number): number {
    return (Math.floor(x / TickFanout.CELL) + 4096) * 8192 + Math.floor(z / TickFanout.CELL) + 4096;
  }
  /** Aim-cone engagement boost (the 500m rule): a record inside the
   *  recipient's +-45deg view sector scores CONE_BOOST x its true
   *  distance-squared -- 500m in-cone competes like ~200m, beating
   *  midfield bystanders. The multiplier is deliberately no stronger
   *  than the named constraint needs: it also bounds how far the
   *  early-out cutoff must reach (cutoff x ~2.5, not x5). */
  private static readonly CONE_HALF = Math.PI / 4;
  private static readonly CONE_BOOST = 0.16;
  /** Mutual-engagement multiplier — far stronger than the cone boost:
   *  the record that's literally shooting you must win the cap. */
  private static readonly ENGAGE_BOOST = 0.02;
  /** Strained-conn cap — a link shedding tick frames gets half the
   *  record budget so encode+egress drop on exactly the links that
   *  can't keep up. */
  private static readonly STRAIN_RECORDS = 16;

  constructor(
    private readonly metrics: FanoutMetrics,
    private readonly onRemove: (room: Room, playerId: string, reason: string) => void,
  ) {}

  buildRecords(room: Room, players: Players, now: number): TickRecord[] {
    const records = this.scratchRecords;
    // Two clocks, two domains: `now` is wallNow (socket silence,
    // suppression windows, echo stamps); simT gates the sim-owned
    // fields (regen/dd/forceSendUntil, chargeT) which are all written
    // with simNow -- mixing them desyncs the moment simNow ≠ wall.
    const simT = simNow();
    this.sweepIntroPlayers(room, players);
    const bctx: BuildCtx = { recN: 0, roster: null, rosterDirty: false, introPending: room.introPlayers.size > 0 };
    for (const [playerId, p] of players) {
      const gate = this.recordGate(room, playerId, p, now, simT);
      if (gate === null) {continue;}
      this.writeSnapshot(playerId, p, gate, now);
      this.emitRecord(room, playerId, p, gate, records, bctx);
    }
    records.length = bctx.recN;
    if (bctx.rosterDirty) {room.connections.broadcast({ type: 'wireIds', add: bctx.roster! });}
    return records;
  }

  /** Age-sweep the intro windows -- a departed or settled seat must not
   *  keep forcing rec.full encodes forever. */
  private sweepIntroPlayers(room: Room, players: Players): void {
    for (const [pid, at] of room.introPlayers) {
      if (room.tickSeq - at >= 20 || !players.has(pid) && !room.spectators.has(pid)) {room.introPlayers.delete(pid);}
    }
  }

  /** Everything between "does this player get a record" and the wire
   *  encode: skip verdicts, the three server-owned echoes, the buff-bit
   *  merge, suppression, and the ensured lastSent snapshot. Returns
   *  null when the player contributes no record this tick. */
  private recordGate(room: Room, playerId: string, p: PlayerState, now: number, simT: number): RecGate | null {
    if (this.skipRecord(room, playerId, p, now)) {return null;}
    this.tickServerHeals(room, playerId, p, now, simT);
    this.tickChargeEcho(room, playerId, p, now, simT);
    this.tickAmmoEcho(room, playerId, p, now);
    // forceSendUntil is Wallms (hit-window bookkeeping, types.ts:105) --
    // comparing it to simT only coincides while both clocks read
    // Date.now(): a warped sim clock would never lapse the window and
    // a frozen one never engages it.
    const forceSend = wallNow() < p.forceSendUntil;
    const lastSent = room.lastSentPositions.get(playerId);
    const sheep = room.bots.sheepOf(playerId);
    // Buff bits are server-owned (stripped from client claims at
    // inputMove) so they must be OR-ed on here, not read off p.status.
    // The toggle bits ARE claim truth: a legit client drops CLOAK/
    // SHIELD/MEND the tick its tank empties, so a claim holding one
    // past the shadow's modeled dry point is a forged channel — mask
    // it off the wire copy (the record keeps the claim for refill).
    // Computed before suppression so a transition breaks the window.
    const tankDry = (room.moveSim.energyOf(playerId) ?? 1) <= 0;
    const claimed = tankDry ? p.status & ~(STATUS.CLOAK | STATUS.SHIELD | STATUS.MEND) : p.status;
    const wireStatus = claimed
      | (simT < p.regenUntil ? STATUS.REGEN : 0)
      | (simT < p.ddUntil ? STATUS.DD : 0)
      | (lgChargeAt(p.charge, p.chargeT, simT / 1000) > 0 ? STATUS.CHARGED : 0);
    // Wire-invisible cloak: the masked claim's CLOAK bit outside the
    // shoot-reveal window (lastFireSim is sim-ms domain, like simT)
    // means the record itself must not reach non-teammates — a hide
    // done only client-side still ships the position on the wire.
    const hidden = (claimed & STATUS.CLOAK) !== 0 && simT - p.lastFireSim >= SHOOT_REVEAL_S * 1000;
    if (lastSent && !forceSend && recordSuppressed(p, lastSent, now, sheep, wireStatus)) {
this.metrics.recordsSuppressed += 1;
      return null; // Skip -- within extrapolation tolerance
    }
    // Mutate the snapshot in place -- a fresh object per record per tick
    // was the last steady-state alloc in this loop.
    let snap = lastSent;
    if (!snap) {
      snap = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, hp: 0, dead: false, ski: 0, jet: 0, status: 0, sheep: 0, t: 0 };
      room.lastSentPositions.set(playerId, snap);
    }
    return { snap, forceSend, sheep, wireStatus, hidden };
  }

  /** The lastSent snapshot write + the egress chokepoint invariants:
   *  whatever the ingest gates missed shows up here before it reaches
   *  a client's decode pool. Snap fields ARE the wire. */
  private writeSnapshot(playerId: string, p: PlayerState, gate: RecGate, now: number): void {
    const { snap } = gate;
    // Egress chokepoint: whatever the ingest gates missed shows up here
    // before it reaches a client's decode pool. Snap fields ARE the wire.
    inv('wire-row-finite', Number.isFinite(
      p.position.x + p.position.y + p.position.z
      + p.velocity.x + p.velocity.y + p.velocity.z
      + p.rotation.yaw + p.rotation.pitch + p.health),
      () => ({ id: playerId, pos: p.position, hp: p.health }));
    // Coherence, not just representation: a row claiming alive at
    // hp<=0 is a lie even when every field is finite -- the dead
    // write pairs are atomic. (No upper bound: seeded/superbot pools
    // legitimately sit over class max.)
    inv('wire-row-coherent', p.isDead || p.health > 0,
      () => ({ id: playerId, hp: p.health, dead: p.isDead }));
    // Cross-field law: a dead row carries no channels and no held keys --
    // death strips all three at the kill edge, so a corpse claiming
    // cloak/jet/ski means a write path re-armed them post-mortem.
    inv('corpse-no-channels', !p.isDead || (p.status === 0 && p.skiing === 0 && p.jetting === 0),
      () => ({ id: playerId, status: p.status, ski: p.skiing, jet: p.jetting }));
    snap.x = p.position.x; snap.y = p.position.y; snap.z = p.position.z;
    snap.vx = p.velocity.x; snap.vy = p.velocity.y; snap.vz = p.velocity.z;
    snap.yaw = p.rotation.yaw; snap.pitch = p.rotation.pitch;
    snap.hp = p.health; snap.dead = p.isDead; snap.ski = p.skiing; snap.jet = p.jetting;
    snap.status = gate.wireStatus;
    snap.sheep = gate.sheep;
    snap.t = now;
  }

  /** The wire half: wireId mint/reuse, pooled record slot, delta-masked
   *  v4 encode, and the joiner side-channel full copy. recN and the
   *  roster accumulator live on bctx -- one per buildRecords call. */
  private emitRecord(room: Room, playerId: string, p: PlayerState, gate: RecGate, records: PooledRecord[], bctx: BuildCtx): void {
    let wireId = room.wireIds.get(playerId);
    let freshWireId = false;
    if (wireId === undefined) {
      wireId = mintWireId(room);
      room.wireIds.set(playerId, wireId);
      (bctx.roster ??= {})[wireId] = playerId;
      bctx.rosterDirty = true;
      freshWireId = true;
    }
    let rec = records[bctx.recN];
    if (!rec) {
      rec = { playerId: '', data: new Uint8Array(0), pos: { x: 0, y: 0, z: 0 }, force: false, enc: tickEncodeScratch() };
      records.push(rec);
    }
    rec.playerId = playerId;
    rec.pos = p.position;
    rec.wireId = wireId;
    // spd only feeds the >12 m/s travel-budget gate -- squared-compare
    // skips the hypot on everyone parked (Math.hypot is ~10x sqrt).
    const vsq = p.velocity.x * p.velocity.x + p.velocity.y * p.velocity.y + p.velocity.z * p.velocity.z;
    rec.spd = vsq > 144 ? Math.sqrt(vsq) : 0;
    // The delta basis is per-wireId and shared across recipients, but
    // fanout skips records per-recipient by distance tier -- a field the
    // far client never received stays stale in its decode pool FOREVER
    // (masked-out groups emit the retained slot value). A skipped full
    // would leave that drift unbounded, so forced fulls must bypass
    // tier skipping like hit-window forced sends.
    // introSeq window (tickNack reseed): EVERY client's basis may be
    // corrupt -- records go room-wide full for ~1s. Per-joiner fulls
    // ride rec.full below instead, so a fresh seat doesn't poison the
    // shared delta stream.
    const fullRecord = freshWireId || room.tickSeq - room.introSeq < 20
      || (room.tickSeq + wireId) % TickFanout.FULL_RECORD_EVERY === 0;
    rec.force = gate.forceSend || fullRecord;
    rec.hidden = gate.hidden;
    // Delta basis follows the wireId, never the slot -- a slot-carried
    // `last` encodes this player's mask against whoever held the slot
    // last tick after every roster shuffle.
    let last = room.v4Last.get(wireId);
    if (!last || freshWireId) {
      last = v4Last();
      room.v4Last.set(wireId, last);
    }
    // Delta-masked v4 record: field groups that changed since the
    // K-deep basis ride the wire -- a field changed once is resent
    // V4_BASIS_DEPTH times, healing short datagram bursts; a periodic
    // full record bounds whatever longer loss leaves behind.
    // Stagger fulls by wireId -- keying on tickSeq alone synced every
    // record into one egress spike per window; spreading them keeps
    // the same 750ms drift bound with a flat send curve. A fresh
    // mint always fulls: a quiet-window-reissued wireId's `last`
    // could still hold the retired owner's basis, and a masked
    // record would hand receivers the departed owner's hp/flags.
    const fields = this.scratchFields;
    fields.playerId = playerId;
    fields.position = p.position;
    fields.rotation = p.rotation;
    fields.velocity = p.velocity;
    fields.health = p.health;
    fields.isDead = p.isDead;
    // Only advertise a proven ping -- stale heartbeats above would
    // otherwise broadcast the default 0 for ghosts that never
    // reported (renders them with a bogus "0ms" ping).
    fields.ping = p.ping > 0 ? p.ping : undefined;
    fields.ski = p.skiing;
    fields.jet = p.jetting;
    fields.status = gate.snap.status;
    fields.sheep = gate.sheep;
    rec.data = encodeTickPlayerV4(wireId, fields, rec.enc, last, fullRecord);
    // Joiner side-channel: while any seat is in its intro window, a
    // second FULL copy rides rec.full -- the fanout swaps it in only
    // for recipients still lacking this wireId's decode basis.
    if (bctx.introPending) {
      rec.enc2 ??= tickEncodeScratch();
      rec.full = encodeTickPlayerV4(wireId, fields, rec.enc2, this.introLast, true);
    } else {rec.full = undefined;}
    bctx.recN += 1;
    this.metrics.recordsBuilt += 1;
  }

  /** Every reason a player contributes no record this tick, in order:
   *  grace entries (owned by their removal timeout -- reaping here would
   *  double playerLeft), idle reap (before the ghost check or unreported
   *  dead sockets linger forever), humans that never reported (menu/lobby --
   *  their record renders a frozen ghost at the spawn default; bots exempt
   *  since the sim writes their position), and the stale heartbeat --
   *  silent sockets get a 0.5Hz record so clients' stored state (health,
   *  isDead) still converges; gated on THAT player's lastSent, not a shared
   *  clock -- a shared timestamp meant only the first stale player in map
   *  order ever heartbeat. */
  private skipRecord(room: Room, playerId: string, p: PlayerState, now: number): boolean {
    if (room.sessions?.state(playerId) === 'grace') {return true;}
    // Held-off-spawn seat: invisible until its 'ready' lands; the hold
    // times out here so a client that died mid-veil can't ghost forever.
    if (p.awaitingReady) {
      if (now - p.awaitingReady.at > PlayerManager.READY_HOLD_MS) {room.releaseReady(playerId);}
      return true;
    }
    const silenceMs = now - p.lastSeen;
    // Idle reap FIRST: a menu-sitter's dead socket must still be collected
    // -- checking hasReceivedPosition before this left unreported ghosts
    // sitting in the roster forever.
    if (this.reapIdle(room, playerId, p, silenceMs)) {return true;}
    // Claim silence (pings don't count) flips the declared stale bit once —
    // remotes ghost the body while the server keeps owning liveness. Edge
    // fires on transition only; the roster field covers joiners.
    const stale = !p.isBot && p.lastClaimAt !== undefined && now - p.lastClaimAt > TickFanout.STALE_MS;
    if (stale !== (p.stale === true)) {
      p.stale = stale;
      room.broadcast({ type: 'playerStale', playerId, stale });
    }
    if (!p.isBot && !p.hasReceivedPosition) {return true;}
    const lastSent = room.lastSentPositions.get(playerId);
    return silenceMs > 5000 && lastSent !== undefined && now - lastSent.t < 2000;
  }

  /** Human silence past IDLE_KICK_MS gets reaped -- close the live socket
   *  (onClose runs the grace path) or remove directly when it's already
   *  dead. Returns true when the player was reaped. */
  private reapIdle(room: Room, playerId: string, p: PlayerState, silenceMs: number): boolean {
    if (p.isBot || silenceMs <= TickFanout.IDLE_KICK_MS) {return false;}
    const ws = room.socketOf(playerId);
    if (ws && ws.readyState === 1) {
      ws.close(1000, 'idle'); // triggers onClose → grace cleanup
    } else {
      this.onRemove(room, playerId, 'idle');
    }
    logger.info('Idle player removed', { playerId, silenceMs });
this.metrics.recordsIdleReaped += 1;
    return true;
  }

  /** Health channels the server owns: medkit channel (flag), regenerator
   *  perk (passive), regen powerup (timed). All cap at the perk max.
   *  Server-owned heals never reach the owner -- self is excluded from
   *  tickUpdate -- so a low-rate yourHealth echo keeps their hp from
   *  drifting until the next discrete event. */
  private tickServerHeals(room: Room, playerId: string, p: PlayerState, now: number, simT: number): void {
    let heal = healPerTick(p, simT); // regenUntil is sim domain
    // Headhunt hoard-drip: held tokens trickle hp/armor/belt, but only
    // 8s+ after the last hit -- HELD_BUFF.graceMs keeps it sustain, not
    // tanking. Belt accumulates fractionally until a charge lands.
    const hb = heldBuffRates(p.heldTokens, simT - p.lastDamageAt);
    heal += hb.hp / CONFIG.tickRate;
    if (hb.armor > 0) {p.armor = Math.min(POWERUP.maxArmor, p.armor + hb.armor / CONFIG.tickRate);}
    if (hb.belt > 0 && p.beltCharges < BELT_MAX) {
      p.beltAcc += hb.belt / CONFIG.tickRate;
      if (p.beltAcc >= 1) {
        const n = Math.min(BELT_MAX - p.beltCharges, Math.floor(p.beltAcc));
        p.beltCharges += n;
        p.beltAcc -= n;
      }
    }
    if (heal <= 0 && hb.armor <= 0) {return;}
    healPool(p, heal);
    // Capping out always echoes -- the channel ends here, so the final
    // converged hp would otherwise wait on the next discrete event.
    // Armor rides free: remote armor already ships via sim records, the
    // carrier is the one replica that can't see itself.
    if (now - p.healthEchoAt >= 500 || p.health >= p.maxHealth) {
      p.healthEchoAt = wallMs(now);
      room.connections.sendToPlayer(playerId, { type: 'yourHealth', health: p.health, armor: p.armor });
    }
  }

  /** Pool ammo echo: the client predicts spends, so a rejected intent or
   *  an accrual-epoch difference leaves its pool ~1 low. While any pool
   *  sits below cap, echo the post-accrual counts at the healthEcho
   *  cadence - self-converging, and silent once the clip refills. */
  private tickAmmoEcho(room: Room, playerId: string, p: PlayerState, now: number): void {
    // Humans only: bot pools accrue on the arsenal sim clock - a wall-clock
    // accrual stamp here would freeze their regen (and bots have no socket).
    if (p.isBot || p.ammoPool.size === 0 || now - p.ammoEchoAt < 500) {return;}
    const rows: [number, number][] = [];
    let belowCap = false;
    for (const [wt] of p.ammoPool) {
      const n = ammoOf(p.ammoPool, wt, now / 1000)!; // cells only exist for capped weapons
      rows.push([wt, n]);
      if (n < (WEAPONS[wt]?.ammoCap ?? 0) - 0.01) {belowCap = true;}
    }
    if (!belowCap) {return;}
    p.ammoEchoAt = wallMs(now);
    room.connections.sendToPlayer(playerId, { type: 'yourAmmo', ammo: rows });
  }

  /** The carrier is the one client that can't see the CHARGED status bit
   *  (own records are excluded from fanout) -- echo their decayed bank at
   *  0.5Hz so a walking bomb can hear itself crackle. A final 0 lands the
   *  moment the bank drains so the warning doesn't linger. */
  private tickChargeEcho(room: Room, playerId: string, p: PlayerState, now: number, simT: number): void {
    const acc = lgChargeAt(p.charge, p.chargeT, simT / 1000); // chargeT is sim domain
    const live = acc > 0.5;
    if (!live && p.chargeEchoed <= 0) {return;}
    if (live && now - p.chargeEchoAt < 500) {return;}
    p.chargeEchoAt = wallMs(now);
    p.chargeEchoed = live ? acc : 0;
    room.connections.sendToPlayer(playerId, { type: 'yourCharge', charge: p.chargeEchoed });
  }

  /** Admit up to ADMIT_PER_TICK pending seats to one conn -- the same
   *  playerJoined payload a mid-match join broadcasts, sent direct. */
  private drainAdmits(room: Room, recipientId: string, pending: Set<string>): void {
    let n = TickFanout.ADMIT_PER_TICK;
    const roster = room.players.getAllPlayers();
    const rt = room.players.getPlayer(recipientId)?.team;
    for (const pid of pending) {
      const p = roster.get(pid);
      pending.delete(pid);
      if (!p) {continue;} // left mid-pacing -- drop silently
      // A cloaked seat stays queued: the admit wire position is the same
      // leak announceIfInWorld already gates. Retries each fanout tick;
      // the row lands on the first uncloaked drain.
      if (room.cloakHiddenOf(pid) && (rt === undefined || rt !== p.team)) {pending.add(pid); continue;}
      room.connections.sendToPlayer(recipientId, spawnPayload(WORLD_MODEL.player!, p.id, 'playerId', {
        name: p.name,
        internalId: p.internalId,
        position: p.position,
        rotation: p.rotation,
        team: p.team,
        transport: ConnectionManager.udpLive?.(p.id) ? `${p.transport ?? 'ws'}+udp` : p.transport,
        armorClass: p.armorClass,
        weapon: p.weapon,
        health: p.health,
        isDead: p.isDead,
      }) as ServerMessage);
      if ((n -= 1) <= 0) {break;}
    }
    if (pending.size === 0) {room.admitPending.delete(recipientId);}
  }

  /** Interest management: distance-tiered update rate per recipient.
   *  <150m (engagement range) every tick · <400m half rate · beyond 1/4.
   *  Hits/kills travel on reliable events, so stale far ghosts only lose
   *  smoothness on targets that are visually specks anyway. */
  fanoutRecords(room: Room, players: Players, records: TickRecord[]): void {
    const seq = room.tickSeq;
    this.bucketRecords(records);
    for (const [recipientId, rp] of players) {
      this.fanoutRecipient(room, players, recipientId, rp, seq);
    }
    // tierMem is keyed by live recipients -- a departed player's map
    // would otherwise linger (and a rejoiner gets a fresh one anyway).
    for (const rid of this.tierMem.keys()) {if (!players.has(rid)) {this.tierMem.delete(rid);}}
    this.fanoutSpectators(room, seq, records);
  }

  /** Replication-Graph move: the roster is pre-bucketed into cells +
   *  an every-tick list once -- each recipient then distance-tests
   *  only its own engagement circle instead of the whole roster. The
   *  far-sparse tier could only ever emit on seq%8 anyway; instead of
   *  one N^2 sweep on that tick, each recipient emits far-cell records
   *  on its own staggered 8th-tick phase (same cadence, no spike). */
  private bucketRecords(records: TickRecord[]): void {
    for (const c of this.cells.values()) {c.length = 0;}
    this.fastRecords.length = 0;
    for (const r of records) {
      // Only forced records bypass the cells: they emit regardless
      // of the cap, so their eval can't be early-outed. Fast movers
      // bucket normally -- the speedTier logic in the eval body
      // preserves their cadence wherever they actually earn a slot.
      if (r.force) {this.fastRecords.push(r); continue;}
      const key = this.cellKey(r.pos.x, r.pos.z);
      let bucket = this.cells.get(key);
      if (!bucket) {bucket = []; this.cells.set(key, bucket);}
      bucket.push(r);
    }
  }

  /** One recipient's share of the tick: gather its candidate set,
   *  eval tiers, cap, encode, send. Grace seats and socketless bots
   *  return before any record work -- bots are seats, not clients:
   *  no socket ever drains a frame, so encoding one per bot was pure
   *  waste (a 1-human/11-bot room read ~12x its real egress). */
  private fanoutRecipient(room: Room, players: Players, recipientId: string, rp: PlayerState, seq: number): void {
    // Grace-period entries have no socket -- record filtering for them
    // is wasted work
    if (room.sessions?.state(recipientId) === 'grace') {return;}
    const sock = room.socketOf(recipientId);
    if (!sock || sock.readyState !== 1) {return;}
    const c = this.rctx;
    c.room = room; c.players = players; c.recipientId = recipientId; c.rp = rp; c.seq = seq;
    c.rx = rp.position.x; c.ry = rp.position.y; c.rz = rp.position.z;
    let tiers = this.tierMem.get(recipientId);
    if (!tiers) {tiers = new Map(); this.tierMem.set(recipientId, tiers);}
    c.tiers = tiers;
    // Intro recipients decode from zero -- they get the per-socket FULL
    // copy of every record at full cadence for the window.
    c.intro = room.introPlayers.has(recipientId);
    // markIntro stamps at the seat's tickSeq -- delta <= N covers the
    // first N fanout ticks after the mark.
    c.introFull = c.intro && seq - (room.introPlayers.get(recipientId) ?? -100) <= TickFanout.INTRO_CADENCE_TICKS;
    // Spawn pacing: admit a few pending seats per tick -- a paced admit
    // rides an ordinary playerJoined on the wire; nothing says it waited.
    c.tScan = process.hrtime.bigint();
    // Free check when no seats are pacing: one map.size read per tick
    // instead of a per-recipient get.
    const pending = room.admitPending.size > 0 ? room.admitPending.get(recipientId) : undefined;
    c.pending = pending;
    if (pending) {this.drainAdmits(room, recipientId, pending);}
    // Who's actively shooting this recipient — refreshed per fanout
    // so a new attacker wins the cap the same tick it engages.
    c.engaged = room.engagementOf(recipientId);
    // Strained conns get a halved cap — a link already shedding frames
    // pays half the encode work and egress, so it sheds even less.
    c.recCap = room.connections.isStrained(recipientId) ? TickFanout.STRAIN_RECORDS : TickFanout.MAX_RECORDS;
    this.scratchOthers.length = 0;
    this.gatherCandidates(c);
    this.emitFarCells(c);
    this.evalCandidates(c);
    this.capSendFrame(c);
  }

  /** Candidate set: cells whose center overlaps the ~950m engagement
   *  circle (covers 600m outer tier x hysteresis + half-diagonal)
   *  plus every fast/forced mover. The box is a center-distance test,
   *  not a square span -- corner cells on a 2km map held a third of
   *  the roster. */
  private gatherCandidates(c: RcpCtx): void {
    const list = this.candList;
    const listMin = this.candListMin;
    list.length = 0; listMin.length = 0;
    // Forced records eval first, unconditionally -- they emit
    // regardless of the cap (hit-window + staggered-full truth).
    for (const r of this.fastRecords) {list.push(r); listMin.push(0);}
    const nearKeys = this.nearCellKeys;
    nearKeys.clear();
    const ckeys = this.cellKeys;
    const cmins = this.cellMinSq;
    ckeys.length = 0; cmins.length = 0;
    const ccx = Math.floor(c.rx / TickFanout.CELL);
    const ccz = Math.floor(c.rz / TickFanout.CELL);
    const SPAN = TickFanout.CELL_SPAN;
    for (let cx = ccx - SPAN; cx <= ccx + SPAN; cx += 1) {
      for (let cz = ccz - SPAN; cz <= ccz + SPAN; cz += 1) {
        const dxc = (cx + 0.5) * TickFanout.CELL - c.rx;
        const dzc = (cz + 0.5) * TickFanout.CELL - c.rz;
        if (dxc * dxc + dzc * dzc > TickFanout.NEAR_CELL_SQ) {continue;}
        // Nearest-corner distance -- the early-out bound needs a
        // true lower bound on any record inside, center is not one.
        const nx = Math.max(0, Math.abs(dxc) - TickFanout.CELL / 2);
        const nz = Math.max(0, Math.abs(dzc) - TickFanout.CELL / 2);
        const key = (cx + 4096) * 8192 + cz + 4096;
        nearKeys.add(key);
        ckeys.push(key);
        cmins.push(nx * nx + nz * nz);
      }
    }
    // Nearest-cell-first (~25 entries -- insertion sort beats a sort
    // call's overhead): lets the cap cutoff early-out far cells the
    // moment the pool can't be beaten even under the cone boost.
    for (let i = 1; i < cmins.length; i += 1) {
      const k = ckeys[i]!, m = cmins[i]!;
      let j = i - 1;
      while (j >= 0 && cmins[j]! > m) {ckeys[j + 1] = ckeys[j]!; cmins[j + 1] = cmins[j]!; j -= 1;}
      ckeys[j + 1] = k; cmins[j + 1] = m;
    }
    for (let i = 0; i < ckeys.length; i += 1) {
      const bucket = this.cells.get(ckeys[i]!);
      if (bucket !== undefined) {for (const r of bucket) {list.push(r); listMin.push(cmins[i]!);}}
    }
  }

  /** Staggered far emit (tier-8 cadence, per-recipient phase): cells
   *  wholly outside the near circle emit sparse records straight to
   *  the cap pool -- the cell boundary already proves far-ness, so
   *  no dSq, no tier math. Stopped far records emit nothing, same
   *  rule as before. */
  private emitFarCells(c: RcpCtx): void {
    if ((c.seq + staggerOf(c.recipientId)) % 8 !== 0) {return;}
    for (const [key, bucket] of this.cells) {
      if (this.nearCellKeys.has(key)) {continue;}
      for (const r of bucket) {
        if (r.playerId === c.recipientId || c.pending?.has(r.playerId)) {continue;}
        if (this.recordHidden(c, r)) {continue;}
        if ((r.spd ?? 0) <= 12) {
          this.metrics.recordsTierSkipped += 1;
          this.metrics.recordsStopped += 1;
          continue;
        }
        this.candRecs.push(this.sparseVariant(r, c.seq));
        this.candScore.push(c.engaged?.get(r.playerId!) === undefined ? TickFanout.FAR_SCORE : TickFanout.FAR_SCORE * TickFanout.ENGAGE_BOOST);
      }
    }
  }

  /** Cutoff-bounded eval (Halo fill-until-budget on the scan itself):
   *  once the cap pool holds 32, candidates whose cell's nearest
   *  corner can't beat the cutoff -- even at the cone boost -- lose
   *  by construction, so their eval is provably wasted work. */
  private evalCandidates(c: RcpCtx): void {
    const list = this.candList;
    const listMin = this.candListMin;
    let scanCut = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      if (this.candRecs.length >= c.recCap) {
        // First-pool cutoff is final forever: better candidates only
        // shrink the 32nd score, so this is a permanent upper bound --
        // anything skipped couldn't have won the cap either way.
        if (scanCut === Infinity) {scanCut = kthSmallest(this.candScore, c.recCap);}
        if (listMin[i]! * TickFanout.CONE_BOOST > scanCut) {break;}
      }
      this.evalRecord(c, list[i]!);
    }
  }

  /** One candidate's tier eval: lazy cadence gate, distance tier +
   *  hysteresis + travel-budget clamp, then variant pick + scored-cap
   *  push (forced records bypass the cap straight into `others`). */
  private evalRecord(c: RcpCtx, r: TickRecord): void {
    this.metrics.recordsScanned += 1;
    if (r.playerId === c.recipientId) {return;}
    // Un-admitted seats don't exist for this conn yet -- their records
    // wait for the paced playerJoined (their hit/kill EDGES still ride
    // the reliable broadcast; a damage event is never admission-gated).
    if (c.pending?.has(r.playerId)) {return;}
    if (this.recordHidden(c, r)) {return;}
    const dx = r.pos.x - c.rx;
    const dy = r.pos.y - c.ry;
    const dz = r.pos.z - c.rz;
    const dSq = dx * dx + dy * dy + dz * dz;
    // Lazy eval: the effective emit cadence (distance tier min the
    // speed bump) gates the expensive part -- off-tick candidates
    // that CANNOT have upgraded skip tier+hysteresis entirely.
    // dSq stays cheap-every-tick so an inward crossing is still
    // discovered instantly; the bound keys on the distance tier.
    const mem = c.tiers.get(r.wireId ?? -1);
    const spd = r.spd ?? 0;
    let emitEvery = mem ?? 1;
    if (spd > 12) {
      const st = Math.max(1, Math.floor((5 / spd) / 0.05));
      if (st < emitEvery) {emitEvery = st;}
    }
    if (!c.introFull && !r.force && c.seq % emitEvery !== 0 && dSq >= this.lazyBound(mem)) {
      this.metrics.recordsTierSkipped += 1;
      return;
    }
    const e = this.evg;
    e.dSq = dSq; e.dx = dx; e.dz = dz; e.mem = mem; e.spd = spd;
    this.emitEval(c, r, e);
  }

  /** The emit half of evalRecord: tier resolution, emit-tick gate,
   *  stop-tier verdict, variant pick, then force-bypass or scored
   *  cap push. Split from the gate head so each stays readable. */
  private emitEval(c: RcpCtx, r: TickRecord, e: EvalGeom): void {
    const tier = this.recordTier(c, r, e.dSq, e.mem, e.spd);
    if (!(c.introFull || r.force || c.seq % tier === 0)) {this.metrics.recordsTierSkipped += 1; return;}
    // Stopped (far AND under ~12m/s): zero replication -- the
    // receiver dead-reckons a ~0-vel ghost either way, so every
    // sparse record was paying wire cost for no new truth. The
    // staggered FULLS keep flowing through r.force below, so the
    // conn's decode basis still reseats every ~750ms -- an un-stop
    // needs nothing: the next masked delta decodes against a
    // fresh basis. Nothing on the wire says a record stopped.
    if (tier === 8 && !r.force && !c.intro && e.spd <= 12) {
      this.metrics.recordsTierSkipped += 1;
      this.metrics.recordsStopped += 1;
      return;
    }
    const variant = this.recordVariant(r, tier, c.intro, c.seq);
    // Forced traffic emits directly; everything else competes for
    // the scored cap below (intro seats included -- an intro seat
    // needs full VARIANTS of the K it gets, not the whole roster
    // at once; join bursts were shipping ~300-record frames).
    if (r.force) {this.scratchOthers.push(variant); return;}
    this.candRecs.push(variant);
    this.candScore.push(this.recordScore(c, r, e.dSq, e.dx, e.dz));
  }

  /** Distance tier + hysteresis + travel-budget clamp for one
   *  candidate. Writes the tier memory only on change -- an
   *  unconditional set was a churn write per recipient×record×tick
   *  in the cpuprofile hot loop. */
  private recordTier(c: RcpCtx, r: TickRecord, dSq: number, mem: number | undefined, spd: number): number {
    // Tier 4 (200ms spacing) read as mini-warps even through the
    // interpolation buffer -- a skiing bot covers ~8m between records.
    // 150ms is the worst a body ever gets; hits/kills ride reliable
    // events either way.
    // Egress is quadratic in roster -- the far-field past 600m is a
    // speck on screen, so it earns a record only every 8th tick while
    // the 400-600m band keeps the 150ms worst-case cadence.
    let tier = 8;
if (dSq < 22_500) {tier = 1;}
else if (dSq < 160_000) {tier = 2;}
else if (dSq < 360_000) {tier = 3;} // 150m / 400m / 600m
    // Hysteresis: stepping OUT a tier requires 15% past the
    // boundary -- a target orbiting the line would otherwise flip
    // send cadence every tick and the receiver's arrival-interval
    // EMA oscillates instead of settling.
    if (mem !== undefined && tier > mem) {
      const bound = this.hystBound(mem);
      if (dSq < bound * 1.15) {tier = mem;}
    }
    // Map write only on change -- an unconditional set was a churn
    // write per recipient×record×tick in the cpuprofile hot loop.
    if (mem !== tier) {c.tiers.set(r.wireId ?? -1, tier);}
    // Travel-budget tier (ephemeral -- sits AFTER hysteresis so a
    // slowed bot falls back to its distance tier immediately): no
    // remote may cover >5m between records. At ~50ms/tick that's
    // spd-dependent: 60m/s → every tick, 30m/s → tier 2, 20m/s →
    // tier 4, <12m/s → distance tier wins. Measured against the
    // record's own speed, not a guessed constant -- the dual-diff
    // showed 24m/gap ghosts on 2.5Hz far tiers, and the client
    // can't render truth inside a gap that big by any technique.
    if (spd > 12) {
      const speedTier = Math.max(1, Math.floor((5 / spd) / 0.05));
      if (speedTier < tier) {tier = speedTier;}
    }
    return tier;
  }

  /** The wire variant for an emitting record: far tier (>600m, 2.5Hz)
   *  gets pos+vitals only -- the speck dead-reckons its retained
   *  vel/rot and the staggered fulls reseat it every ~750ms. ~40% off
   *  the dominant egress class. Intro seats get the full copy when
   *  one exists. */
  private recordVariant(r: TickRecord, tier: number, intro: boolean, seq: number): Uint8Array {
    if (tier === 8 && !r.force && !intro) {return this.sparseVariant(r, seq);}
    return intro && r.full !== undefined ? r.full : r.data;
  }

  /** Cloaked-target gate shared by the far emit and the near eval:
   *  cloaked targets don't exist for non-teammates -- FFA (no team)
   *  counts every other seat as hostile. Teammates still get the
   *  record so their client can render the ghost shimmer. */
  private recordHidden(c: RcpCtx, r: TickRecord): boolean {
    return r.hidden === true && (c.rp.team === undefined || c.rp.team !== c.players.get(r.playerId)?.team);
  }

  /** The far-tier sparse copy, cut once per tick per record -- pooled
   *  slots carry the encode scratch; sparseTick keys validity because
   *  rec.data re-encodes every tick. */
  private sparseVariant(r: TickRecord, seq: number): Uint8Array {
    if (r.sparseTick !== seq) {
      const pr = r as PooledRecord;
      pr.encSparse ??= tickEncodeScratch();
      r.sparse = sparseV4Record(r.data, pr.encSparse);
      r.sparseTick = seq;
    }
    return r.sparse!;
  }

  /** dSq bound for the lazy cadence gate, keyed on the last tier the
   *  recipient saw this record at -- far memories demand more distance
   *  before an off-cadence eval is even worth running. */
  private lazyBound(mem: number | undefined): number {
    if (mem === 2) {return 22_500;}
    if (mem === 3) {return 160_000;}
    return mem === 8 || mem === undefined ? 360_000 : 0;
  }

  /** dSq bound for tier hysteresis -- stepping OUT a tier requires 15%
   *  past the boundary so an orbiting target can't flap send cadence. */
  private hystBound(mem: number): number {
    if (mem === 1) {return 22_500;}
    if (mem === 2) {return 160_000;}
    return 360_000;
  }

  /** Engagement score: nearer wins, but a record inside the
   *  recipient's +-45deg aim sector fights at CONE_BOOST x
   *  its distance -- a 500m target in your sights outranks
   *  bystanders (the 500m-engagement rule; cull least-relevant,
   *  not farthest). Mutual engagement: a player shooting at me
   *  outranks every bystander — the shooter-first cap contract.
   *  Score drops to ~2% of distance so only another engaged
   *  record competes. */
  private recordScore(c: RcpCtx, r: TickRecord, dSq: number, dx: number, dz: number): number {
    let score = dSq;
    if (dSq > 22_500) {
      let d = Math.atan2(dx, dz) - c.rp.rotation.yaw;
      if (d > Math.PI) {d -= 2 * Math.PI;} else if (d < -Math.PI) {d += 2 * Math.PI;}
      if (d < TickFanout.CONE_HALF && d > -TickFanout.CONE_HALF) {score *= TickFanout.CONE_BOOST;}
    }
    if (c.engaged?.get(r.playerId!) !== undefined) {score *= TickFanout.ENGAGE_BOOST;}
    return score;
  }

  /** Scored cap + frame encode + send for one recipient. Always sends
   *  -- even an empty frame: the client's loss telemetry keys on
   *  tick-frame ARRIVAL cadence (a silent link reads as 100% loss),
   *  and ackSeq rides this frame: a quiet room would starve
   *  stateHistory pruning entirely. ~10B × 20Hz is free. */
  private capSendFrame(c: RcpCtx): void {
    // Scored cap: bound each recipient's frame at MAX_RECORDS.
    // A quickselect pass finds the cutoff score; ties at the edge
    // stop at the cap itself so the bound is exact.
    if (this.candRecs.length > c.recCap) {
      const cutoff = kthSmallest(this.candScore, c.recCap);
      let kept = 0;
      for (let i = 0; i < this.candRecs.length && kept < c.recCap; i += 1) {
        if (this.candScore[i]! <= cutoff) {this.scratchOthers.push(this.candRecs[i]!); kept += 1;}
      }
      this.metrics.recordsCapped += this.candRecs.length - kept;
    } else {
      for (const v of this.candRecs) {this.scratchOthers.push(v);}
    }
    this.candRecs.length = 0; this.candScore.length = 0;
    const tFrame = process.hrtime.bigint();
    const frame = encodeTickFrame(
      c.room.players.getLastSeq(c.recipientId),
      c.seq,
      // Tick-set confirm: highest inputMove seq the shadow consumed --
      // the client prunes its input journal and sees a starving stream.
      c.room.moveSim.inputSeqOf(c.recipientId),
      this.scratchOthers,
      WIRE_TICK_V4,
      // Per-conn arena -- the queued view survives until flush; a shared
      // one aliases every queued frame to the last-encoded.
      c.room.connections.frameArenaFor(c.recipientId),
    );
    // Dropped frames surface as tickSeq gaps client-side -- count them
    // here so a consumer that can't drain reads as rising loss, not
    // as an unexplained stutter nobody can attribute.
    // Dev-only WAN-loss repro (FPS_DROP_PCT): dropping whole frames is
    // exactly what cadence loss looks like to a receiver -- interp
    // starves, DR episodes run long, tickSeq gaps surface as loss.
    // Not sim code, so Math.random is fine; soaks set it on the spawn.
    if (DROP_PCT > 0 && Math.random() * 100 < DROP_PCT) {return;}
    const st = c.room.connections.sendBinaryToPlayer(c.recipientId, frame);
    // Count only frames that actually left. 'held' is the intro gate
    // (reported separately, never sent), 'backlogged' is a shed, and a
    // 'gone' recipient must not pad the egress metric.
    if (st === 'sent' || st === 'sparse') {
      this.metrics.recordsSent += this.scratchOthers.length;
      this.metrics.bytesSent += frame.byteLength;
    }
    if (st === 'backlogged') {this.metrics.tickFramesDropped += 1;}
    else if (st === 'held') {this.metrics.tickFramesHeld += 1;}
    this.metrics.scanNs += Number(tFrame - c.tScan);
    this.metrics.frameNs += Number(process.hrtime.bigint() - tFrame);
  }

  /** Spectators have no viewpoint for interest tiers -- they get the
   *  full record set every tick. */
  private fanoutSpectators(room: Room, seq: number, records: TickRecord[]): void {
    if (room.spectators.size === 0) {return;}
    // Shared scratch like the player path -- a fresh map() per spectator
    // per tick was the only allocation left in fanout.
    const all = this.scratchOthers;
    all.length = 0;
    for (const r of records) {all.push(r.data);}
    // `all` is shared scratch -- track which variant it currently holds
    // so mixed intro/established spectator rosters each get their copy.
    let allFulls = false;
    for (const id of room.spectators) {
      // Same per-recipient intro contract as players -- a fresh spectator
      // decodes from zero and needs the full copies for the window.
      const intro = room.introPlayers.has(id);
      if (intro !== allFulls) {
        all.length = 0;
        for (const r of records) {all.push(intro && r.full !== undefined ? r.full : r.data);}
        allFulls = intro;
      }
      // Same ackSeq contract as player frames -- a spectator who spawns
      // mid-session must not carry a synthetic seq into history pruning.
      const frame = encodeTickFrame(room.players.getLastSeq(id), seq, room.moveSim.inputSeqOf(id), all, WIRE_TICK_V4, room.connections.frameArenaFor(id));
      this.metrics.bytesSent += frame.byteLength;
      room.connections.sendBinaryToPlayer(id, frame);
    }
  }
}
